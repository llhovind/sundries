<script setup>
import { ref, onMounted, computed } from 'vue';
import api from '@/services/api';
import { fixedNum } from '@/composables/utils';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();

const canCogs = computed(() => auth.hasPerm('reports:cogs'));
const tabs = computed(() => [
    { id: 'sales',        label: 'Sales summary', show: true },
    { id: 'cogs',         label: 'COGS & margin', show: canCogs.value },
    { id: 'valuation',    label: 'Valuation',     show: canCogs.value },
    { id: 'shrinkage',    label: 'Shrinkage',     show: canCogs.value },
    { id: 'reservations', label: 'Reservations',  show: true },
].filter(t => t.show));

const tab     = ref('sales');
const rows    = ref([]);
const error   = ref('');
const groupBy = ref('product');
const from    = ref(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
const to      = ref(new Date().toISOString().slice(0, 10));

const ENDPOINTS = {
    sales:        () => '/api/v1/reports/sales-summary?from=' + from.value + '&to=' + to.value,
    cogs:         () => '/api/v1/reports/cogs?from=' + from.value + '&to=' + to.value + '&group_by=' + groupBy.value,
    valuation:    () => '/api/v1/reports/valuation',
    shrinkage:    () => '/api/v1/reports/shrinkage?from=' + from.value + '&to=' + to.value,
    reservations: () => '/api/v1/reports/reservations',
};
const KEYS = { sales: 'sales_summary', cogs: 'cogs', valuation: 'valuation',
               shrinkage: 'shrinkage', reservations: 'reservations' };

async function load() {
    error.value = '';
    rows.value = [];
    try {
        const res = await api.get(ENDPOINTS[tab.value]());
        rows.value = res.data.content[KEYS[tab.value]];
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Report failed';
    }
}

function pick(t) { tab.value = t; load(); }
const money = v => v != null ? '$ ' + fixedNum(v, 2) : '—';
const hasDates = computed(() => ['sales', 'cogs', 'shrinkage'].includes(tab.value));

onMounted(load);
</script>

<template>
  <div>
    <h2>Reports</h2>
    <div class="tabs">
      <button v-for="t in tabs" :key="t.id" class="btn tab" :class="{ active: tab === t.id }"
              @click="pick(t.id)">{{ t.label }}</button>
    </div>

    <div class="filters" v-if="hasDates">
      <label>From <input v-model="from" type="date" class="input" @change="load" /></label>
      <label>To <input v-model="to" type="date" class="input" @change="load" /></label>
      <label v-if="tab === 'cogs'">Group by
        <select v-model="groupBy" class="input" @change="load">
          <option v-for="g in ['product','category','day','month']" :key="g" :value="g">{{ g }}</option>
        </select>
      </label>
    </div>

    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="!rows.length && !error" class="muted">No data for this period.</p>

    <!-- Sales summary -->
    <table v-if="tab === 'sales' && rows.length" class="table-plain">
      <thead><tr><th>Date</th><th>Orders</th><th>Units</th><th>Revenue</th><th>COGS</th><th>Margin</th><th>Shrinkage</th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.fact_date">
          <td>{{ r.fact_date.slice(0, 10) }}</td>
          <td>{{ r.orders_placed }}</td>
          <td>{{ fixedNum(r.units_sold, 1) }}</td>
          <td>{{ money(r.revenue) }}</td>
          <td>{{ money(r.cogs) }}</td>
          <td>{{ money(r.gross_margin) }}</td>
          <td>{{ money(r.shrinkage_cost) }}</td>
        </tr>
      </tbody>
    </table>

    <!-- COGS -->
    <table v-if="tab === 'cogs' && rows.length" class="table-plain">
      <thead><tr><th>{{ groupBy }}</th><th>Units sold</th><th>Revenue</th><th>COGS</th><th>Gross margin</th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.group_label">
          <td>{{ r.group_label }}</td>
          <td>{{ fixedNum(r.units_sold, 1) }}</td>
          <td>{{ money(r.revenue) }}</td>
          <td>{{ money(r.cogs) }}</td>
          <td>{{ money(r.gross_margin) }}</td>
        </tr>
      </tbody>
    </table>

    <!-- Valuation -->
    <table v-if="tab === 'valuation' && rows.length" class="table-plain">
      <thead><tr><th>Warehouse</th><th>Variants</th><th>Units</th><th>Value (FIFO)</th><th></th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.warehouse_no">
          <td>{{ r.warehouse_code }} — {{ r.warehouse_name }}</td>
          <td>{{ r.variants }}</td>
          <td>{{ fixedNum(r.units_on_hand, 1) }}</td>
          <td>{{ money(r.value) }}</td>
          <td><span v-if="r.in_transit" class="pill warn">in transit</span></td>
        </tr>
      </tbody>
    </table>

    <!-- Shrinkage -->
    <table v-if="tab === 'shrinkage' && rows.length" class="table-plain">
      <thead><tr><th>Reason</th><th>Entries</th><th>Units</th><th>Cost</th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.reason">
          <td>{{ r.reason }}</td>
          <td>{{ r.entries }}</td>
          <td>{{ fixedNum(r.units, 1) }}</td>
          <td>{{ money(r.cost) }}</td>
        </tr>
      </tbody>
    </table>

    <!-- Reservations -->
    <table v-if="tab === 'reservations' && rows.length" class="table-plain">
      <thead><tr><th>Order</th><th>Product</th><th>SKU</th><th>Qty</th><th>Warehouse</th><th>Expires</th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.reservation_no">
          <td>#{{ r._ord_no }}</td>
          <td>{{ r.product_name }}</td>
          <td>{{ r.sku }}</td>
          <td>{{ fixedNum(r.qty, 2) }}</td>
          <td>{{ r.warehouse_code }}</td>
          <td>{{ new Date(r.expires_at).toLocaleTimeString() }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
h2 { margin-bottom: 0.6rem; }
.tabs { display: flex; gap: 0.4rem; margin-bottom: 0.8rem; flex-wrap: wrap; }
.tab.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.filters { display: flex; gap: 1rem; margin-bottom: 0.8rem; align-items: end; flex-wrap: wrap; }
.filters label { display: flex; flex-direction: column; font-size: 0.8rem; color: var(--color-text-muted); gap: 0.2rem; }
</style>
