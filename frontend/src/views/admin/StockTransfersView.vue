<script setup>
import { ref, computed, reactive, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useStockTransfersStore } from '@/stores/stockTransfers';
import { apiErrorMessage } from '@/stores/storeUtils';
import { fixedNum } from '@/composables/utils';
import TableComponent from '@/components/TableComponent.vue';

const auth  = useAuthStore();
const store = useStockTransfersStore();
onMounted(() => {
    store.getAll().catch(() => {});
    store.loadWarehouses().catch(() => {});
});

const displayFields = ['transfer_no', 'route', 'status', 'carrier', 'line_count', '_create_ts'];

const standardWhs  = computed(() => store.warehouses.filter(w => w.wh_type === 'standard'));
const transportWhs = computed(() => store.warehouses.filter(w => w.wh_type === 'transport'));

const mutationError = ref('');
const okMsg         = ref('');

// ── Create form ───────────────────────────────────────────────────────────────

const showCreate = ref(false);
const blank = () => ({
    from_warehouse_no: null, to_warehouse_no: null, transport_warehouse_no: null,
    carrier: '', tracking_no: '', manifest_id: '', billing_no: '', notes: '',
    lines: [],
});
const form = reactive(blank());

function openCreate() {
    Object.assign(form, blank());
    form.transport_warehouse_no = transportWhs.value[0]?.warehouse_no ?? null;
    lineDraft.matches = [];
    lineDraft.q = ''; lineDraft.variant_no = null; lineDraft.qty = null;
    showCreate.value = !showCreate.value;
}

const canCreate = computed(() =>
    form.from_warehouse_no && form.to_warehouse_no && form.transport_warehouse_no &&
    form.from_warehouse_no !== form.to_warehouse_no && form.lines.length > 0);

// Line picker: search the catalog, pick a variant, set a qty, add.
const lineDraft = reactive({ q: '', matches: [], variant_no: null, qty: null });

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
    if (!match || !(lineDraft.qty > 0)) return;
    const existing = form.lines.find(l => l.variant_no === match.variant_no);
    if (existing) existing.qty = Number(existing.qty) + Number(lineDraft.qty);
    else form.lines.push({ variant_no: match.variant_no, sku: match.sku,
                           product_name: match.product_name, qty: Number(lineDraft.qty) });
    lineDraft.qty = null;
}

function removeLine(variantNo) {
    form.lines = form.lines.filter(l => l.variant_no !== variantNo);
}

async function create() {
    mutationError.value = ''; okMsg.value = '';
    try {
        const transferNo = await store.createTransfer({
            ...form,
            lines: form.lines.map(l => ({ variant_no: l.variant_no, qty: l.qty })),
        });
        okMsg.value = `Transfer #${transferNo} created as draft.`;
        showCreate.value = false;
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Create failed');
    }
}

// ── Lifecycle actions ─────────────────────────────────────────────────────────

const CONFIRMS = {
    dispatch: 'Dispatch this transfer? Stock leaves the origin warehouse.',
    receive:  'Receive this transfer at its destination?',
    cancel:   'Cancel this draft transfer?',
};

const PAST_TENSE = { dispatch: 'dispatched', receive: 'received', cancel: 'cancelled' };

async function act(action, row) {
    if (!window.confirm(CONFIRMS[action])) return;
    mutationError.value = ''; okMsg.value = '';
    try {
        await store[action](row.transfer_no);
        okMsg.value = `Transfer #${row.transfer_no} ${PAST_TENSE[action]}.`;
        if (details.value[row.transfer_no]) {
            details.value = { ...details.value, [row.transfer_no]: await store.getTransfer(row.transfer_no) };
        }
    } catch (err) {
        mutationError.value = apiErrorMessage(err, `Failed to ${action} transfer`);
    }
}

// ── Expandable detail ─────────────────────────────────────────────────────────

// transfer_no → full transfer with lines. Keys stay strings: pg returns
// BIGSERIAL ids as strings, and TableComponent matches expandedKeys by ===.
const details      = ref({});
const expandedKeys = computed(() => Object.keys(details.value));

async function toggleDetail(row) {
    const key = row.transfer_no;
    if (details.value[key]) {
        const { [key]: _closed, ...rest } = details.value;
        details.value = rest;
        return;
    }
    try {
        details.value = { ...details.value, [key]: await store.getTransfer(key) };
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Failed to load transfer');
    }
}

const STATUS_PILL = { draft: '', dispatched: 'warn', received: 'ok', cancelled: '' };
const canManage   = computed(() => auth.hasPerm('inventory:transfer'));
const fmtTs       = ts => ts ? new Date(ts).toLocaleString() : '—';
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2>Stock Transfers</h2>
      <button v-if="canManage" class="btn btn-primary" @click="openCreate">+ New transfer</button>
    </div>

    <div v-if="store.error || mutationError" class="error">{{ store.error || mutationError }}</div>
    <p v-if="okMsg" class="pill ok">{{ okMsg }}</p>

    <div v-if="showCreate" class="card create">
      <div class="inline-form">
        <label>From
          <select v-model="form.from_warehouse_no" class="input">
            <option v-for="w in standardWhs" :key="w.warehouse_no" :value="w.warehouse_no">{{ w.code }}</option>
          </select>
        </label>
        <label>To
          <select v-model="form.to_warehouse_no" class="input">
            <option v-for="w in standardWhs" :key="w.warehouse_no" :value="w.warehouse_no">{{ w.code }}</option>
          </select>
        </label>
        <label>Via (transport)
          <select v-model="form.transport_warehouse_no" class="input">
            <option v-for="w in transportWhs" :key="w.warehouse_no" :value="w.warehouse_no">{{ w.code }}</option>
          </select>
        </label>
        <input v-model="form.carrier"     class="input" type="text" placeholder="Carrier" />
        <input v-model="form.tracking_no" class="input" type="text" placeholder="Tracking #" />
        <input v-model="form.manifest_id" class="input" type="text" placeholder="Manifest" />
        <input v-model="form.billing_no"  class="input" type="text" placeholder="Billing #" />
        <input v-model="form.notes"       class="input wide" type="text" placeholder="Notes" />
      </div>

      <div class="inline-form">
        <input v-model="lineDraft.q" class="input" type="text" placeholder="Search name or SKU…"
               @keyup.enter="searchVariants" />
        <button class="btn" @click="searchVariants">Search</button>
        <select v-if="lineDraft.matches.length" v-model="lineDraft.variant_no" class="input wide">
          <option v-for="m in lineDraft.matches" :key="m.variant_no" :value="m.variant_no">
            {{ m.sku }} — {{ m.product_name }} (avail {{ fixedNum(m.qty_available, 1) }})
          </option>
        </select>
        <input v-model.number="lineDraft.qty" class="input qty" type="number" min="0" step="0.25" placeholder="Qty" />
        <button class="btn" :disabled="!lineDraft.variant_no || !(lineDraft.qty > 0)" @click="addLine">Add line</button>
      </div>

      <table v-if="form.lines.length" class="table-plain inner">
        <thead><tr><th>SKU</th><th>Product</th><th>Qty</th><th></th></tr></thead>
        <tbody>
          <tr v-for="ln in form.lines" :key="ln.variant_no">
            <td>{{ ln.sku }}</td>
            <td>{{ ln.product_name }}</td>
            <td>{{ fixedNum(ln.qty, 2) }}</td>
            <td><button class="btn mini" @click="removeLine(ln.variant_no)">✕</button></td>
          </tr>
        </tbody>
      </table>

      <div class="inline-form">
        <button class="btn btn-primary" :disabled="!canCreate" @click="create">Create draft</button>
        <button class="btn" @click="showCreate = false">Close</button>
        <span v-if="form.from_warehouse_no && form.from_warehouse_no === form.to_warehouse_no" class="error">
          From and To must differ
        </span>
      </div>
    </div>

    <TableComponent
      :store="store"
      :rows="store.transfers"
      :displayFields="displayFields"
      rowKey="transfer_no"
      clickable
      :expandedKeys="expandedKeys"
      label="Transfers Found"
      @row-click="toggleDetail"
    >
      <template #filters>
        <label class="muted">Status
          <select v-model="store.query.status" class="input" @change="store.query.page = 1">
            <option value="">all</option>
            <option value="draft">draft</option>
            <option value="dispatched">dispatched</option>
            <option value="received">received</option>
            <option value="cancelled">cancelled</option>
          </select>
        </label>
      </template>

      <template #cell-route="{ row }">
        {{ row.from_code }} → {{ row.to_code }}
      </template>

      <template #cell-status="{ row }">
        <span class="pill" :class="STATUS_PILL[row.status]">{{ row.status }}</span>
      </template>

      <template #cell-carrier="{ row }">
        <span class="muted">{{ row.carrier || '—' }}<span v-if="row.tracking_no"> · {{ row.tracking_no }}</span></span>
      </template>

      <template #cell-_create_ts="{ row }">
        <span class="muted">{{ new Date(row._create_ts).toLocaleDateString() }}</span>
      </template>

      <template #row-actions="{ row }">
        <template v-if="canManage">
          <button v-if="row.status === 'draft'"      class="btn mini" @click="act('dispatch', row)">Dispatch</button>
          <button v-if="row.status === 'draft'"      class="btn mini" @click="act('cancel', row)">Cancel</button>
          <button v-if="row.status === 'dispatched'" class="btn mini" @click="act('receive', row)">Receive</button>
        </template>
      </template>

      <template #detail="{ row }">
        <div v-if="details[row.transfer_no]" class="detail">
          <p class="muted">
            Via {{ details[row.transfer_no].transport_code }}
            <span v-if="details[row.transfer_no].manifest_id"> · manifest {{ details[row.transfer_no].manifest_id }}</span>
            <span v-if="details[row.transfer_no].billing_no"> · billing {{ details[row.transfer_no].billing_no }}</span>
            · dispatched {{ fmtTs(details[row.transfer_no].dispatched_at) }}
            · received {{ fmtTs(details[row.transfer_no].received_at) }}
          </p>
          <p v-if="details[row.transfer_no].notes" class="muted">{{ details[row.transfer_no].notes }}</p>
          <table class="table-plain inner">
            <thead><tr><th>#</th><th>SKU</th><th>Product</th><th>Qty</th></tr></thead>
            <tbody>
              <tr v-for="ln in details[row.transfer_no].lines" :key="ln.ln_no">
                <td>{{ ln.ln_no }}</td>
                <td>{{ ln.sku }}</td>
                <td>{{ ln.product_name }}</td>
                <td>{{ fixedNum(ln.qty, 2) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <template #empty>No transfers found.</template>
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
.qty { width: 110px; }
.wide { min-width: 260px; }
.mini { padding: 0.1rem 0.5rem; font-size: 0.75rem; margin-right: 0.25rem; }
.inner { font-size: 0.82rem; margin-bottom: 0.5rem; }
.detail { padding: 0.25rem 0; p { margin: 0.15rem 0; } }
</style>
