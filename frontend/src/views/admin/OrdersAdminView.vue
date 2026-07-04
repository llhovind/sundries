<script setup>
import { ref, onMounted } from 'vue';
import api from '@/services/api';
import { fixedNum } from '@/composables/utils';
import { useAuthStore } from '@/stores/auth';

const auth     = useAuthStore();
const orders   = ref([]);
const expanded = ref({});
const status   = ref('');
const error    = ref('');
const busy     = ref(null);

const STATUS_PILL = {
    pending_payment: 'warn', paid: 'accent', processing: 'accent',
    shipped: 'ok', completed: 'ok', cancelled: '', payment_failed: 'danger',
};

async function load() {
    error.value = '';
    try {
        const params = new URLSearchParams({ pageSize: 50 });
        if (status.value) params.set('status', status.value);
        const res = await api.get('/api/v1/orders?' + params.toString());
        orders.value = res.data.content.orders;
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Failed to load orders';
    }
}

async function toggle(ordNo) {
    if (expanded.value[ordNo]) { delete expanded.value[ordNo]; return; }
    const res = await api.get('/api/v1/orders/' + ordNo);
    expanded.value = { ...expanded.value, [ordNo]: res.data.content.order };
}

async function ship(ordNo) {
    busy.value = ordNo;
    error.value = '';
    try {
        await api.post('/api/v1/orders/' + ordNo + '/ship');
        await load();
        delete expanded.value[ordNo];
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Ship failed';
    } finally {
        busy.value = null;
    }
}

function fmtDate(d) { return d ? new Date(d).toLocaleString() : ''; }

onMounted(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>Orders</h2>
      <select v-model="status" class="input" @change="load">
        <option value="">All statuses</option>
        <option v-for="s in ['pending_payment','paid','processing','shipped','completed','cancelled','payment_failed']"
                :key="s" :value="s">{{ s.replace('_', ' ') }}</option>
      </select>
    </div>
    <p v-if="error" class="error-text">{{ error }}</p>

    <table class="table-plain">
      <thead>
        <tr><th>#</th><th>Placed</th><th>Customer</th><th>Status</th><th>Total</th><th></th></tr>
      </thead>
      <tbody>
        <template v-for="o in orders" :key="o.ord_no">
          <tr class="row" @click="toggle(o.ord_no)">
            <td>{{ o.ord_no }}</td>
            <td>{{ fmtDate(o.placed_at) }}</td>
            <td>{{ o.customer_name }} <span class="muted">({{ o.email }})</span></td>
            <td><span class="pill" :class="STATUS_PILL[o.status]">{{ o.status.replace('_', ' ') }}</span></td>
            <td>$ {{ fixedNum(o.total, 2) }}</td>
            <td>
              <button v-if="o.status === 'paid' && auth.hasPerm('orders:fulfill')"
                      class="btn btn-primary ship" :disabled="busy === o.ord_no"
                      @click.stop="ship(o.ord_no)">
                {{ busy === o.ord_no ? 'Shipping…' : 'Ship + capture' }}
              </button>
            </td>
          </tr>
          <tr v-if="expanded[o.ord_no]">
            <td colspan="6" class="detail">
              <p v-if="expanded[o.ord_no].fraud_flag" class="pill danger">
                ⚑ Flagged for review: {{ expanded[o.ord_no].fraud_notes }}
              </p>
              <ul class="lines">
                <li v-for="ln in expanded[o.ord_no].lines" :key="ln.id">
                  <span>{{ ln.sku }} — {{ ln.descr }} × {{ ln.qty }}</span>
                  <span class="pill">{{ ln.fulfillment_status }}</span>
                  <span>$ {{ fixedNum(ln.line_total, 2) }}</span>
                </li>
              </ul>
              <p class="muted small">
                Payments:
                <span v-for="p in expanded[o.ord_no].payments" :key="p.payment_no">
                  {{ p.provider }} {{ p.status }} $ {{ fixedNum(p.amount, 2) }}&nbsp;
                </span>
                · Ship to {{ expanded[o.ord_no].ship_name }},
                {{ expanded[o.ord_no].ship_city }} {{ expanded[o.ord_no].ship_state }}
              </p>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.8rem; }
.toolbar select { margin-left: auto; }
.row { cursor: pointer; }
.ship { padding: 0.15rem 0.6rem; font-size: 0.78rem; }
.detail { background: var(--color-surface-muted); }
.lines { list-style: none; padding: 0.2rem 0; }
.lines li { display: flex; gap: 1rem; align-items: center; padding: 0.2rem 0; }
.lines li span:last-child { margin-left: auto; }
.small { font-size: 0.78rem; }
</style>
