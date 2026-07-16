<script setup>
import { ref, computed } from 'vue';
import { useUsersStore } from '@/stores/users';
import { apiErrorMessage } from '@/stores/storeUtils';

const props = defineProps({
    // Store row — the store patches it in place, so the modal stays current.
    user:   { type: Object,  required: true },
    isSelf: { type: Boolean, default: false },
});
const emit  = defineEmits(['close']);
const store = useUsersStore();

const errorMsg     = ref('');
const primaryDraft = ref(props.user.role);

const busy       = computed(() => store.saving === props.user.id);
const heldRoles  = computed(() => new Set(props.user.roles ?? []));
const extraRoles = computed(() => store.roles.filter(r => r.code !== props.user.role));

const primaryChanged = computed(() => primaryDraft.value !== props.user.role);

async function applyPrimary() {
    errorMsg.value = '';
    try {
        await store.updateUser(props.user.id, { role: primaryDraft.value });
    } catch (err) {
        errorMsg.value = apiErrorMessage(err, 'Failed to change primary role');
        primaryDraft.value = props.user.role;
    }
}

async function toggleGrant(code) {
    if (busy.value) return;
    errorMsg.value = '';
    try {
        if (heldRoles.value.has(code)) await store.revokeRole(props.user.id, code);
        else                           await store.grantRole(props.user.id, code);
    } catch (err) {
        errorMsg.value = apiErrorMessage(err, 'Failed to update role grant');
    }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Roles — {{ user.username || user.email }}</span>
        <button class="close-btn" type="button" @click="emit('close')">&times;</button>
      </div>

      <div class="modal-body">
        <div class="section">
          <span class="section-title">Primary role</span>
          <div class="primary-row">
            <select v-model="primaryDraft" :disabled="isSelf || busy" aria-label="Primary role">
              <option v-for="r in store.roles" :key="r.code" :value="r.code">
                {{ r.name || r.code }}
              </option>
            </select>
            <button class="btn-apply" :disabled="!primaryChanged || busy" @click="applyPrimary">
              Apply
            </button>
          </div>
          <p v-if="isSelf" class="hint">You cannot change your own primary role.</p>
          <p v-else-if="primaryChanged" class="hint warn">
            Changing the primary role removes all additional roles below.
          </p>
        </div>

        <div class="section">
          <span class="section-title">Additional roles</span>
          <label
            v-for="r in extraRoles" :key="r.code"
            class="role-option"
            :class="{ disabled: busy || (isSelf && r.code === 'admin') }"
          >
            <input
              type="checkbox"
              :checked="heldRoles.has(r.code)"
              :disabled="busy || (isSelf && r.code === 'admin')"
              @change="toggleGrant(r.code)"
            />
            <span class="role-name">{{ r.name || r.code }}</span>
            <span v-if="r.descr" class="role-descr">{{ r.descr }}</span>
          </label>
        </div>

        <div v-if="errorMsg" class="error">{{ errorMsg }}</div>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn-done" @click="emit('close')">Done</button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.45);
  display: flex; align-items: center; justify-content: center; z-index: 130;
}
.modal {
  background: #fff; border-radius: 8px; width: min(480px, 96vw);
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
.modal-body {
  padding: 1rem; display: flex; flex-direction: column; gap: 1rem;
  max-height: 70vh; overflow-y: auto;
}
.section {
  display: flex; flex-direction: column; gap: 0.4rem;
}
.section-title { font-size: 0.8rem; font-weight: 600; color: #555; text-transform: uppercase; }
.primary-row {
  display: flex; gap: 0.5rem;
  select {
    flex: 1; padding: 0.4rem 0.6rem; border: 1px solid #ccc; border-radius: 4px;
    font-size: 0.95rem; background: #fff;
    &:disabled { opacity: 0.6; cursor: not-allowed; }
  }
}
.btn-apply {
  padding: 0.4rem 0.9rem; border: none; border-radius: 4px; cursor: pointer;
  background: #5a3e8a; color: #fff; font-size: 0.85rem;
  &:hover:not(:disabled) { background: #7a5ea8; }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}
.hint { margin: 0; font-size: 0.75rem; color: #888; }
.hint.warn { color: #b06a00; }
.role-option {
  display: grid; grid-template-columns: auto auto 1fr; gap: 0.5rem; align-items: baseline;
  padding: 0.3rem 0.4rem; border-radius: 4px; cursor: pointer;
  &:hover { background: #f5f3ff; }
  &.disabled { opacity: 0.55; cursor: not-allowed; }
  input { cursor: inherit; }
  .role-name  { font-size: 0.9rem; color: #3a2060; font-weight: 500; }
  .role-descr { font-size: 0.78rem; color: #888; }
}
.error { color: #c0392b; font-size: 0.85rem; }
.modal-footer {
  display: flex; justify-content: flex-end;
  padding: 0.75rem 1rem; border-top: 1px solid #ddd;
}
.btn-done {
  padding: 0.4rem 1.1rem; border-radius: 4px; border: none; cursor: pointer;
  font-size: 0.9rem; background: #5a3e8a; color: #fff;
  &:hover { background: #7a5ea8; }
}
</style>
