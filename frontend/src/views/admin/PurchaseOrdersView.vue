<script setup>
import { ref, computed, reactive, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { usePurchaseOrdersStore } from '@/stores/purchaseOrders';
import { apiErrorMessage } from '@/stores/storeUtils';
import { fixedNum } from '@/composables/utils';
import TableComponent from '@/components/TableComponent.vue';

const auth  = useAuthStore();
const store = usePurchaseOrdersStore();
onMounted(() => {
    store.getAll().catch(() => {});
    store.loadPicklists().catch(() => {});
});

const displayFields = ['po_no', 'vendor_name', 'warehouse_code', 'po_status', 'progress', 'subtotal', 'po_dt'];

const canManage  = computed(() => auth.hasPerm('purchasing:manage'));
const canReceive = computed(() => auth.hasPerm('inventory:receive'));

const mutationError = ref('');
const okMsg         = ref('');

// ── Create form ───────────────────────────────────────────────────────────────

const showCreate = ref(false);
const blank = () => ({
    vendor_id: null, warehouse_no: null,
    vendor_ordno: '', vendor_invno: '', freight: null, notes: '',
    lines: [],
});
const form = reactive(blank());

function openCreate() {
    Object.assign(form, blank());
    form.warehouse_no = store.warehouses[0]?.warehouse_no ?? null;
    lineDraft.matches = [];
    lineDraft.q = ''; lineDraft.variant_no = null; lineDraft.qty = null; lineDraft.unit_cost = null;
    showCreate.value = !showCreate.value;
}

const canCreate = computed(() =>
    form.vendor_id && form.warehouse_no && form.lines.length > 0);

const formSubtotal = computed(() =>
    form.lines.reduce((sum, l) => sum + Number(l.qty) * Number(l.unit_cost), 0));

// Line picker: search the catalog, pick a variant, set qty + landed unit cost.
const lineDraft = reactive({ q: '', matches: [], variant_no: null, qty: null, unit_cost: null });

async function searchVariants() {
    mutationError.value = '';
    try {
        lineDraft.matches    = await store.searchVariants(lineDraft.q);
        lineDraft.variant_no = lineDraft.matches[0]?.variant_no ?? null;
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Variant search failed');
    }
}

function addLine() {
    const match = lineDraft.matches.find(m => m.variant_no === lineDraft.variant_no);
    if (!match || !(lineDraft.qty > 0) || !(lineDraft.unit_cost >= 0)) return;
    if (form.lines.some(l => l.variant_no === match.variant_no)) {
        mutationError.value = `${match.sku} is already on this order — remove the line to change it`;
        return;
    }
    form.lines.push({ variant_no: match.variant_no, sku: match.sku, product_name: match.product_name,
                      qty: Number(lineDraft.qty), unit_cost: Number(lineDraft.unit_cost) });
    lineDraft.qty = null; lineDraft.unit_cost = null;
}

function removeLine(variantNo) {
    form.lines = form.lines.filter(l => l.variant_no !== variantNo);
}

async function create() {
    mutationError.value = ''; okMsg.value = '';
    try {
        const poNo = await store.createPo({
            ...form,
            freight: form.freight || null,
            lines: form.lines.map(l => ({ variant_no: l.variant_no, qty: l.qty, unit_cost: l.unit_cost })),
        });
        okMsg.value = `Purchase order #${poNo} raised.`;
        showCreate.value = false;
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Create failed');
    }
}

// ── Expandable detail + receiving ─────────────────────────────────────────────

// po_no → full PO with lines. Keys stay strings: pg returns BIGSERIAL ids as
// strings, and TableComponent matches expandedKeys by ===.
const details      = ref({});
const receiptDraft = ref({});   // po_line_id → qty to receive now
const expandedKeys = computed(() => Object.keys(details.value));

async function toggleDetail(row) {
    const key = row.po_no;
    if (details.value[key]) {
        const { [key]: _closed, ...rest } = details.value;
        details.value = rest;
        return;
    }
    await refreshDetail(key);
}

async function refreshDetail(poNo) {
    try {
        const po = await store.getPo(poNo);
        details.value = { ...details.value, [poNo]: po };
        const draft = {};
        po.lines.forEach(l => { draft[l.id] = null; });
        receiptDraft.value = { ...receiptDraft.value, ...draft };
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Failed to load purchase order');
    }
}

const remaining = line => Number(line.qty_ordered) - Number(line.qty_received);

function receivableLines(po) {
    return po.lines
        .map(l => ({ po_line_id: l.id, qty: Number(receiptDraft.value[l.id]) }))
        .filter(r => r.qty > 0);
}

async function receiveMarked(po) {
    mutationError.value = ''; okMsg.value = '';
    const lines = receivableLines(po);
    if (!lines.length) return;
    try {
        const result = await store.receivePo(po.po_no, lines);
        okMsg.value = `Receipt recorded on PO #${po.po_no}` +
                      (result.po_status === 'received' ? ' — fully received.' : '.');
        await refreshDetail(po.po_no);
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Receive failed');
    }
}

async function act(action, row) {
    const messages = {
        close:  'Close this purchase order? Receiving stops (short-close if lines are outstanding).',
        cancel: 'Cancel this purchase order?',
    };
    if (!window.confirm(messages[action])) return;
    mutationError.value = ''; okMsg.value = '';
    try {
        await store[action](row.po_no);
        okMsg.value = `Purchase order #${row.po_no} ${action === 'close' ? 'closed' : 'cancelled'}.`;
        if (details.value[row.po_no]) await refreshDetail(row.po_no);
    } catch (err) {
        mutationError.value = apiErrorMessage(err, `Failed to ${action} purchase order`);
    }
}

const STATUS_PILL = { open: 'warn', received: 'ok', closed: '', cancelled: '' };
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2>Purchasing</h2>
      <button v-if="canManage" class="btn btn-primary" @click="openCreate">+ New purchase order</button>
    </div>

    <div v-if="store.error || mutationError" class="error">{{ store.error || mutationError }}</div>
    <p v-if="okMsg" class="pill ok">{{ okMsg }}</p>

    <div v-if="showCreate" class="card create">
      <div class="inline-form">
        <label>Vendor
          <select v-model="form.vendor_id" class="input wide">
            <option v-for="v in store.vendors" :key="v.id" :value="v.id">{{ v.name }}</option>
          </select>
        </label>
        <label>Deliver to
          <select v-model="form.warehouse_no" class="input">
            <option v-for="w in store.warehouses" :key="w.warehouse_no" :value="w.warehouse_no">{{ w.code }}</option>
          </select>
        </label>
        <input v-model="form.vendor_ordno" class="input" type="text" placeholder="Vendor order #" />
        <input v-model="form.vendor_invno" class="input" type="text" placeholder="Vendor invoice #" />
        <input v-model.number="form.freight" class="input num" type="number" step="0.01" placeholder="Freight $" />
        <input v-model="form.notes" class="input wide" type="text" placeholder="Notes" />
      </div>

      <div class="inline-form">
        <input v-model="lineDraft.q" class="input" type="text" placeholder="Search name or SKU…"
               @keyup.enter="searchVariants" />
        <button class="btn" @click="searchVariants">Search</button>
        <select v-if="lineDraft.matches.length" v-model="lineDraft.variant_no" class="input wide">
          <option v-for="m in lineDraft.matches" :key="m.variant_no" :value="m.variant_no">
            {{ m.sku }} — {{ m.product_name }}
          </option>
        </select>
        <input v-model.number="lineDraft.qty" class="input num" type="number" min="0" step="0.25" placeholder="Qty" />
        <input v-model.number="lineDraft.unit_cost" class="input num" type="number" min="0" step="0.01"
               placeholder="Unit cost $" />
        <button class="btn" :disabled="!lineDraft.variant_no || !(lineDraft.qty > 0) || !(lineDraft.unit_cost >= 0)"
                @click="addLine">Add line</button>
      </div>

      <table v-if="form.lines.length" class="table-plain inner">
        <thead><tr><th>SKU</th><th>Product</th><th>Qty</th><th>Unit cost</th><th>Line total</th><th></th></tr></thead>
        <tbody>
          <tr v-for="ln in form.lines" :key="ln.variant_no">
            <td>{{ ln.sku }}</td>
            <td>{{ ln.product_name }}</td>
            <td>{{ fixedNum(ln.qty, 2) }}</td>
            <td>$ {{ fixedNum(ln.unit_cost, 4) }}</td>
            <td>$ {{ fixedNum(ln.qty * ln.unit_cost, 2) }}</td>
            <td><button class="btn mini" @click="removeLine(ln.variant_no)">✕</button></td>
          </tr>
        </tbody>
      </table>

      <div class="inline-form">
        <button class="btn btn-primary" :disabled="!canCreate" @click="create">Raise PO</button>
        <button class="btn" @click="showCreate = false">Close</button>
        <span v-if="form.lines.length" class="muted">Subtotal: $ {{ fixedNum(formSubtotal, 2) }}</span>
      </div>
    </div>

    <TableComponent
      :store="store"
      :rows="store.purchase_orders"
      :displayFields="displayFields"
      rowKey="po_no"
      clickable
      :expandedKeys="expandedKeys"
      label="Purchase Orders Found"
      @row-click="toggleDetail"
    >
      <template #filters>
        <label class="muted">Status
          <select v-model="store.query.status" class="input" @change="store.query.page = 1">
            <option value="">all</option>
            <option value="open">open</option>
            <option value="received">received</option>
            <option value="closed">closed</option>
            <option value="cancelled">cancelled</option>
          </select>
        </label>
      </template>

      <template #cell-po_status="{ row }">
        <span class="pill" :class="STATUS_PILL[row.po_status]">{{ row.po_status }}</span>
      </template>

      <template #cell-progress="{ row }">
        {{ fixedNum(row.qty_received, 1) }} / {{ fixedNum(row.qty_ordered, 1) }}
        <span class="muted">({{ row.line_count }} line{{ row.line_count === 1 ? '' : 's' }})</span>
      </template>

      <template #cell-subtotal="{ row }">
        $ {{ fixedNum(row.subtotal, 2) }}
      </template>

      <template #cell-po_dt="{ row }">
        <span class="muted">{{ new Date(row.po_dt).toLocaleDateString() }}</span>
      </template>

      <template #row-actions="{ row }">
        <template v-if="canManage">
          <button v-if="['open', 'received'].includes(row.po_status)" class="btn mini"
                  @click="act('close', row)">Close</button>
          <button v-if="row.po_status === 'open' && Number(row.qty_received) === 0" class="btn mini"
                  @click="act('cancel', row)">Cancel</button>
        </template>
      </template>

      <template #detail="{ row }">
        <div v-if="details[row.po_no]" class="detail">
          <p class="muted">
            {{ details[row.po_no].vendor_name }} → {{ details[row.po_no].warehouse_code }}
            <span v-if="details[row.po_no].vendor_ordno"> · vendor order {{ details[row.po_no].vendor_ordno }}</span>
            <span v-if="details[row.po_no].vendor_invno"> · invoice {{ details[row.po_no].vendor_invno }}</span>
            <span v-if="details[row.po_no].freight != null"> · freight $ {{ fixedNum(details[row.po_no].freight, 2) }}</span>
          </p>
          <p v-if="details[row.po_no].notes" class="muted">{{ details[row.po_no].notes }}</p>

          <table class="table-plain inner">
            <thead>
              <tr>
                <th>#</th><th>SKU</th><th>Product</th><th>Unit cost</th>
                <th>Ordered</th><th>Received</th><th>Outstanding</th>
                <th v-if="canReceive && details[row.po_no].po_status === 'open'">Receive now</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ln in details[row.po_no].lines" :key="ln.id">
                <td>{{ ln.ln_no }}</td>
                <td>{{ ln.sku }}</td>
                <td>{{ ln.product_name }}</td>
                <td>$ {{ fixedNum(ln.unit_cost, 4) }}</td>
                <td>{{ fixedNum(ln.qty_ordered, 2) }} <span class="muted">{{ ln.base_uom }}</span></td>
                <td>{{ fixedNum(ln.qty_received, 2) }}</td>
                <td :class="{ done: remaining(ln) === 0 }">{{ fixedNum(remaining(ln), 2) }}</td>
                <td v-if="canReceive && details[row.po_no].po_status === 'open'">
                  <input v-if="remaining(ln) > 0" v-model.number="receiptDraft[ln.id]"
                         class="input qty" type="number" min="0" :max="remaining(ln)" step="0.25"
                         placeholder="0" />
                  <span v-else class="pill ok">complete</span>
                </td>
              </tr>
            </tbody>
          </table>

          <button v-if="canReceive && details[row.po_no].po_status === 'open'"
                  class="btn btn-primary mini"
                  :disabled="!receivableLines(details[row.po_no]).length"
                  @click="receiveMarked(details[row.po_no])">
            Receive marked quantities
          </button>
        </div>
      </template>

      <template #empty>No purchase orders found.</template>
    </TableComponent>
  </div>
</template>

<style lang="scss" scoped>
.view { display: flex; flex-direction: column; height: 100%; }
.view-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;
  h2 { margin: 0; color: #3a2060; }
}
.error { color: #c0392b; font-size: 0.9rem; }
.create { margin-bottom: 1rem; }
.inline-form {
  display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.5rem;
  label { display: flex; flex-direction: column; font-size: 0.75rem; color: #666; }
}
.num { width: 120px; }
.qty { width: 90px; }
.wide { min-width: 240px; }
.mini { padding: 0.1rem 0.5rem; font-size: 0.75rem; margin-right: 0.25rem; }
.inner { font-size: 0.82rem; margin-bottom: 0.5rem; }
.detail { padding: 0.25rem 0; p { margin: 0.15rem 0; } }
.done { color: #2e7d32; }
</style>
