<script setup>
import { ref, reactive, onMounted } from 'vue';
import api from '@/services/api';
import { fixedNum, debounce } from '@/composables/utils';
import { useAuthStore } from '@/stores/auth';

const auth       = useAuthStore();
const balances   = ref([]);
const warehouses = ref([]);
const search     = ref('');
const error      = ref('');
const okMsg      = ref('');
const ledger     = ref({});   // variant_no → rows
const form       = reactive({ open: null, mode: 'receive', warehouse_no: null, qty: null, unit_cost: null, reason_code: 'count' });

async function load() {
    error.value = '';
    try {
        const params = new URLSearchParams({ pageSize: 50 });
        if (search.value) params.set('q', search.value);
        const res = await api.get('/api/v1/inventory/balances?' + params.toString());
        balances.value = res.data.content.balances;
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Failed to load balances';
    }
}
const onSearch = debounce(load, 300);

async function toggleLedger(variantNo) {
    if (ledger.value[variantNo]) { delete ledger.value[variantNo]; return; }
    const res = await api.get('/api/v1/inventory/ledger/' + variantNo);
    ledger.value = { ...ledger.value, [variantNo]: res.data.content.transactions };
}

function openForm(row, mode) {
    form.open = row.variant_no;
    form.mode = mode;
    form.warehouse_no = warehouses.value[0]?.warehouse_no || null;
    form.qty = null;
    form.unit_cost = null;
    form.reason_code = mode === 'adjust' ? 'count' : '';
}

async function submitForm() {
    error.value = ''; okMsg.value = '';
    try {
        if (form.mode === 'receive') {
            await api.post('/api/v1/inventory/receive', {
                variant_no: form.open, warehouse_no: form.warehouse_no,
                qty: form.qty, unit_cost: form.unit_cost,
            });
        } else {
            await api.post('/api/v1/inventory/adjust', {
                variant_no: form.open, warehouse_no: form.warehouse_no,
                qty: form.qty, unit_cost: form.qty > 0 ? form.unit_cost : null,
                reason_code: form.reason_code,
            });
        }
        okMsg.value = 'Recorded.';
        form.open = null;
        await load();
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Failed to record';
    }
}

onMounted(async () => {
    await load();
    try {
        const res = await api.get('/api/v1/inventory/warehouses');
        warehouses.value = res.data.content.warehouses.filter(w => w.wh_type === 'standard');
    } catch { /* receive/adjust forms will show no warehouses */ }
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>Inventory</h2>
      <input v-model="search" class="input search" type="text" placeholder="Search name or SKU…" @input="onSearch" />
    </div>
    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="okMsg" class="pill ok">{{ okMsg }}</p>

    <table class="table-plain">
      <thead>
        <tr><th>Product</th><th>SKU</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Warehouses</th><th></th></tr>
      </thead>
      <tbody>
        <template v-for="b in balances" :key="b.variant_no">
          <tr>
            <td class="clickable" @click="toggleLedger(b.variant_no)">{{ b.product_name }}</td>
            <td>{{ b.sku }}</td>
            <td>{{ fixedNum(b.qty_on_hand, 2) }} <span class="muted">{{ b.base_uom }}</span></td>
            <td>{{ fixedNum(b.qty_reserved, 2) }}</td>
            <td><strong>{{ fixedNum(b.qty_available, 2) }}</strong></td>
            <td class="muted whs">
              <span v-for="w in b.warehouses" :key="w.warehouse_no">
                {{ w.code }}: {{ fixedNum(w.qty_on_hand, 1) }}<span v-if="w.wh_type === 'transport'"> (transit)</span>&nbsp;
              </span>
            </td>
            <td class="actions">
              <button v-if="auth.hasPerm('inventory:receive')" class="btn mini" @click="openForm(b, 'receive')">Receive</button>
              <button v-if="auth.hasPerm('inventory:adjust')" class="btn mini" @click="openForm(b, 'adjust')">Adjust</button>
            </td>
          </tr>
          <tr v-if="form.open === b.variant_no">
            <td colspan="7" class="detail">
              <div class="inline-form">
                <strong>{{ form.mode === 'receive' ? 'Receive stock' : 'Adjustment / write-off' }}</strong>
                <select v-model="form.warehouse_no" class="input">
                  <option v-for="w in warehouses" :key="w.warehouse_no" :value="w.warehouse_no">{{ w.code }}</option>
                </select>
                <input v-model.number="form.qty" class="input qty" type="number" step="0.25"
                       :placeholder="form.mode === 'receive' ? 'Qty' : 'Qty (± signed)'" />
                <input v-if="form.mode === 'receive' || form.qty > 0" v-model.number="form.unit_cost"
                       class="input qty" type="number" step="0.01" placeholder="Unit cost $" />
                <input v-if="form.mode === 'adjust'" v-model="form.reason_code" class="input"
                       type="text" placeholder="Reason (remnant, damage, count…)" />
                <button class="btn btn-primary" @click="submitForm">Save</button>
                <button class="btn" @click="form.open = null">Cancel</button>
              </div>
            </td>
          </tr>
          <tr v-if="ledger[b.variant_no]">
            <td colspan="7" class="detail">
              <table class="table-plain inner">
                <thead><tr><th>When</th><th>Type</th><th>Qty</th><th>Cost</th><th>Price</th><th>Reason</th><th>Ref</th></tr></thead>
                <tbody>
                  <tr v-for="t in ledger[b.variant_no]" :key="t.trn_no">
                    <td>{{ new Date(t._trn_dt).toLocaleString() }}</td>
                    <td><span class="pill" :class="Number(t.qty) > 0 ? 'ok' : 'warn'">{{ t._trn_type }}</span></td>
                    <td>{{ fixedNum(t.qty, 2) }}</td>
                    <td>{{ t.unit_cost != null ? '$ ' + fixedNum(t.unit_cost, 4) : '—' }}</td>
                    <td>{{ t.unit_price != null ? '$ ' + fixedNum(t.unit_price, 2) : '—' }}</td>
                    <td>{{ t.reason_code || '—' }}</td>
                    <td class="muted">{{ t._lnk_table }} {{ t._lnk_id }}</td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.8rem; }
.search { flex: 0 1 300px; margin-left: auto; }
.clickable { cursor: pointer; color: var(--accent); }
.whs { font-size: 0.78rem; }
.actions { white-space: nowrap; }
.mini { padding: 0.1rem 0.5rem; font-size: 0.75rem; margin-right: 0.25rem; }
.detail { background: var(--color-surface-muted); }
.inline-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.qty { width: 130px; }
.inner { font-size: 0.82rem; }
</style>
