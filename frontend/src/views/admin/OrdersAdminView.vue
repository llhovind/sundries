<script setup>
import { ref, computed, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useOrdersStore } from '@/stores/orders';
import { apiErrorMessage } from '@/stores/storeUtils';
import { fixedNum } from '@/composables/utils';
import TableComponent from '@/components/TableComponent.vue';

const auth  = useAuthStore();
const store = useOrdersStore();
onMounted(() => store.getAll().catch(() => {}));

const displayFields = ['ord_no', 'placed_at', 'customer_name', 'status', 'total'];

const STATUSES = ['pending_payment', 'paid', 'processing', 'partially_shipped', 'shipped',
                  'completed', 'cancelled', 'payment_failed'];

const STATUS_PILL = {
    pending_payment: 'warn', paid: 'accent', processing: 'accent', partially_shipped: 'warn',
    shipped: 'ok', completed: 'ok', cancelled: '', payment_failed: 'danger',
};

// partially_shipped: the restock job has filled (some) backorders — shipping
// again sends whatever is now reserved.
const SHIPPABLE = ['paid', 'processing', 'partially_shipped'];

const mutationError = ref('');
const busy          = ref(null);

// ── Expandable order detail (lazy-fetched per order) ─────────────────────────

const expanded     = ref({});   // ord_no → full order
const expandedKeys = computed(() =>
    store.orders.filter(o => expanded.value[o.ord_no]).map(o => o.ord_no));

async function toggleDetail(order) {
    const key = order.ord_no;
    if (expanded.value[key]) { delete expanded.value[key]; return; }
    try {
        expanded.value = { ...expanded.value, [key]: await store.getOrder(key) };
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Failed to load order detail');
    }
}

// ── Ship: package details (all optional) confirmed in the expanded detail ────

const shipForm = ref(null);   // { ord_no, carrier, tracking_no, notes }

async function openShipForm(row) {
    mutationError.value = '';
    shipForm.value = { ord_no: row.ord_no, carrier: '', tracking_no: '', notes: '' };
    if (!expanded.value[row.ord_no]) await toggleDetail(row);
}

async function confirmShip() {
    const { ord_no, ...details } = shipForm.value;
    busy.value = ord_no;
    mutationError.value = '';
    try {
        await store.shipOrder(ord_no, details);
        shipForm.value = null;
        expanded.value = { ...expanded.value, [ord_no]: await store.getOrder(ord_no) };
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Ship failed');
    } finally {
        busy.value = null;
    }
}

// ── Edit tracking on an existing shipment ────────────────────────────────────

const editShipment = ref(null);   // { ord_no, shipment_no, carrier, tracking_no, notes }

function startEditShipment(ordNo, s) {
    editShipment.value = {
        ord_no: ordNo, shipment_no: s.shipment_no,
        carrier: s.carrier || '', tracking_no: s.tracking_no || '', notes: s.notes || '',
    };
}

async function saveShipment() {
    const { ord_no, shipment_no, ...details } = editShipment.value;
    mutationError.value = '';
    try {
        await store.updateShipment(ord_no, shipment_no, details);
        editShipment.value = null;
        expanded.value = { ...expanded.value, [ord_no]: await store.getOrder(ord_no) };
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Shipment update failed');
    }
}

const fmtTs = ts => new Date(ts).toLocaleString();
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2>Orders</h2>
    </div>

    <div v-if="store.error || mutationError" class="error">{{ store.error || mutationError }}</div>

    <TableComponent
      :store="store"
      :rows="store.orders"
      :displayFields="displayFields"
      rowKey="ord_no"
      clickable
      :expandedKeys="expandedKeys"
      label="Orders Found"
      @row-click="toggleDetail"
    >
      <template #filters>
        <div class="filter-row">
          <select v-model="store.query.status" class="input" @change="store.query.page = 1">
            <option value="">All statuses</option>
            <option v-for="s in STATUSES" :key="s" :value="s">{{ s.replace('_', ' ') }}</option>
          </select>
        </div>
      </template>

      <template #cell-customer_name="{ row }">
        {{ row.customer_name }} <span class="muted">({{ row.email }})</span>
      </template>

      <template #cell-status="{ row }">
        <span class="pill" :class="STATUS_PILL[row.status]">{{ row.status.replace('_', ' ') }}</span>
      </template>

      <template #row-actions="{ row }">
        <button v-if="SHIPPABLE.includes(row.status) && auth.hasPerm('orders:fulfill')"
                class="btn btn-primary ship" :disabled="busy === row.ord_no"
                @click.stop="openShipForm(row)">
          {{ busy === row.ord_no ? 'Shipping…' : 'Ship…' }}
        </button>
      </template>

      <template #detail="{ row }">
        <div class="order-detail">
          <p v-if="expanded[row.ord_no].fraud_flag" class="pill danger">
            ⚑ Flagged for review: {{ expanded[row.ord_no].fraud_notes }}
          </p>
          <ul class="lines">
            <li v-for="ln in expanded[row.ord_no].lines" :key="ln.id">
              <span>{{ ln.sku }} — {{ ln.descr }} × {{ ln.qty }}</span>
              <span class="pill">{{ ln.fulfillment_status }}</span>
              <span>$ {{ fixedNum(ln.line_total, 2) }}</span>
            </li>
          </ul>
          <p class="muted small">
            Payments:
            <span v-for="p in expanded[row.ord_no].payments" :key="p.payment_no">
              {{ p.provider }} {{ p.status }} $ {{ fixedNum(p.amount, 2) }}&nbsp;
            </span>
            · Ship to {{ expanded[row.ord_no].ship_name }},
            {{ expanded[row.ord_no].ship_city }} {{ expanded[row.ord_no].ship_state }}
          </p>

          <div v-if="shipForm && shipForm.ord_no === row.ord_no" class="ship-form">
            <input v-model="shipForm.carrier"     class="input" type="text" placeholder="Carrier (optional)" />
            <input v-model="shipForm.tracking_no" class="input" type="text" placeholder="Tracking # (optional)" />
            <input v-model="shipForm.notes"       class="input" type="text" placeholder="Notes (optional)" />
            <button class="btn btn-primary ship" :disabled="busy === row.ord_no" @click="confirmShip">
              {{ busy === row.ord_no ? 'Shipping…' : 'Confirm ship + capture' }}
            </button>
            <button class="btn ship" @click="shipForm = null">Cancel</button>
          </div>

          <div v-if="expanded[row.ord_no].shipments?.length" class="shipments">
            <p class="muted small shipments-title">Shipments</p>
            <div v-for="s in expanded[row.ord_no].shipments" :key="s.shipment_no" class="shipment">
              <template v-if="editShipment && editShipment.shipment_no === s.shipment_no">
                <input v-model="editShipment.carrier"     class="input" type="text" placeholder="Carrier" />
                <input v-model="editShipment.tracking_no" class="input" type="text" placeholder="Tracking #" />
                <input v-model="editShipment.notes"       class="input" type="text" placeholder="Notes" />
                <button class="btn btn-primary ship" @click="saveShipment">Save</button>
                <button class="btn ship" @click="editShipment = null">Cancel</button>
              </template>
              <template v-else>
                <span class="small">
                  #{{ s.shipment_no }} · {{ fmtTs(s.shipped_at) }}
                  · {{ s.carrier || 'no carrier' }}
                  · {{ s.tracking_no ? `tracking ${s.tracking_no}` : 'no tracking' }}
                  <span v-if="s.notes" class="muted"> · {{ s.notes }}</span>
                </span>
                <span class="muted small">{{ s.lines.map(l => `${l.sku} × ${l.qty}`).join(', ') }}</span>
                <button v-if="auth.hasPerm('orders:fulfill')" class="btn ship"
                        @click="startEditShipment(row.ord_no, s)">Edit</button>
              </template>
            </div>
          </div>
        </div>
      </template>

      <template #empty>No orders found.</template>
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
.filter-row { display: flex; gap: 0.5rem; align-items: center; }
.ship { padding: 0.15rem 0.6rem; font-size: 0.78rem; }
.ship-form { display: flex; gap: 0.5rem; align-items: center; margin: 0.4rem 0; flex-wrap: wrap; }
.shipments { margin-top: 0.4rem; }
.shipments-title { margin: 0 0 0.2rem; text-transform: uppercase; letter-spacing: 0.04em; }
.shipment { display: flex; gap: 0.75rem; align-items: center; padding: 0.15rem 0; flex-wrap: wrap; }
.lines { list-style: none; padding: 0.2rem 0; }
.lines li { display: flex; gap: 1rem; align-items: center; padding: 0.2rem 0; }
.lines li span:last-child { margin-left: auto; }
.small { font-size: 0.78rem; }
</style>
