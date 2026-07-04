<script setup>
import { ref, computed, onMounted } from 'vue';
import api from '@/services/api';
import { useAuthStore } from '@/stores/auth';
import { useUsersStore } from '@/stores/users';
import { usePagination } from '@/composables/usePagination';
import PaginationBar from '@/components/PaginationBar.vue';

const auth      = useAuthStore();
const store     = useUsersStore();
const errorMsg  = ref('');
const searchQ   = ref('');
const pageSize  = ref(25);

const totalPgs = computed(() => store.totalPgs);
const { pgArry } = usePagination(computed(() => store.curPg), totalPgs);

function fmtDate(val) { return val ? new Date(val).toLocaleDateString() : '—'; }

async function load(pg = store.curPg) {
    errorMsg.value = '';
    try {
        await store.getUsers(pg, searchQ.value, pageSize.value);
    } catch (err) {
        errorMsg.value = err.response?.data?.message || 'Failed to load users';
    }
}

function onSearch()       { load(1); }
function onGoto(pg)       { load(pg); }
function onPageSize(size) { pageSize.value = size; load(1); }

async function setRole(user, role) {
    if (store.saving) return;
    try {
        await store.updateUser(user.id, { role });
    } catch (err) {
        errorMsg.value = err.response?.data?.message || 'Failed to update role';
    }
}

async function toggleStatus(user) {
    if (store.saving) return;
    const newStatus = user.status === 'active' ? 'inactive' : 'active';
    try {
        await store.updateUser(user.id, { status: newStatus });
    } catch (err) {
        errorMsg.value = err.response?.data?.message || 'Failed to update status';
    }
}

async function deactivate(user) {
    if (!confirm(`Deactivate "${user.username}"? They will not be able to log in.`)) return;
    try {
        await store.deactivateUser(user.id);
    } catch (err) {
        errorMsg.value = err.response?.data?.message || 'Failed to deactivate user';
    }
}

const isSelf = (user) => user.id === auth.user?.id;

// Roles are data, not a hardcoded list — the RBAC tables define them.
const roles = ref([]);
async function loadRoles() {
    try {
        const res = await api.get('/api/v1/users/roles');
        roles.value = res.data.content.roles;
    } catch {
        roles.value = [{ code: 'customer' }, { code: 'admin' }];   // safe fallback
    }
}

onMounted(() => { load(); loadRoles(); });
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2>Users</h2>
      <div class="search-row">
        <input v-model="searchQ" type="text" placeholder="Search username or email…" @keyup.enter="onSearch" />
        <button class="btn-search" @click="onSearch">Search</button>
      </div>
    </div>

    <div v-if="errorMsg" class="error">{{ errorMsg }}</div>

    <PaginationBar
      :curPage="store.curPg"
      :totalPages="store.totalPgs"
      :totalCnt="store.totalCnt"
      :pageSize="pageSize"
      :pgArry="pgArry"
      label="Users Found"
      @goto="onGoto"
      @update:pageSize="onPageSize"
    />

    <div v-if="store.loadingCnt > 0" class="info">Loading…</div>
    <table v-else class="data-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Username</th>
          <th>Email</th>
          <th>Role</th>
          <th>Status</th>
          <th>Created</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="u in store.users" :key="u.id" :class="{ inactive: u.status === 'inactive', self: isSelf(u) }">
          <td>{{ u.id }}</td>
          <td>
            {{ u.username }}
            <span v-if="isSelf(u)" class="you-badge">you</span>
          </td>
          <td>{{ u.email || '—' }}</td>
          <td>
            <select
              :value="u.role"
              :disabled="isSelf(u) || store.saving === u.id"
              @change="setRole(u, $event.target.value)"
              class="role-select"
              :class="u.role">
              <option v-for="r in roles" :key="r.code" :value="r.code">{{ r.code }}</option>
            </select>
          </td>
          <td>
            <span class="status-pill" :class="u.status">{{ u.status }}</span>
          </td>
          <td>{{ fmtDate(u._create_ts) }}</td>
          <td class="actions">
            <button
              v-if="!isSelf(u)"
              class="btn-toggle"
              :class="u.status === 'active' ? 'btn-deactivate' : 'btn-activate'"
              :disabled="store.saving === u.id"
              @click="toggleStatus(u)">
              {{ u.status === 'active' ? 'Deactivate' : 'Activate' }}
            </button>
            <span v-else class="self-note">—</span>
          </td>
        </tr>
        <tr v-if="!store.users.length">
          <td colspan="7" class="empty">No users found.</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style lang="scss" scoped>
.view { display: flex; flex-direction: column; height: 100%; }

.view-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;
  h2 { margin: 0; color: #3a2060; }
}

.search-row {
  display: flex; gap: 0.5rem;
  input { padding: 0.35rem 0.6rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; width: 260px; }
}

.btn-search { padding: 0.35rem 0.9rem; background: #5a3e8a; color: #fff; border: none; border-radius: 4px; cursor: pointer; &:hover { background: #7a5ea8; } }
.error      { color: #c0392b; margin-bottom: 0.5rem; font-size: 0.9rem; }
.info       { color: #666; padding: 1rem; }

.data-table {
  width: 100%; border-collapse: collapse; font-size: 0.9rem;
  th { background: royalblue; color: #fff; text-align: left; padding: 0.4rem 0.6rem; position: sticky; top: 0; }
  td { padding: 0.35rem 0.6rem; border-bottom: 1px solid #eee; vertical-align: middle; }
  tr {
    &.inactive td { color: #bbb; }
    &.self td { background: rgba(90, 62, 138, 0.04); }
  }
  .empty { text-align: center; color: #999; padding: 1rem; }
}

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

.actions { white-space: nowrap; }

.btn-toggle {
  padding: 0.2rem 0.65rem; border: none; border-radius: 4px;
  font-size: 0.8rem; cursor: pointer;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
  &.btn-deactivate { background: #f8d7da; color: #721c24; &:hover:not(:disabled) { background: #f5c6cb; } }
  &.btn-activate   { background: #d4edda; color: #155724; &:hover:not(:disabled) { background: #c3e6cb; } }
}

.self-note { color: #bbb; font-size: 0.8rem; }
</style>
