<script setup>
import { ref, reactive } from 'vue';
import { useUsersStore } from '@/stores/users';
import { apiErrorMessage } from '@/stores/storeUtils';

const emit  = defineEmits(['close']);
const store = useUsersStore();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const form = reactive({
    email:    '',
    username: '',
    role:     '',   // deliberately no default — privilege is an explicit choice
});

const saving   = ref(false);
const errorMsg = ref('');

async function save() {
    errorMsg.value = '';
    if (!EMAIL_REGEX.test(form.email)) {
        errorMsg.value = 'A valid email address is required';
        return;
    }
    if (!form.role) {
        errorMsg.value = 'A role is required';
        return;
    }
    saving.value = true;
    try {
        await store.createUser({
            email:    form.email.trim(),
            role:     form.role,
            username: form.username.trim() || undefined,
        });
        emit('close');
    } catch (err) {
        errorMsg.value = apiErrorMessage(err, 'Failed to create user');
    } finally {
        saving.value = false;
    }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Add User</span>
        <button class="close-btn" type="button" @click="emit('close')">&times;</button>
      </div>

      <div class="modal-body">
        <div class="field">
          <label for="new-user-email">Email <span class="required">*</span></label>
          <input id="new-user-email" v-model="form.email" type="email"
                 placeholder="user@example.com" autofocus @keyup.enter="save" />
        </div>

        <div class="field">
          <label for="new-user-name">Display name</label>
          <input id="new-user-name" v-model="form.username" type="text"
                 placeholder="Optional" @keyup.enter="save" />
        </div>

        <div class="field">
          <label for="new-user-role">Role <span class="required">*</span></label>
          <select id="new-user-role" v-model="form.role">
            <option value="" disabled>Select a role…</option>
            <option v-for="r in store.roles" :key="r.code" :value="r.code">
              {{ r.name || r.code }}
            </option>
          </select>
          <p class="hint">The user signs in with a one-time code sent to their email.</p>
        </div>

        <div v-if="errorMsg" class="error">{{ errorMsg }}</div>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn-cancel" @click="emit('close')">Cancel</button>
        <button type="button" class="btn-save" :disabled="saving" @click="save">
          {{ saving ? 'Creating…' : 'Create User' }}
        </button>
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
.modal-body {
  padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem;
}
.field {
  display: flex; flex-direction: column; gap: 0.25rem;
  label {
    font-size: 0.8rem; color: #555;
    .required { color: #c0392b; }
  }
  input, select {
    padding: 0.4rem 0.6rem; border: 1px solid #ccc; border-radius: 4px;
    font-size: 0.95rem; background: #fff;
    &:focus { outline: none; border-color: #8090BF; }
  }
  .hint { margin: 0.15rem 0 0; font-size: 0.75rem; color: #888; }
}
.error { color: #c0392b; font-size: 0.85rem; }
.modal-footer {
  display: flex; gap: 0.5rem; justify-content: flex-end;
  padding: 0.75rem 1rem; border-top: 1px solid #ddd;
}
button {
  padding: 0.4rem 1.1rem; border-radius: 4px; border: none; cursor: pointer; font-size: 0.9rem;
  &:disabled { opacity: 0.6; cursor: not-allowed; }
}
.btn-save   { background: #5a3e8a; color: #fff; &:hover:not(:disabled) { background: #7a5ea8; } }
.btn-cancel { background: #e0e0e0; color: #333; &:hover { background: #ccc; } }
</style>
