<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import api from '@/services/api';

const emit = defineEmits(['close']);

const auth    = useAuthStore();
const loading = ref(false);
const saving  = ref(false);
const errorMsg = ref('');

const form = reactive({
    name:    '',
    phone:   '',
    address: '',
    city:    '',
    state:   '',
    zip:     '',
    country: '',
});

onMounted(async () => {
    loading.value = true;
    try {
        const res      = await api.get('/api/v1/customers/me');
        const customer = res.data.content.customer;
        if (customer) {
            form.name    = customer.name    || '';
            form.phone   = customer.phone   || '';
            form.address = customer.address || '';
            form.city    = customer.city    || '';
            form.state   = customer.state   || '';
            form.zip     = customer.zip     || '';
            form.country = customer.country || '';
        } else {
            // Pre-fill name with the local-part of the email (strip @domain)
            form.name = auth.user?.email?.split('@')[0] ?? '';
        }
    } catch {
        errorMsg.value = 'Failed to load profile';
    } finally {
        loading.value = false;
    }
});

async function save() {
    errorMsg.value = '';
    if (!form.name.trim()) {
        errorMsg.value = 'Name is required';
        return;
    }
    saving.value = true;
    try {
        await api.put('/api/v1/customers/me', { ...form });
        emit('close');
    } catch (err) {
        errorMsg.value = err.response?.data?.message || 'Failed to save profile';
    } finally {
        saving.value = false;
    }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">My Profile</span>
        <button class="close-btn" type="button" @click="emit('close')">&times;</button>
      </div>

      <div class="modal-body">
        <div v-if="loading" class="loading">Loading…</div>

        <template v-else>
          <div class="email-row">
            <span class="field-label">Email</span>
            <span class="email-value">{{ auth.user?.email }}</span>
          </div>

          <div class="field">
            <label for="profile-name">Name <span class="required">*</span></label>
            <input id="profile-name" v-model="form.name" type="text" placeholder="Your name" autofocus />
          </div>

          <div class="field">
            <label for="profile-phone">Phone</label>
            <input id="profile-phone" v-model="form.phone" type="tel" placeholder="Phone number" />
          </div>

          <div class="field">
            <label for="profile-address">Address</label>
            <input id="profile-address" v-model="form.address" type="text" placeholder="Street address" />
          </div>

          <div class="field-row">
            <div class="field">
              <label for="profile-city">City</label>
              <input id="profile-city" v-model="form.city" type="text" placeholder="City" />
            </div>
            <div class="field field--short">
              <label for="profile-state">State</label>
              <input id="profile-state" v-model="form.state" type="text" placeholder="State" />
            </div>
            <div class="field field--short">
              <label for="profile-zip">Zip</label>
              <input id="profile-zip" v-model="form.zip" type="text" placeholder="Zip" />
            </div>
          </div>

          <div class="field">
            <label for="profile-country">Country</label>
            <input id="profile-country" v-model="form.country" type="text" placeholder="Country" />
          </div>

          <div v-if="errorMsg" class="error">{{ errorMsg }}</div>
        </template>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn-cancel" @click="emit('close')">Cancel</button>
        <button type="button" class="btn-save" :disabled="saving || loading" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
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
  max-height: 70vh; overflow-y: auto;
}
.loading { text-align: center; color: #888; padding: 1rem 0; }
.email-row {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.4rem 0.6rem; background: #f5f3ff; border-radius: 4px;
  .field-label { font-size: 0.8rem; color: #555; min-width: 3rem; }
  .email-value { font-size: 0.9rem; font-weight: 500; color: #3a2060; }
}
.field {
  display: flex; flex-direction: column; gap: 0.25rem;
  flex: 1;
  label {
    font-size: 0.8rem; color: #555;
    .required { color: #c0392b; }
  }
  input {
    padding: 0.4rem 0.6rem; border: 1px solid #ccc; border-radius: 4px;
    font-size: 0.95rem;
    &:focus { outline: none; border-color: #8090BF; }
  }
  &--short { max-width: 100px; }
}
.field-row {
  display: flex; gap: 0.5rem; align-items: flex-end;
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
