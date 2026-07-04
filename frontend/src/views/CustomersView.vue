<script setup>
import { ref, watch, onMounted } from 'vue';
import { useCustomersStore } from '@/stores/customers';
import TableComponent from '@/components/TableComponent.vue';

const store    = useCustomersStore();
onMounted(() => store.getAll().catch(() => {}));
const selected = ref(null);

const displayFields = ['id', 'name', 'email', 'city', 'state', 'phone'];

// When TableComponent emits a new single-select row, fetch full customer detail
const selectedRows = ref([]);
watch(selectedRows, async (rows) => {
    if (!rows.length) { selected.value = null; return; }
    try {
        selected.value = await store.getCustomer(rows[0].id);
    } catch {
        selected.value = rows[0]; // fallback to list data
    }
});

function fmtDate(val) { return val ? new Date(val).toLocaleDateString() : '—'; }
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2>Customers</h2>
    </div>

    <div v-if="store.error" class="error">{{ store.error }}</div>

    <div class="split-pane">
      <!-- List -->
      <div class="list-pane">
        <TableComponent
          :store="store"
          :rows="store.customers"
          :displayFields="displayFields"
          selectable="single"
          v-model:selected="selectedRows"
          searchPlaceholder="Search name or email…"
          label="Customers Found"
        />
      </div>

      <!-- Detail panel -->
      <div class="detail-pane" v-if="selected">
        <div class="detail-header">
          <div class="detail-title">{{ selected.name }}</div>
          <button class="close-detail" @click="selectedRows = []">&times;</button>
        </div>
        <div class="detail-body">
          <div class="field-row"><label>ID</label><span>{{ selected.id }}</span></div>
          <div class="field-row"><label>Email</label><span>{{ selected.email || '—' }}</span></div>
          <div class="field-row"><label>Phone</label><span>{{ selected.phone || '—' }}</span></div>
          <div v-if="selected.address" class="field-row"><label>Address</label>
            <span>{{ selected.address }}<br v-if="selected.city" />
              {{ [selected.city, selected.state, selected.zip].filter(Boolean).join(', ') }}
              <span v-if="selected.country"> {{ selected.country }}</span>
            </span>
          </div>
          <div v-if="selected.notes" class="field-row"><label>Notes</label><span>{{ selected.notes }}</span></div>
          <div class="field-row timestamps">
            <label>Created</label><span>{{ fmtDate(selected._create_ts) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.view { display: flex; flex-direction: column; height: 100%; }
.view-header {
  display: flex; align-items: center; margin-bottom: 0.75rem;
  h2 { margin: 0; color: #3a2060; }
}
.error { color: #c0392b; margin-bottom: 0.5rem; font-size: 0.9rem; }

.split-pane { display: flex; gap: 1rem; flex: 1; min-height: 0; }
.list-pane  { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.detail-pane { width: 320px; flex-shrink: 0; border: 1px solid #ddd; border-radius: 6px; padding: 0.75rem; overflow-y: auto; background: #fafafa; }

.detail-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem; }
.detail-title { font-weight: bold; color: #3a2060; font-size: 1rem; }
.close-detail { background: none; border: none; font-size: 1.3rem; cursor: pointer; color: #888; line-height: 1; }
.detail-body { display: flex; flex-direction: column; gap: 0.4rem; }
.field-row {
  display: grid; grid-template-columns: 5rem 1fr; gap: 0 0.5rem; font-size: 0.88rem;
  label { color: #888; font-size: 0.78rem; text-transform: uppercase; padding-top: 0.1rem; }
  &.timestamps { margin-top: 0.5rem; color: #aaa; }
}
</style>
