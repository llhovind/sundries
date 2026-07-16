<script setup>
import { ref, computed, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useUsersStore } from '@/stores/users';
import { apiErrorMessage } from '@/stores/storeUtils';
import TableComponent from '@/components/TableComponent.vue';
import UserCreateModal from '@/components/UserCreateModal.vue';
import UserRolesModal from '@/components/UserRolesModal.vue';

const auth  = useAuthStore();
const store = useUsersStore();
onMounted(() => { store.getAll().catch(() => {}); store.loadRoles(); });

const displayFields = ['id', 'username', 'email', 'roles', 'status', '_create_ts'];

// ── Modals ───────────────────────────────────────────────────────────────────

const showCreate = ref(false);
const rolesUser  = ref(null);   // row whose roles are being managed

// ── Filters (bound to store.query — mutation triggers a refetch) ─────────────

function queryFilter(key) {
    return computed({
        get: () => store.query[key],
        set: (v) => { store.query[key] = v; store.query.page = 1; },
    });
}

const staffOnly    = queryFilter('staff');
const roleFilter   = queryFilter('role');
const statusFilter = queryFilter('status');

const mutationError = ref('');

const isSelf   = (user) => user.id === auth.user?.id;
const rowClass = (user) => ({ inactive: user.status === 'inactive', self: isSelf(user) });

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
      <button class="btn-add" @click="showCreate = true">+ Add User</button>
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
      <template #filters>
        <div class="filter-row">
          <label class="staff-toggle">
            <input type="checkbox" v-model="staffOnly" />
            Staff only
          </label>
          <select v-model="roleFilter" class="filter-select" aria-label="Filter by role">
            <option value="">All roles</option>
            <option v-for="r in store.roles" :key="r.code" :value="r.code">{{ r.name || r.code }}</option>
          </select>
          <select v-model="statusFilter" class="filter-select" aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
      </template>
      <template #cell-username="{ row }">
        {{ row.username }}
        <span v-if="isSelf(row)" class="you-badge">you</span>
      </template>

      <template #cell-roles="{ row }">
        <span
          v-for="code in row.roles" :key="code"
          class="role-chip"
          :class="{ primary: code === row.role }"
          :title="code === row.role ? 'Primary role' : 'Additional role'">
          {{ code }}
        </span>
      </template>

      <template #cell-status="{ row }">
        <span class="status-pill" :class="row.status">{{ row.status }}</span>
      </template>

      <template #row-actions="{ row }">
        <button
          class="btn-roles"
          :disabled="store.saving === row.id"
          @click="rolesUser = row">
          Roles
        </button>
        <button
          v-if="!isSelf(row)"
          class="btn-toggle"
          :class="row.status === 'active' ? 'btn-deactivate' : 'btn-activate'"
          :disabled="store.saving === row.id"
          @click="toggleStatus(row)">
          {{ row.status === 'active' ? 'Deactivate' : 'Activate' }}
        </button>
      </template>

      <template #empty>No users found.</template>
    </TableComponent>

    <UserCreateModal v-if="showCreate" @close="showCreate = false" />
    <UserRolesModal
      v-if="rolesUser"
      :user="rolesUser"
      :isSelf="isSelf(rolesUser)"
      @close="rolesUser = null"
    />
  </div>
</template>

<style lang="scss" scoped>
.view { display: flex; flex-direction: column; height: 100%; }

.view-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;
  h2 { margin: 0; color: #3a2060; }
}

.btn-add {
  padding: 0.35rem 0.9rem; background: #5a3e8a; color: #fff;
  border: none; border-radius: 4px; cursor: pointer; font-size: 0.85rem;
  &:hover { background: #7a5ea8; }
}

.error { color: #c0392b; margin-bottom: 0.5rem; font-size: 0.9rem; }

.filter-row {
  display: flex; gap: 0.75rem; align-items: center;
}

.staff-toggle {
  display: flex; gap: 0.35rem; align-items: center;
  font-size: 0.85rem; color: #3a2060; cursor: pointer; white-space: nowrap;
  input { cursor: pointer; }
}

.filter-select {
  padding: 0.3rem 0.5rem; border: 1px solid #ccc; border-radius: 4px;
  font-size: 0.85rem; background: #fff; cursor: pointer;
}

:deep(tr.inactive td) { color: #bbb; }
:deep(tr.self td)     { background: rgba(90, 62, 138, 0.04); }

.you-badge {
  display: inline-block; font-size: 0.65rem; background: #5a3e8a; color: #fff;
  padding: 0.1rem 0.35rem; border-radius: 10px; margin-left: 0.4rem; vertical-align: middle;
}

.role-chip {
  display: inline-block; font-size: 0.72rem; padding: 0.15rem 0.5rem;
  border-radius: 10px; margin-right: 0.3rem;
  background: #f0f4ff; color: #1a3a70; border: 1px solid #b0c4de;
  &.primary { background: #ede8f8; color: #3a2060; border-color: #b0a0e0; font-weight: 600; }
}

.btn-roles {
  padding: 0.2rem 0.65rem; border: 1px solid #9b86c8; border-radius: 4px;
  background: none; color: #5a3e8a; font-size: 0.8rem; cursor: pointer;
  margin-right: 0.35rem;
  &:hover:not(:disabled) { background: #ede8f8; }
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
</style>
