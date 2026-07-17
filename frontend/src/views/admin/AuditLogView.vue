<script setup>
import { ref, computed, onMounted } from 'vue';
import { useAuditLogStore } from '@/stores/auditLog';
import TableComponent from '@/components/TableComponent.vue';

const store = useAuditLogStore();
onMounted(() => {
    store.getAll().catch(() => {});
    store.loadEntities().catch(() => {});
});

const displayFields = ['ts', 'actor', 'action', 'entity', 'entity_id', 'ip'];

// ── Expandable detail ─────────────────────────────────────────────────────────

// Keys stay strings: pg returns BIGSERIAL ids as strings, and TableComponent
// matches expandedKeys by ===.
const expanded     = ref(new Set());
const expandedKeys = computed(() => [...expanded.value]);

function toggleDetail(row) {
    const next = new Set(expanded.value);
    next.has(row.audit_no) ? next.delete(row.audit_no) : next.add(row.audit_no);
    expanded.value = next;
}

/**
 * For UPDATE rows: only the fields that actually changed, as old → new pairs.
 * INSERT/DELETE render the full snapshot instead.
 */
function changedFields(row) {
    const oldData = row.old_data || {};
    const newData = row.new_data || {};
    return [...new Set([...Object.keys(oldData), ...Object.keys(newData)])]
        .filter(key => JSON.stringify(oldData[key]) !== JSON.stringify(newData[key]))
        .map(key => ({ key, from: fmtVal(oldData[key]), to: fmtVal(newData[key]) }));
}

const fmtVal   = v => v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const fmtJson  = data => JSON.stringify(data, null, 2);
const fmtTs    = ts => new Date(ts).toLocaleString();
const actorFor = row => row.actor_username || row.actor_email || (row.actor_user_id ? `user #${row.actor_user_id}` : 'system');

const ACTION_PILL = { INSERT: 'ok', UPDATE: '', DELETE: 'warn' };
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2>Audit Log</h2>
    </div>

    <div v-if="store.error" class="error">{{ store.error }}</div>

    <TableComponent
      :store="store"
      :rows="store.entries"
      :displayFields="displayFields"
      rowKey="audit_no"
      clickable
      :expandedKeys="expandedKeys"
      label="Entries Found"
      searchPlaceholder="Search record id, request id, actor…"
      @row-click="toggleDetail"
    >
      <template #filters>
        <label class="muted">Entity
          <select v-model="store.query.entity" class="input" @change="store.query.page = 1">
            <option value="">all</option>
            <option v-for="e in store.entities" :key="e" :value="e">{{ e }}</option>
          </select>
        </label>
        <label class="muted">Action
          <select v-model="store.query.action" class="input" @change="store.query.page = 1">
            <option value="">all</option>
            <option value="INSERT">INSERT</option>
            <option value="UPDATE">UPDATE</option>
            <option value="DELETE">DELETE</option>
          </select>
        </label>
        <label class="muted">From
          <input v-model="store.query.from" class="input" type="date" @change="store.query.page = 1" />
        </label>
        <label class="muted">To
          <input v-model="store.query.to" class="input" type="date" @change="store.query.page = 1" />
        </label>
      </template>

      <template #cell-ts="{ row }">
        <span class="muted">{{ fmtTs(row.ts) }}</span>
      </template>

      <template #cell-actor="{ row }">
        {{ actorFor(row) }}
      </template>

      <template #cell-action="{ row }">
        <span class="pill" :class="ACTION_PILL[row.action]">{{ row.action }}</span>
      </template>

      <template #cell-ip="{ row }">
        <span class="muted">{{ row.ip || '—' }}</span>
      </template>

      <template #detail="{ row }">
        <div class="detail">
          <p class="muted">
            Actor {{ actorFor(row) }}
            <span v-if="row.actor_user_id"> (#{{ row.actor_user_id }})</span>
            <span v-if="row.correlation_id"> · request {{ row.correlation_id }}</span>
            <span v-if="row.ip"> · from {{ row.ip }}</span>
          </p>

          <table v-if="row.action === 'UPDATE'" class="table-plain inner">
            <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
            <tbody>
              <tr v-for="chg in changedFields(row)" :key="chg.key">
                <td>{{ chg.key }}</td>
                <td class="val">{{ chg.from }}</td>
                <td class="val">{{ chg.to }}</td>
              </tr>
            </tbody>
          </table>

          <pre v-else class="snapshot">{{ fmtJson(row.action === 'DELETE' ? row.old_data : row.new_data) }}</pre>
        </div>
      </template>

      <template #empty>No audit entries found.</template>
    </TableComponent>
  </div>
</template>

<style lang="scss" scoped>
.snapshot {
    margin: 0.5rem 0 0;
    padding: 0.75rem;
    max-height: 20rem;
    overflow: auto;
    font-size: 0.8rem;
    border: 1px solid var(--border, #e2e8f0);
    border-radius: 6px;
}

.val {
    max-width: 24rem;
    overflow-wrap: anywhere;
}
</style>
