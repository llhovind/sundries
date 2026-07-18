<script setup>
import { ref, onMounted } from 'vue';
import api from '@/services/api';
import { fixedNum } from '@/composables/utils';

const orders   = ref([]);
const expanded = ref({});   // ord_no → full order
const rmas     = ref([]);   // this customer's returns
const error    = ref('');
const okMsg    = ref('');

const STATUS_PILL = {
    pending_payment: 'warn', paid: 'ok', processing: 'accent', partially_shipped: 'warn',
    shipped: 'ok', completed: 'ok', cancelled: '', payment_failed: 'danger',
};
const RMA_PILL = { requested: 'warn', approved: 'accent', received: 'accent',
                   refunded: 'ok', rejected: 'danger', closed: '' };

// Returns can be requested once something has shipped.
const RETURNABLE_ORDER = ['shipped', 'partially_shipped', 'completed'];

async function load() {
    try {
        const res = await api.get('/api/v1/orders?pageSize=50');
        orders.value = res.data.content.orders;
        const rmaRes = await api.get('/api/v1/rmas?pageSize=50');
        rmas.value = rmaRes.data.content.rmas;
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Failed to load orders';
    }
}

async function toggle(ordNo) {
    if (expanded.value[ordNo]) {
        delete expanded.value[ordNo];
        return;
    }
    const res = await api.get('/api/v1/orders/' + ordNo);
    expanded.value = { ...expanded.value, [ordNo]: res.data.content.order };
}

async function cancel(ordNo) {
    error.value = '';
    try {
        await api.post('/api/v1/checkout/' + ordNo + '/cancel');
        await load();
        delete expanded.value[ordNo];
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Cancel failed';
    }
}

// ── Request a return ──────────────────────────────────────────────────────────

const returnForm = ref(null);   // { ord_no, reason, lines: {order_line_id → qty} }

function openReturn(order) {
    returnForm.value = { ord_no: order.ord_no, reason: '', lines: {} };
}

function returnableLines(order) {
    return order.lines.filter(ln => ln.fulfillment_status === 'shipped');
}

async function submitReturn(order) {
    error.value = ''; okMsg.value = '';
    const lines = Object.entries(returnForm.value.lines)
        .filter(([, qty]) => Number(qty) > 0)
        .map(([id, qty]) => ({ order_line_id: Number(id), qty: Number(qty) }));
    if (!lines.length || !returnForm.value.reason) return;
    try {
        const res = await api.post('/api/v1/rmas', {
            ord_no: order.ord_no, reason: returnForm.value.reason, lines,
        });
        okMsg.value = `Return #${res.data.content.rma_no} requested — we'll email you when it's reviewed.`;
        returnForm.value = null;
        await load();
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Return request failed';
    }
}

function fmtDate(d) { return d ? new Date(d).toLocaleString() : ''; }

onMounted(load);
</script>

<template>
  <div>
    <h2>My Orders</h2>
    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="okMsg" class="pill ok">{{ okMsg }}</p>
    <p v-if="!orders.length" class="muted">No orders yet.</p>

    <table v-else class="table-plain">
      <thead>
        <tr><th>#</th><th>Placed</th><th>Status</th><th>Items</th><th>Total</th><th></th></tr>
      </thead>
      <tbody>
        <template v-for="o in orders" :key="o.ord_no">
          <tr class="row" @click="toggle(o.ord_no)">
            <td>{{ o.ord_no }}</td>
            <td>{{ fmtDate(o.placed_at) }}</td>
            <td><span class="pill" :class="STATUS_PILL[o.status]">{{ o.status.replace('_', ' ') }}</span></td>
            <td>{{ o.line_count }}</td>
            <td>$ {{ fixedNum(o.total, 2) }}</td>
            <td>
              <button v-if="o.status === 'pending_payment'" class="btn btn-danger cancel"
                      @click.stop="cancel(o.ord_no)">Cancel</button>
            </td>
          </tr>
          <tr v-if="expanded[o.ord_no]">
            <td colspan="6" class="detail">
              <ul class="lines">
                <li v-for="ln in expanded[o.ord_no].lines" :key="ln.id">
                  <span>{{ ln.descr }} <span class="muted">× {{ ln.qty }}</span></span>
                  <span class="pill" :class="ln.fulfillment_status === 'backordered' ? 'warn' : ''">
                    {{ ln.fulfillment_status }}</span>
                  <span>$ {{ fixedNum(ln.line_total, 2) }}</span>
                </li>
              </ul>
              <p class="muted small">
                Ship to: {{ expanded[o.ord_no].ship_name }}, {{ expanded[o.ord_no].ship_address }},
                {{ expanded[o.ord_no].ship_city }} {{ expanded[o.ord_no].ship_zip }}
                · Shipping $ {{ fixedNum(expanded[o.ord_no].shipping, 2) }}
                · Tax $ {{ fixedNum(expanded[o.ord_no].tax, 2) }}
              </p>

              <p v-for="s in expanded[o.ord_no].shipments" :key="s.shipment_no" class="small tracking">
                📦 Shipped {{ new Date(s.shipped_at).toLocaleDateString() }}<template
                  v-if="s.carrier"> via {{ s.carrier }}</template><template
                  v-if="s.tracking_no"> — tracking <strong>{{ s.tracking_no }}</strong></template>
                <span class="muted">({{ s.lines.map(l => `${l.descr || l.sku} × ${l.qty}`).join(', ') }})</span>
              </p>

              <!-- Request a return: shipped lines only, within the return window -->
              <button v-if="RETURNABLE_ORDER.includes(o.status) && returnForm?.ord_no !== o.ord_no"
                      class="btn cancel" @click.stop="openReturn(expanded[o.ord_no])">
                Request return
              </button>

              <div v-if="returnForm?.ord_no === o.ord_no" class="return-form" @click.stop>
                <strong class="small">Return items</strong>
                <div v-for="ln in returnableLines(expanded[o.ord_no])" :key="ln.id" class="return-line">
                  <span>{{ ln.descr }} <span class="muted">(bought {{ fixedNum(ln.qty, 2) }})</span></span>
                  <input v-model.number="returnForm.lines[ln.id]" type="number"
                         min="0" :max="Number(ln.qty)" step="0.25" placeholder="Qty" class="qty" />
                </div>
                <input v-model="returnForm.reason" type="text" class="reason"
                       placeholder="Why are you returning this? *" />
                <div class="return-actions">
                  <button class="btn btn-primary cancel"
                          :disabled="!returnForm.reason || !Object.values(returnForm.lines).some(q => q > 0)"
                          @click="submitReturn(expanded[o.ord_no])">Submit return</button>
                  <button class="btn cancel" @click="returnForm = null">Never mind</button>
                </div>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <template v-if="rmas.length">
      <h2 class="returns-h">My Returns</h2>
      <table class="table-plain">
        <thead>
          <tr><th>#</th><th>Order</th><th>Requested</th><th>Status</th><th>Reason</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in rmas" :key="r.rma_no">
            <td>{{ r.rma_no }}</td>
            <td>{{ r._ord_no }}</td>
            <td>{{ fmtDate(r._create_ts) }}</td>
            <td><span class="pill" :class="RMA_PILL[r.status]">{{ r.status }}</span></td>
            <td class="muted">{{ r.reason }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<style scoped>
h2 { margin-bottom: 0.8rem; }
.row { cursor: pointer; }
.cancel { padding: 0.15rem 0.6rem; font-size: 0.78rem; }
.detail { background: var(--color-surface-muted); }
.lines { list-style: none; padding: 0; }
.lines li { display: flex; gap: 1rem; align-items: center; padding: 0.25rem 0; }
.lines li span:last-child { margin-left: auto; }
.small { font-size: 0.78rem; margin-top: 0.4rem; }
.returns-h { margin-top: 1.5rem; }
.return-form {
  margin-top: 0.5rem; padding: 0.5rem; border: 1px solid var(--color-border, #ddd);
  border-radius: 4px; display: flex; flex-direction: column; gap: 0.35rem; max-width: 480px;
}
.return-line { display: flex; align-items: center; gap: 0.5rem; justify-content: space-between; font-size: 0.85rem; }
.qty { width: 80px; }
.reason { width: 100%; }
.return-actions { display: flex; gap: 0.5rem; }
</style>
