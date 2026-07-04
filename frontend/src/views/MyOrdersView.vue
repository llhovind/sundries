<script setup>
import { ref, onMounted } from 'vue';
import api from '@/services/api';
import { fixedNum } from '@/composables/utils';

const orders   = ref([]);
const expanded = ref({});   // ord_no → full order
const error    = ref('');

const STATUS_PILL = {
    pending_payment: 'warn', paid: 'ok', processing: 'accent',
    shipped: 'ok', completed: 'ok', cancelled: '', payment_failed: 'danger',
};

async function load() {
    try {
        const res = await api.get('/api/v1/orders?pageSize=50');
        orders.value = res.data.content.orders;
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

function fmtDate(d) { return d ? new Date(d).toLocaleString() : ''; }

onMounted(load);
</script>

<template>
  <div>
    <h2>My Orders</h2>
    <p v-if="error" class="error-text">{{ error }}</p>
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
            </td>
          </tr>
        </template>
      </tbody>
    </table>
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
</style>
