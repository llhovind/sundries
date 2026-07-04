<script setup>
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useUsersStore } from '@/stores/users';
import { apiErrorMessage } from '@/stores/storeUtils';
import TableComponent from '@/components/TableComponent.vue';

const auth  = useAuthStore();
const store = useUsersStore();
onMounted(() => { store.getAll().catch(() => {}); store.loadRoles(); });

const displayFields = ['id', 'username', 'email', 'role', 'status', '_create_ts'];

const mutationError = ref('');

const isSelf   = (user) => user.id === auth.user?.id;
const rowClass = (user) => ({ inactive: user.status === 'inactive', self: isSelf(user) });

async function setRole(user, role) {
    if (store.saving) return;
    mutationError.value = '';
    try {
        await store.updateUser(user.id, { role });
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Failed to update role');
    }
}

async function toggleStatus(user) {
    if (store.saving) return;
    mutationError.value = '';
    const newStatus = user.status === 'active' ? 'inactive' : 'active';
    try {
        await store.updateUser(user.id, { status: newStatus });
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Failed to update status');
    }
}
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2>Users</h2>
    </div>

    <div v-if="store.error || mutationError" class="error">{{ store.error || mutationError }}</div>

    <TableComponent
      :store="store"
      :rows="store.users"
      :displayFields="displayFields"
      :rowClass="rowClass"
      searchPlaceholder="Search username or email…"
      label="Users Found"
    >
      <template #cell-username="{ row }">
        {{ row.username }}
        <span v-if="isSelf(row)" class="you-badge">you</span>
      </template>

      <template #cell-role="{ row }">
        <select
          :value="row.role"
          :disabled="isSelf(row) || store.saving === row.id"
          @change="setRole(row, $event.target.value)"
          class="role-select"
          :class="row.role">
          <option v-for="r in store.roles" :key="r.code" :value="r.code">{{ r.code }}</option>
        </select>
      </template>

      <template #cell-status="{ row }">
        <span class="status-pill" :class="row.status">{{ row.status }}</span>
      </template>

      <template #row-actions="{ row }">
        <button
          v-if="!isSelf(row)"
          class="btn-toggle"
          :class="row.status === 'active' ? 'btn-deactivate' : 'btn-activate'"
          :disabled="store.saving === row.id"
          @click="toggleStatus(row)">
          {{ row.status === 'active' ? 'Deactivate' : 'Activate' }}
        </button>
        <span v-else class="self-note">—</span>
      </template>

      <template #empty>No users found.</template>
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

:deep(tr.inactive td) { color: #bbb; }
:deep(tr.self td)     { background: rgba(90, 62, 138, 0.04); }

.you-badge {
  display: inline-block; font-size: 0.65rem; background: #5a3e8a; color: #fff;
  padding: 0.1rem 0.35rem; border-radius: 10px; margin-left: 0.4rem; vertical-align: middle;
}

.role-select {
  padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.82rem; border: 1px solid #ccc;
  cursor: pointer;
  &.admin    { background: #ede8f8; color: #3a2060; border-color: #b0a0e0; }
  &.customer { background: #f0f4ff; color: #1a3a70; border-color: #b0c4de; }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}

.status-pill {
  display: inline-block; font-size: 0.72rem; padding: 0.15rem 0.5rem;
  border-radius: 10px; font-weight: 600; text-transform: uppercase;
  &.active   { background: #d4edda; color: #155724; }
  &.inactive { background: #f8d7da; color: #721c24; }
}

.btn-toggle {
  padding: 0.2rem 0.65rem; border: none; border-radius: 4px;
  font-size: 0.8rem; cursor: pointer;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
  &.btn-deactivate { background: #f8d7da; color: #721c24; &:hover:not(:disabled) { background: #f5c6cb; } }
  &.btn-activate   { background: #d4edda; color: #155724; &:hover:not(:disabled) { background: #c3e6cb; } }
}

.self-note { color: #bbb; font-size: 0.8rem; }
</style>
