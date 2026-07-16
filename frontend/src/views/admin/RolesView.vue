<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { useRolesStore } from '@/stores/roles';
import { apiErrorMessage } from '@/stores/storeUtils';

const store = useRolesStore();

// Mirrors Rbac.LOCKED_ROLES on the backend (which enforces it): admin keeps
// full access, customer defines the storefront baseline.
const LOCKED_ROLES = ['admin', 'customer'];

const error        = ref('');
const selectedCode = ref('');

onMounted(async () => {
    try {
        await store.load();
        selectedCode.value = store.roles[0]?.code ?? '';
    } catch (err) {
        error.value = apiErrorMessage(err, 'Failed to load roles');
    }
});

const selected = computed(() => store.roles.find(r => r.code === selectedCode.value) ?? null);
const isLocked = computed(() => selected.value && LOCKED_ROLES.includes(selected.value.code));

// ── Permission groups (by "area:" prefix) ────────────────────────────────────

const permGroups = computed(() => {
    const groups = new Map();
    for (const p of store.permissions) {
        const area = p.code.split(':')[0];
        if (!groups.has(area)) groups.set(area, []);
        groups.get(area).push(p);
    }
    return [...groups.entries()].map(([area, perms]) => ({ area, perms }));
});

// ── Drafts (reset whenever the selection or its saved state changes) ─────────

const nameDraft  = ref('');
const descrDraft = ref('');
const permDraft  = ref(new Set());

watch(selected, (role) => {
    error.value      = '';
    nameDraft.value  = role?.name ?? '';
    descrDraft.value = role?.descr ?? '';
    permDraft.value  = new Set(role?.permissions ?? []);
}, { immediate: true });

const nameDirty = computed(() =>
    selected.value &&
    (nameDraft.value !== selected.value.name || descrDraft.value !== (selected.value.descr ?? '')));

const permsDirty = computed(() => {
    if (!selected.value) return false;
    const saved = selected.value.permissions;
    return permDraft.value.size !== saved.length || saved.some(p => !permDraft.value.has(p));
});

function togglePerm(code) {
    if (isLocked.value) return;
    const next = new Set(permDraft.value);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    permDraft.value = next;
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function saveName() {
    error.value = '';
    try {
        await store.updateRole(selected.value.code, { name: nameDraft.value, descr: descrDraft.value });
    } catch (err) {
        error.value = apiErrorMessage(err, 'Failed to rename role');
    }
}

async function savePerms() {
    error.value = '';
    try {
        await store.setPermissions(selected.value.code, [...permDraft.value]);
    } catch (err) {
        error.value = apiErrorMessage(err, 'Failed to save permissions');
    }
}

function resetPerms() {
    permDraft.value = new Set(selected.value?.permissions ?? []);
}

const canDelete = computed(() =>
    selected.value && !selected.value.is_system && selected.value.user_count === 0);

async function removeRole() {
    error.value = '';
    try {
        await store.deleteRole(selected.value.code);
        selectedCode.value = store.roles[0]?.code ?? '';
    } catch (err) {
        error.value = apiErrorMessage(err, 'Failed to delete role');
    }
}

// ── New role form ─────────────────────────────────────────────────────────────

const showCreate  = ref(false);
const createError = ref('');
const createForm  = reactive({ code: '', name: '', descr: '' });

async function createRole() {
    createError.value = '';
    if (!createForm.code || !createForm.name) {
        createError.value = 'Code and name are required';
        return;
    }
    try {
        const role = await store.createRole({ ...createForm });
        selectedCode.value = role.code;
        showCreate.value = false;
        createForm.code = createForm.name = createForm.descr = '';
    } catch (err) {
        createError.value = apiErrorMessage(err, 'Failed to create role');
    }
}
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2>Roles &amp; Permissions</h2>
      <button class="btn-add" @click="showCreate = true">+ New Role</button>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div class="layout">
      <!-- Role list -->
      <ul class="role-list">
        <li
          v-for="r in store.roles" :key="r.code"
          :class="{ active: r.code === selectedCode }"
          @click="selectedCode = r.code"
        >
          <span class="role-name">{{ r.name }}</span>
          <span class="role-code">{{ r.code }}</span>
          <span class="role-meta">
            <span v-if="r.is_system" class="badge system">system</span>
            <span class="badge">{{ r.user_count }} user{{ r.user_count === 1 ? '' : 's' }}</span>
            <span class="badge">{{ r.permissions.length }} perm{{ r.permissions.length === 1 ? '' : 's' }}</span>
          </span>
        </li>
      </ul>

      <!-- Detail -->
      <div v-if="selected" class="detail">
        <div v-if="isLocked" class="locked-note">
          This role is locked: its permissions define the
          {{ selected.code === 'admin' ? 'administrator escape hatch' : 'storefront baseline' }}
          and cannot be edited.
        </div>

        <div class="name-row">
          <div class="field">
            <label :for="'role-name'">Name</label>
            <input id="role-name" v-model="nameDraft" type="text" :disabled="store.saving" />
          </div>
          <div class="field grow">
            <label :for="'role-descr'">Description</label>
            <input id="role-descr" v-model="descrDraft" type="text" :disabled="store.saving" />
          </div>
          <button class="btn-primary" :disabled="!nameDirty || store.saving" @click="saveName">
            Rename
          </button>
        </div>

        <div class="perm-header">
          <h3>Permissions</h3>
          <div class="perm-actions" v-if="!isLocked">
            <button class="btn-ghost" :disabled="!permsDirty || store.saving" @click="resetPerms">Reset</button>
            <button class="btn-primary" :disabled="!permsDirty || store.saving" @click="savePerms">
              {{ store.saving ? 'Saving…' : 'Save Permissions' }}
            </button>
          </div>
        </div>
        <p v-if="permsDirty" class="hint warn">
          Unsaved changes. Users holding this role receive the new permissions on their next token refresh.
        </p>

        <div class="perm-groups">
          <fieldset v-for="g in permGroups" :key="g.area" class="perm-group">
            <legend>{{ g.area }}</legend>
            <label
              v-for="p in g.perms" :key="p.code"
              class="perm-option"
              :class="{ disabled: isLocked || store.saving }"
            >
              <input
                type="checkbox"
                :checked="permDraft.has(p.code)"
                :disabled="isLocked || store.saving"
                @change="togglePerm(p.code)"
              />
              <span class="perm-code">{{ p.code }}</span>
              <span class="perm-descr">{{ p.descr }}</span>
            </label>
          </fieldset>
        </div>

        <div class="danger-zone" v-if="!selected.is_system">
          <button class="btn-danger" :disabled="!canDelete || store.saving" @click="removeRole">
            Delete Role
          </button>
          <span v-if="!canDelete" class="hint">
            Only roles no user holds can be deleted.
          </span>
        </div>
      </div>
    </div>

    <!-- New role modal -->
    <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">New Role</span>
          <button class="close-btn" type="button" @click="showCreate = false">&times;</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label for="new-role-code">Code <span class="required">*</span></label>
            <input id="new-role-code" v-model="createForm.code" type="text"
                   placeholder="e.g. warehouse_lead" autofocus @keyup.enter="createRole" />
            <p class="hint">Lowercase letters, digits, underscores. Cannot be changed later.</p>
          </div>
          <div class="field">
            <label for="new-role-name">Name <span class="required">*</span></label>
            <input id="new-role-name" v-model="createForm.name" type="text"
                   placeholder="Warehouse Lead" @keyup.enter="createRole" />
          </div>
          <div class="field">
            <label for="new-role-descr">Description</label>
            <input id="new-role-descr" v-model="createForm.descr" type="text"
                   placeholder="Optional" @keyup.enter="createRole" />
          </div>
          <div v-if="createError" class="error">{{ createError }}</div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn-cancel" @click="showCreate = false">Cancel</button>
          <button type="button" class="btn-primary" :disabled="store.saving" @click="createRole">
            {{ store.saving ? 'Creating…' : 'Create Role' }}
          </button>
        </div>
      </div>
    </div>
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

.layout {
  display: flex; gap: 1rem; flex: 1; min-height: 0;
}

// ── Role list ─────────────────────────────────────────────────────────────────

.role-list {
  list-style: none; margin: 0; padding: 0; width: 260px; flex-shrink: 0;
  overflow-y: auto; border: 1px solid #e0e0e0; border-radius: 6px;

  li {
    display: flex; flex-direction: column; gap: 0.15rem;
    padding: 0.55rem 0.75rem; cursor: pointer; border-bottom: 1px solid #eee;
    &:last-child { border-bottom: none; }
    &:hover { background: #f5f3ff; }
    &.active { background: #ede8f8; border-left: 3px solid #5a3e8a; padding-left: calc(0.75rem - 3px); }

    .role-name { font-weight: 600; color: #3a2060; font-size: 0.9rem; }
    .role-code { font-size: 0.75rem; color: #888; font-family: monospace; }
    .role-meta { display: flex; gap: 0.3rem; margin-top: 0.15rem; }
  }
}

.badge {
  font-size: 0.65rem; padding: 0.05rem 0.4rem; border-radius: 8px;
  background: #f0f0f0; color: #666;
  &.system { background: #fdf3d8; color: #8a6d1a; }
}

// ── Detail ────────────────────────────────────────────────────────────────────

.detail {
  flex: 1; min-width: 0; overflow-y: auto;
  border: 1px solid #e0e0e0; border-radius: 6px; padding: 1rem;
  display: flex; flex-direction: column; gap: 0.75rem;
}

.locked-note {
  padding: 0.5rem 0.75rem; background: #fdf3d8; color: #8a6d1a;
  border-radius: 4px; font-size: 0.85rem;
}

.name-row {
  display: flex; gap: 0.5rem; align-items: flex-end;
}

.field {
  display: flex; flex-direction: column; gap: 0.25rem;
  &.grow { flex: 1; }
  label {
    font-size: 0.8rem; color: #555;
    .required { color: #c0392b; }
  }
  input {
    padding: 0.4rem 0.6rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem;
    &:focus { outline: none; border-color: #8090BF; }
    &:disabled { opacity: 0.6; }
  }
  .hint { margin: 0; }
}

.perm-header {
  display: flex; align-items: center; justify-content: space-between; margin-top: 0.25rem;
  h3 { margin: 0; font-size: 0.95rem; color: #3a2060; }
  .perm-actions { display: flex; gap: 0.5rem; }
}

.hint { font-size: 0.75rem; color: #888; }
.hint.warn { color: #b06a00; margin: 0; }

.perm-groups {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.75rem;
}

.perm-group {
  border: 1px solid #e0e0e0; border-radius: 6px; padding: 0.5rem 0.75rem 0.6rem; margin: 0;
  legend {
    font-size: 0.75rem; font-weight: 600; color: #5a3e8a;
    text-transform: uppercase; padding: 0 0.3rem;
  }
}

.perm-option {
  display: grid; grid-template-columns: auto auto 1fr; gap: 0.45rem; align-items: baseline;
  padding: 0.2rem 0.25rem; border-radius: 4px; cursor: pointer; font-size: 0.85rem;
  &:hover { background: #f5f3ff; }
  &.disabled { cursor: not-allowed; opacity: 0.65; &:hover { background: none; } }
  input { cursor: inherit; }
  .perm-code  { font-family: monospace; color: #3a2060; white-space: nowrap; }
  .perm-descr { color: #888; font-size: 0.75rem; }
}

.danger-zone {
  display: flex; align-items: center; gap: 0.75rem;
  border-top: 1px solid #eee; padding-top: 0.75rem; margin-top: 0.25rem;
}

// ── Buttons ───────────────────────────────────────────────────────────────────

button {
  border-radius: 4px; cursor: pointer; font-size: 0.85rem; border: none;
  padding: 0.35rem 0.9rem;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}
.btn-primary { background: #5a3e8a; color: #fff; &:hover:not(:disabled) { background: #7a5ea8; } }
.btn-ghost   { background: none; border: 1px solid #9b86c8; color: #5a3e8a; &:hover:not(:disabled) { background: #ede8f8; } }
.btn-danger  { background: #f8d7da; color: #721c24; &:hover:not(:disabled) { background: #f5c6cb; } }
.btn-cancel  { background: #e0e0e0; color: #333; &:hover { background: #ccc; } }

// ── Modal (same conventions as the other admin modals) ──────────────────────

.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.45);
  display: flex; align-items: center; justify-content: center; z-index: 130;
}
.modal {
  background: #fff; border-radius: 8px; width: min(440px, 96vw);
  display: flex; flex-direction: column;
  box-shadow: 0 4px 24px rgba(0,0,0,0.25);
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.75rem 1rem; border-bottom: 1px solid #ddd;
  background: #C4B1FF; border-radius: 8px 8px 0 0;
  .modal-title { font-weight: bold; font-size: 1rem; color: #3a2060; }
  .close-btn { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #555; line-height: 1; }
}
.modal-body { padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem; }
.modal-footer {
  display: flex; gap: 0.5rem; justify-content: flex-end;
  padding: 0.75rem 1rem; border-top: 1px solid #ddd;
}
</style>
