<script setup>
import { ref, computed, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useRmasStore } from '@/stores/rmas';
import { apiErrorMessage } from '@/stores/storeUtils';
import { fixedNum } from '@/composables/utils';
import TableComponent from '@/components/TableComponent.vue';

const auth  = useAuthStore();
const store = useRmasStore();
onMounted(() => store.getAll().catch(() => {}));

const displayFields = ['rma_no', '_ord_no', 'customer_name', 'status', 'reason', 'line_count', '_create_ts'];

const canManage = computed(() => auth.hasPerm('rma:manage'));
const canRefund = computed(() => auth.hasPerm('refunds:create'));

const mutationError = ref('');
const okMsg         = ref('');

// ── Expandable detail + per-RMA working state ─────────────────────────────────

// rma_no → full RMA with lines. Keys stay strings: pg returns BIGSERIAL ids
// as strings, and TableComponent matches expandedKeys by ===.
const details      = ref({});
const notesDraft   = ref({});   // rma_no → staff notes for approve/reject
const restockDraft = ref({});   // rma_line_id → restock on receive
const refundDraft  = ref({});   // rma_no → { amount, reason }
const expandedKeys = computed(() => Object.keys(details.value));

async function toggleDetail(row) {
    const key = row.rma_no;
    if (details.value[key]) {
        const { [key]: _closed, ...rest } = details.value;
        details.value = rest;
        return;
    }
    await refreshDetail(key);
}

async function refreshDetail(rmaNo) {
    try {
        const rma = await store.getRma(rmaNo);
        details.value = { ...details.value, [rmaNo]: rma };
        rma.lines.forEach(l => {
            if (restockDraft.value[l.id] === undefined) restockDraft.value[l.id] = true;
        });
        if (!refundDraft.value[rmaNo]) {
            // Prefilled with what the customer paid; Finance may override.
            refundDraft.value = { ...refundDraft.value,
                [rmaNo]: { amount: rma.suggested_refund, reason: 'RMA refund' } };
        }
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Failed to load return');
    }
}

async function run(label, fn, rmaNo) {
    mutationError.value = ''; okMsg.value = '';
    try {
        await fn();
        okMsg.value = label;
        if (details.value[rmaNo]) await refreshDetail(rmaNo);
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Action failed');
    }
}

const transition = (row, status) => run(
    `Return #${row.rma_no} ${status}.`,
    () => store.updateStatus(row.rma_no, status, notesDraft.value[row.rma_no] || null),
    row.rma_no);

const receive = (rma) => run(
    `Return #${rma.rma_no} received.`,
    () => store.receiveRma(rma.rma_no,
        rma.lines.map(l => ({ rma_line_id: l.id, restock: !!restockDraft.value[l.id] }))),
    rma.rma_no);

const refund = (rma) => {
    const draft = refundDraft.value[rma.rma_no] || {};
    return run(
        `Return #${rma.rma_no} refunded.`,
        () => store.refundRma(rma.rma_no, draft.amount, draft.reason || 'RMA refund'),
        rma.rma_no);
};

const STATUS_PILL = { requested: 'warn', approved: 'accent', received: 'accent',
                      refunded: 'ok', rejected: 'danger', closed: '' };
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2>Returns</h2>
    </div>

    <div v-if="store.error || mutationError" class="error">{{ store.error || mutationError }}</div>
    <p v-if="okMsg" class="pill ok">{{ okMsg }}</p>

    <TableComponent
      :store="store"
      :rows="store.rmas"
      :displayFields="displayFields"
      rowKey="rma_no"
      clickable
      :expandedKeys="expandedKeys"
      label="Returns Found"
      @row-click="toggleDetail"
    >
      <template #filters>
        <label class="muted">Status
          <select v-model="store.query.status" class="input" @change="store.query.page = 1">
            <option value="">all</option>
            <option v-for="s in ['requested', 'approved', 'received', 'refunded', 'rejected', 'closed']"
                    :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
      </template>

      <template #cell-status="{ row }">
        <span class="pill" :class="STATUS_PILL[row.status]">{{ row.status }}</span>
      </template>

      <template #cell-_create_ts="{ row }">
        <span class="muted">{{ new Date(row._create_ts).toLocaleDateString() }}</span>
      </template>

      <template #detail="{ row }">
        <div v-if="details[row.rma_no]" class="detail">
          <p class="muted">
            Order #{{ details[row.rma_no]._ord_no }} · {{ details[row.rma_no].order_email }}
            <span v-if="details[row.rma_no].reason"> · reason: {{ details[row.rma_no].reason }}</span>
            <span v-if="details[row.rma_no].notes"> · notes: {{ details[row.rma_no].notes }}</span>
          </p>

          <table class="table-plain inner">
            <thead>
              <tr>
                <th>Line</th><th>SKU</th><th>Item</th><th>Qty</th><th>Condition</th>
                <th v-if="canManage && details[row.rma_no].status === 'approved'">Restock?</th>
                <th v-else>Restocked</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ln in details[row.rma_no].lines" :key="ln.id">
                <td>{{ ln.ln_no }}</td>
                <td>{{ ln.sku }}</td>
                <td>{{ ln.descr }}</td>
                <td>{{ fixedNum(ln.qty, 2) }}</td>
                <td>{{ ln.condition || '—' }}</td>
                <td v-if="canManage && details[row.rma_no].status === 'approved'">
                  <input v-model="restockDraft[ln.id]" type="checkbox"
                         title="Uncheck for damaged goods — recorded but written off" />
                </td>
                <td v-else>{{ ln.restock ? 'yes' : 'no' }}</td>
              </tr>
            </tbody>
          </table>

          <!-- Lifecycle actions, by state -->
          <div v-if="canManage && details[row.rma_no].status === 'requested'" class="inline-form">
            <input v-model="notesDraft[row.rma_no]" class="input wide" type="text"
                   placeholder="Notes (visible to staff)" />
            <button class="btn btn-primary mini" @click="transition(row, 'approved')">Approve</button>
            <button class="btn mini" @click="transition(row, 'rejected')">Reject</button>
          </div>

          <div v-if="canManage && details[row.rma_no].status === 'approved'" class="inline-form">
            <button class="btn btn-primary mini" @click="receive(details[row.rma_no])">
              Receive return
            </button>
            <span class="muted">Checked lines restock at their original cost; unchecked are written off.</span>
          </div>

          <div v-if="details[row.rma_no].status === 'received'" class="inline-form">
            <template v-if="canRefund">
              <label class="muted">Refund $
                <input v-model.number="refundDraft[row.rma_no].amount" class="input num"
                       type="number" min="0" step="0.01" />
              </label>
              <input v-model="refundDraft[row.rma_no].reason" class="input wide" type="text"
                     placeholder="Refund reason" />
              <button class="btn btn-primary mini" @click="refund(details[row.rma_no])">Refund</button>
              <span class="muted">Suggested: $ {{ fixedNum(details[row.rma_no].suggested_refund, 2) }}
                (amount paid for the returned items)</span>
            </template>
            <span v-else class="muted">Awaiting Finance (refunds:create) for the refund.</span>
            <button v-if="canManage" class="btn mini" @click="transition(row, 'closed')">Close without refund</button>
          </div>

          <div v-if="canManage && details[row.rma_no].status === 'refunded'" class="inline-form">
            <button class="btn mini" @click="transition(row, 'closed')">Close</button>
          </div>
        </div>
      </template>

      <template #empty>No returns found.</template>
    </TableComponent>
  </div>
</template>

<style lang="scss" scoped>
.view { display: flex; flex-direction: column; height: 100%; }
.view-header {
  display: flex; align-items: center; margin-bottom: 0.75rem;
  h2 { margin: 0; color: #3a2060; }
}
.error { color: #c0392b; font-size: 0.9rem; }
.inline-form {
  display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin: 0.4rem 0;
  label { display: flex; flex-direction: column; font-size: 0.75rem; color: #666; }
}
.num { width: 120px; }
.wide { min-width: 240px; }
.mini { padding: 0.1rem 0.5rem; font-size: 0.75rem; }
.inner { font-size: 0.82rem; margin-bottom: 0.4rem; }
.detail { padding: 0.25rem 0; p { margin: 0.15rem 0; } }
</style>
