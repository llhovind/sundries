<script setup>
import { ref, computed, reactive, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useInventoryStore } from '@/stores/inventory';
import { apiErrorMessage } from '@/stores/storeUtils';
import { fixedNum } from '@/composables/utils';
import TableComponent from '@/components/TableComponent.vue';

const auth  = useAuthStore();
const store = useInventoryStore();
onMounted(() => {
    store.getAll().catch(() => {});
    store.loadWarehouses().catch(() => {});   // receive/adjust forms will show no warehouses
});

const displayFields = ['product_name', 'sku', 'qty_on_hand', 'qty_reserved', 'qty_available', 'warehouses'];

const mutationError = ref('');
const okMsg         = ref('');
const form          = reactive({ open: null, mode: 'receive', warehouse_no: null, qty: null, unit_cost: null, reason_code: 'count' });

// ── Expandable detail: transaction ledger and/or receive-adjust form ─────────

const ledger       = ref({});   // variant_no → transaction rows
const expandedKeys = computed(() =>
    store.balances
        .filter(b => ledger.value[b.variant_no] || form.open === b.variant_no)
        .map(b => b.variant_no));

async function toggleLedger(balance) {
    const key = balance.variant_no;
    if (ledger.value[key]) { delete ledger.value[key]; return; }
    try {
        ledger.value = { ...ledger.value, [key]: await store.getLedger(key) };
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Failed to load ledger');
    }
}

function openForm(row, mode) {
    form.open = row.variant_no;
    form.mode = mode;
    form.warehouse_no = store.warehouses[0]?.warehouse_no || null;
    form.qty = null;
    form.unit_cost = null;
    form.reason_code = mode === 'adjust' ? 'count' : '';
}

async function submitForm() {
    mutationError.value = ''; okMsg.value = '';
    try {
        if (form.mode === 'receive') {
            await store.receive({
                variant_no: form.open, warehouse_no: form.warehouse_no,
                qty: form.qty, unit_cost: form.unit_cost,
            });
        } else {
            await store.adjust({
                variant_no: form.open, warehouse_no: form.warehouse_no,
                qty: form.qty, unit_cost: form.qty > 0 ? form.unit_cost : null,
                reason_code: form.reason_code,
            });
        }
        okMsg.value = 'Recorded.';
        form.open = null;
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Failed to record');
    }
}
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2>Inventory</h2>
    </div>

    <div v-if="store.error || mutationError" class="error">{{ store.error || mutationError }}</div>
    <p v-if="okMsg" class="pill ok">{{ okMsg }}</p>

    <TableComponent
      :store="store"
      :rows="store.balances"
      :displayFields="displayFields"
      rowKey="variant_no"
      clickable
      :expandedKeys="expandedKeys"
      searchPlaceholder="Search name or SKU…"
      label="Items Found"
      @row-click="toggleLedger"
    >
      <template #cell-qty_on_hand="{ row }">
        {{ fixedNum(row.qty_on_hand, 2) }} <span class="muted">{{ row.base_uom }}</span>
      </template>

      <template #cell-qty_available="{ row }">
        <strong>{{ fixedNum(row.qty_available, 2) }}</strong>
      </template>

      <template #cell-warehouses="{ row }">
        <span class="muted whs">
          <span v-for="w in row.warehouses" :key="w.warehouse_no">
            {{ w.code }}: {{ fixedNum(w.qty_on_hand, 1) }}<span v-if="w.wh_type === 'transport'"> (transit)</span>&nbsp;
          </span>
        </span>
      </template>

      <template #row-actions="{ row }">
        <button v-if="auth.hasPerm('inventory:receive')" class="btn mini" @click="openForm(row, 'receive')">Receive</button>
        <button v-if="auth.hasPerm('inventory:adjust')" class="btn mini" @click="openForm(row, 'adjust')">Adjust</button>
      </template>

      <template #detail="{ row }">
        <div v-if="form.open === row.variant_no" class="inline-form">
          <strong>{{ form.mode === 'receive' ? 'Receive stock' : 'Adjustment / write-off' }}</strong>
          <select v-model="form.warehouse_no" class="input">
            <option v-for="w in store.warehouses" :key="w.warehouse_no" :value="w.warehouse_no">{{ w.code }}</option>
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

        <table v-if="ledger[row.variant_no]" class="table-plain inner">
          <thead><tr><th>When</th><th>Type</th><th>Qty</th><th>Cost</th><th>Price</th><th>Reason</th><th>Ref</th></tr></thead>
          <tbody>
            <tr v-for="t in ledger[row.variant_no]" :key="t.trn_no">
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
      </template>

      <template #empty>No inventory found.</template>
    </TableComponent>
  </div>
</template>

<style lang="scss" scoped>
.view { display: flex; flex-direction: column; height: 100%; }
.view-header {
  display: flex; align-items: center; margin-bottom: 0.75rem;
  h2 { margin: 0; color: #3a2060; }
}
.error { color: #c0392b; margin-bottom: 0.5rem; font-size: 0.9rem; }
.whs { font-size: 0.78rem; }
.mini { padding: 0.1rem 0.5rem; font-size: 0.75rem; margin-right: 0.25rem; }
.inline-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.4rem; }
.qty { width: 130px; }
.inner { font-size: 0.82rem; }
</style>
