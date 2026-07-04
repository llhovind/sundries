<script setup>
import { ref, reactive, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import api from '@/services/api';
import { fixedNum } from '@/composables/utils';
import { useCartStore } from '@/stores/cart';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const cart   = useCartStore();
const auth   = useAuthStore();

const isGuest    = computed(() => !auth.isLoggedIn());
const guestEmail = ref('');
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const step      = ref('details');   // details → pay → done
const error     = ref('');
const placing   = ref(false);
const order     = ref(null);        // response of place order
const failures  = ref([]);          // reservation failures needing resolution
const backorders = reactive({});    // variant_no → 'backorder' | 'remove' | 'notify'
const promoCode = ref('');
const promoMsg  = ref('');
const paying    = ref(false);

const shipTo = reactive({ name: '', address: '', city: '', state: '', zip: '', country: 'US', phone: '' });

const canPlace = computed(() =>
    cart.itemCount > 0 && shipTo.name && shipTo.address && shipTo.city && shipTo.zip
    && (!isGuest.value || EMAIL_REGEX.test(guestEmail.value)));

onMounted(async () => {
    if (isGuest.value) return;   // no profile to prefill — guest enters details
    try {
        const res = await api.get('/api/v1/customers/me');
        const me = res.data.content.customer;
        if (me) Object.assign(shipTo, {
            name: me.name || '', address: me.address || '', city: me.city || '',
            state: me.state || '', zip: me.zip || '', country: me.country || 'US',
            phone: me.phone || '',
        });
    } catch { /* profile not created yet — form stays blank */ }
});

async function checkPromo() {
    promoMsg.value = '';
    if (!promoCode.value) return;
    try {
        const res = await api.post('/api/v1/promotions/validate',
            { code: promoCode.value, subtotal: cart.total });
        const p = res.data.content.promotion;
        promoMsg.value = p.free_shipping
            ? 'Code valid — free shipping'
            : 'Code valid — saves $ ' + fixedNum(p.discount, 2);
    } catch (err) {
        promoMsg.value = err.response?.data?.outcome?.message || 'Invalid code';
    }
}

async function placeOrder() {
    placing.value = true;
    error.value = '';
    try {
        const body = { shipTo: { ...shipTo }, backorders: { ...backorders } };
        if (promoCode.value) body.promoCode = promoCode.value;

        // Guests have no server cart: send the local lines inline to the
        // public guest endpoint, which creates an implicit account by email.
        let res;
        if (isGuest.value) {
            body.email = guestEmail.value;
            body.name  = shipTo.name;
            body.items = (cart.cart?.items ?? []).map(i => ({ variant_no: i.variant_no, qty: i.qty }));
            res = await api.post('/api/v1/checkout/guest', body);
        } else {
            res = await api.post('/api/v1/checkout', body);
        }
        order.value = res.data.content.order;
        failures.value = [];
        step.value = 'pay';
    } catch (err) {
        const outcome = err.response?.data?.outcome;
        if (err.response?.status === 409 && outcome?.failures) {
            // Reservation failure: revert one step, let the shopper decide per line
            failures.value = outcome.failures;
            for (const f of failures.value) {
                if (!backorders[f.variant_no]) backorders[f.variant_no] = 'backorder';
            }
            error.value = 'Some items are not available in the requested quantity — choose what to do below, then place the order again.';
        } else {
            error.value = outcome?.message || 'Checkout failed';
        }
    } finally {
        placing.value = false;
    }
}

function lineName(variantNo) {
    const item = cart.cart?.items?.find(i => Number(i.variant_no) === Number(variantNo));
    return item ? item.name : 'Item ' + variantNo;
}

async function pay(outcome) {
    paying.value = true;
    error.value = '';
    try {
        await api.post('/api/v1/payments/fake/confirm',
            { intent_ref: order.value.payment.intent_ref, outcome });
        if (outcome === 'authorized') {
            step.value = 'done';
            if (isGuest.value) cart.clearGuestCart();
            else cart.fetchCart().catch(() => {});
        } else {
            error.value = 'Payment failed (simulated). The order was not completed and stock was released.';
            step.value = 'details';
            order.value = null;
        }
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Payment processing failed';
    } finally {
        paying.value = false;
    }
}
</script>

<template>
  <div class="checkout">
    <h2>Checkout</h2>

    <p v-if="error" class="error-text banner">{{ error }}</p>

    <!-- Step 1: details -->
    <template v-if="step === 'details'">
      <div v-if="failures.length" class="card failures">
        <h3>Availability changed</h3>
        <div v-for="f in failures" :key="f.variant_no" class="failure-row">
          <span class="fname">{{ lineName(f.variant_no) }}</span>
          <span class="muted">requested {{ f.qty }}, available {{ f.qty_available }}</span>
          <select v-model="backorders[f.variant_no]" class="input">
            <option value="backorder">Backorder (pay when it ships)</option>
            <option value="notify">Notify me when available</option>
            <option value="remove">Remove from order</option>
          </select>
        </div>
      </div>

      <div class="layout">
        <div class="card">
          <template v-if="isGuest">
            <h3>Contact</h3>
            <div class="form-grid guest-contact">
              <label>Email <input v-model.trim="guestEmail" class="input" type="email"
                                  placeholder="you@example.com" autocomplete="email" /></label>
            </div>
            <p class="muted small">Your order confirmation goes here — no account needed.
              Already have an account? <router-link to="/login">Log in</router-link> to keep your order history in one place.</p>
          </template>

          <h3>Shipping address</h3>
          <div class="form-grid">
            <label>Name <input v-model="shipTo.name" class="input" type="text" /></label>
            <label>Address <input v-model="shipTo.address" class="input" type="text" /></label>
            <label>City <input v-model="shipTo.city" class="input" type="text" /></label>
            <label>State <input v-model="shipTo.state" class="input" type="text" /></label>
            <label>ZIP <input v-model="shipTo.zip" class="input" type="text" /></label>
            <label>Country <input v-model="shipTo.country" class="input" type="text" /></label>
            <label>Phone <input v-model="shipTo.phone" class="input" type="text" /></label>
          </div>
        </div>

        <div class="card">
          <h3>Order summary</h3>
          <ul class="summary-lines">
            <li v-for="item in cart.cart?.items || []" :key="item.id">
              <span>{{ item.name }} × {{ item.qty }}</span>
              <span>$ {{ fixedNum(item.unit_price * item.qty, 2) }}</span>
            </li>
          </ul>
          <div class="promo">
            <input v-model="promoCode" class="input" type="text" placeholder="Promo code" />
            <button class="btn" @click="checkPromo">Apply</button>
          </div>
          <p v-if="promoMsg" class="muted promo-msg">{{ promoMsg }}</p>
          <div class="total-row">
            <span>Subtotal</span><strong>{{ cart.totalDisplay }}</strong>
          </div>
          <p class="muted small">Shipping and tax are calculated when you place the order.
            Stock is held for 15 minutes while you pay.</p>
          <button class="btn btn-primary place-btn" :disabled="!canPlace || placing" @click="placeOrder">
            {{ placing ? 'Placing…' : 'Place Order' }}
          </button>
        </div>
      </div>
    </template>

    <!-- Step 2: pay -->
    <template v-else-if="step === 'pay'">
      <div class="card pay-card">
        <h3>Order #{{ order.ord_no }} placed — complete payment</h3>
        <table class="totals">
          <tbody>
            <tr><td>Subtotal</td><td>$ {{ fixedNum(order.subtotal, 2) }}</td></tr>
            <tr v-if="order.discount"><td>Discount ({{ order.promo }})</td><td>− $ {{ fixedNum(order.discount, 2) }}</td></tr>
            <tr><td>Shipping</td><td>$ {{ fixedNum(order.shipping, 2) }}</td></tr>
            <tr><td>Tax</td><td>$ {{ fixedNum(order.tax, 2) }}</td></tr>
            <tr class="grand"><td>Total</td><td>$ {{ fixedNum(order.total, 2) }} {{ order.currency }}</td></tr>
          </tbody>
        </table>
        <p v-if="order.backordered?.length" class="pill warn">
          {{ order.backordered.length }} line(s) backordered — charged when they ship
        </p>
        <p class="muted small">Demo payment provider: no card required.</p>
        <div class="pay-actions">
          <button class="btn btn-primary" :disabled="paying" @click="pay('authorized')">
            {{ paying ? 'Processing…' : 'Pay now (demo)' }}
          </button>
          <button class="btn btn-danger" :disabled="paying" @click="pay('failed')">Simulate failure</button>
        </div>
      </div>
    </template>

    <!-- Step 3: done -->
    <template v-else>
      <div class="card done-card">
        <h3>✓ Payment confirmed</h3>
        <p>Order <strong>#{{ order.ord_no }}</strong> is paid. A confirmation email is on its way.</p>
        <p v-if="isGuest" class="muted small">
          To check on your order later, log in with <strong>{{ guestEmail }}</strong> —
          we'll email you a one-time code, no password needed.
        </p>
        <div class="pay-actions">
          <button v-if="!isGuest" class="btn btn-primary" @click="router.push('/orders')">View my orders</button>
          <button v-else class="btn btn-primary" @click="router.push('/login')">Log in to track it</button>
          <button class="btn" @click="router.push('/shop')">Keep shopping</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.checkout h2 { margin-bottom: 0.8rem; }
.banner { margin-bottom: 0.8rem; }
.layout { display: grid; grid-template-columns: 1fr 380px; gap: 1rem; align-items: start; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
.form-grid label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.82rem; color: var(--color-text-muted); }
.form-grid label:first-child, .form-grid label:nth-child(2) { grid-column: 1 / -1; }
.guest-contact { margin-bottom: 0.4rem; }

.summary-lines { list-style: none; padding: 0; margin-bottom: 0.6rem; }
.summary-lines li { display: flex; justify-content: space-between; font-size: 0.88rem; padding: 0.25rem 0; border-bottom: 1px solid var(--color-border); }

.promo { display: flex; gap: 0.4rem; margin: 0.6rem 0 0.2rem; }
.promo .input { flex: 1; }
.promo-msg { font-size: 0.8rem; }

.total-row { display: flex; justify-content: space-between; padding: 0.5rem 0; border-top: 2px solid var(--color-border-strong); margin-top: 0.5rem; }
.small { font-size: 0.78rem; }
.place-btn { width: 100%; justify-content: center; margin-top: 0.6rem; }

.failures { margin-bottom: 1rem; border-color: var(--warn); }
.failure-row { display: flex; align-items: center; gap: 0.8rem; padding: 0.4rem 0; flex-wrap: wrap; }
.fname { font-weight: 600; color: var(--color-heading); }

.pay-card, .done-card { max-width: 480px; }
.totals { width: 100%; margin: 0.6rem 0; font-size: 0.92rem; }
.totals td { padding: 0.2rem 0; }
.totals td:last-child { text-align: right; }
.totals .grand td { border-top: 2px solid var(--color-border-strong); font-weight: 700; color: var(--color-heading); }
.pay-actions { display: flex; gap: 0.6rem; margin-top: 0.8rem; }
</style>
