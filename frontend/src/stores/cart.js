import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import api from '@/services/api';
import { fixedNum } from '@/composables/utils';
import { watchAuthUser } from './storeUtils';
import { useAuthStore } from './auth';

export const useCartStore = defineStore('cart', () => {
    const cart    = ref(null);   // { cart_no, status, items: [...] } | null
    const loading = ref(false);
    const error   = ref('');

    // ── Computed ──────────────────────────────────────────────────────────────

    const itemCount = computed(() => cart.value?.items?.length ?? 0);

    const total = computed(() => {
        if (!cart.value?.items?.length) return 0;
        return cart.value.items.reduce((sum, i) => sum + (Number(i.unit_price) || 0) * Number(i.qty), 0);
    });

    const totalDisplay = computed(() =>
        itemCount.value ? `$ ${fixedNum(total.value, 2)}` : '—');

    // ── Actions ───────────────────────────────────────────────────────────────

    async function fetchCart() {
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

    async function addItem(variantNo, qty) {
        error.value = '';
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
        try {
            const res = await api.delete(`/api/v1/cart/items/${variantNo}`);
            cart.value = res.data.content.cart;
        } catch (err) {
            error.value = err.response?.data?.outcome?.message || 'Failed to remove item';
            throw err;
        }
    }

    function reset() {
        cart.value  = null;
        error.value = '';
    }

    // Shoppers have a personal cart; staff do not.
    const auth = useAuthStore();
    watchAuthUser(
        () => { if (!auth.isStaff()) fetchCart().catch(() => {}); },
        reset,
    );

    return {
        cart, loading, error,
        itemCount, total, totalDisplay,
        fetchCart, addItem, updateItemQty, removeItem, reset,
    };
});
