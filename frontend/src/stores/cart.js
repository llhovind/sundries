import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import api from '@/services/api';
import { fixedNum } from '@/composables/utils';
import { watchAuthUser } from './storeUtils';
import { useAuthStore } from './auth';

/**
 * Cart store with two backing modes sharing one item shape:
 *  - logged-in shopper → server cart (/api/v1/cart)
 *  - anonymous guest   → local cart persisted in localStorage
 * On login the guest cart is merged into the server cart line by line, then
 * cleared, so nothing in the basket is lost by signing in.
 */

const GUEST_CART_STORAGE_KEY = 'guest-cart-v1';

function readGuestCart() {
    try {
        const raw = localStorage.getItem(GUEST_CART_STORAGE_KEY);
        const items = raw ? JSON.parse(raw) : [];
        return Array.isArray(items) ? items : [];
    } catch {
        return [];   // corrupted storage — start from an empty basket
    }
}

function writeGuestCart(items) {
    try {
        if (items.length) localStorage.setItem(GUEST_CART_STORAGE_KEY, JSON.stringify(items));
        else localStorage.removeItem(GUEST_CART_STORAGE_KEY);
    } catch { /* storage unavailable (private mode) — cart lives in memory only */ }
}

export const useCartStore = defineStore('cart', () => {
    const cart    = ref(null);   // { cart_no, status, items: [...] } | null
    const loading = ref(false);
    const error   = ref('');

    const auth = useAuthStore();
    const isGuest = () => !auth.isLoggedIn();

    // ── Computed ──────────────────────────────────────────────────────────────

    const itemCount = computed(() => cart.value?.items?.length ?? 0);

    const total = computed(() => {
        if (!cart.value?.items?.length) return 0;
        return cart.value.items.reduce((sum, i) => sum + (Number(i.unit_price) || 0) * Number(i.qty), 0);
    });

    const totalDisplay = computed(() =>
        itemCount.value ? `$ ${fixedNum(total.value, 2)}` : '—');

    // ── Guest (local) cart ────────────────────────────────────────────────────

    function loadGuestCart() {
        cart.value = { cart_no: null, status: 'guest', items: readGuestCart() };
    }

    function persistGuestCart() {
        writeGuestCart(cart.value?.items ?? []);
    }

    /**
     * @param {number} variantNo
     * @param {number} qty
     * @param {object} meta - variant display data captured at add time:
     *                        { name, sku, unit_price, sell_method, base_uom, min_cut_qty }
     */
    function addGuestItem(variantNo, qty, meta) {
        if (!meta) {
            error.value = 'Failed to add item';
            throw new Error('Guest cart lines need variant details');
        }
        const items = cart.value?.items ?? [];
        const line  = items.find(i => Number(i.variant_no) === Number(variantNo));
        if (line) {
            line.qty = Number(line.qty) + Number(qty);
        } else {
            items.push({
                id: `guest-${variantNo}`,
                variant_no: variantNo,
                qty: Number(qty),
                current_price: meta.unit_price,   // same price at add time by definition
                ...meta,
            });
        }
        cart.value = { cart_no: null, status: 'guest', items };
        persistGuestCart();
    }

    function updateGuestItemQty(variantNo, qty) {
        const line = cart.value?.items?.find(i => Number(i.variant_no) === Number(variantNo));
        if (!line) return;
        line.qty = Number(qty);
        persistGuestCart();
    }

    function removeGuestItem(variantNo) {
        if (!cart.value?.items) return;
        cart.value.items = cart.value.items.filter(i => Number(i.variant_no) !== Number(variantNo));
        persistGuestCart();
    }

    /**
     * Push guest lines into the freshly authenticated user's server cart.
     * Lines the server rejects (variant retired since it was added) are
     * dropped rather than blocking login.
     */
    async function mergeGuestCartIntoServer() {
        const items = readGuestCart();
        if (!items.length) return;
        for (const item of items) {
            try {
                await api.post('/api/v1/cart/items', { variant_no: item.variant_no, qty: item.qty });
            } catch { /* line no longer purchasable — drop it */ }
        }
        writeGuestCart([]);
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    async function fetchCart() {
        if (isGuest()) {
            loadGuestCart();
            return;
        }
        loading.value = true;
        error.value   = '';
        try {
            const res = await api.get('/api/v1/cart');
            cart.value = res.data.content.cart;
        } catch (err) {
            error.value = err.response?.data?.outcome?.message || 'Failed to load cart';
        } finally {
            loading.value = false;
        }
    }

    async function addItem(variantNo, qty, meta = null) {
        error.value = '';
        if (isGuest()) return addGuestItem(variantNo, qty, meta);
        try {
            const res = await api.post('/api/v1/cart/items', { variant_no: variantNo, qty });
            cart.value = res.data.content.cart;
        } catch (err) {
            error.value = err.response?.data?.outcome?.message || 'Failed to add item';
            throw err;
        }
    }

    async function updateItemQty(variantNo, qty) {
        error.value = '';
        if (isGuest()) return updateGuestItemQty(variantNo, qty);
        try {
            const res = await api.put(`/api/v1/cart/items/${variantNo}`, { qty });
            cart.value = res.data.content.cart;
        } catch (err) {
            error.value = err.response?.data?.outcome?.message || 'Failed to update item';
            throw err;
        }
    }

    async function removeItem(variantNo) {
        error.value = '';
        if (isGuest()) return removeGuestItem(variantNo);
        try {
            const res = await api.delete(`/api/v1/cart/items/${variantNo}`);
            cart.value = res.data.content.cart;
        } catch (err) {
            error.value = err.response?.data?.outcome?.message || 'Failed to remove item';
            throw err;
        }
    }

    /** Empty the guest basket (after a successful guest checkout). */
    function clearGuestCart() {
        writeGuestCart([]);
        loadGuestCart();
    }

    function reset() {
        cart.value  = null;
        error.value = '';
    }

    // Shoppers have a personal cart; staff do not. Anonymous visitors get the
    // local guest cart; when they log in it merges into their server cart.
    watchAuthUser(
        async () => {
            if (auth.isStaff()) return;
            await mergeGuestCartIntoServer();
            fetchCart().catch(() => {});
        },
        () => { reset(); loadGuestCart(); },
    );

    return {
        cart, loading, error,
        itemCount, total, totalDisplay,
        fetchCart, addItem, updateItemQty, removeItem, reset,
        isGuest, clearGuestCart,
    };
});
