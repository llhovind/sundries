<script setup>
import { ref, reactive } from 'vue';
import { usePurchaseOrdersStore } from '@/stores/purchaseOrders';
import { apiErrorMessage } from '@/stores/storeUtils';

// Emits the new vendor's id so the caller can select it straight away —
// creating a vendor is always in service of raising a purchase order.
const emit  = defineEmits(['close', 'created']);
const store = usePurchaseOrdersStore();

const form = reactive({
    name:    '',
    phone:   '',
    website: '',
    address: '',
    city:    '',
    state:   '',
    zip:     '',
    country: '',
    notes:   '',
});

const saving   = ref(false);
const errorMsg = ref('');

async function save() {
    errorMsg.value = '';
    if (!form.name.trim()) {
        errorMsg.value = 'A vendor name is required';
        return;
    }
    saving.value = true;
    try {
        // Blank optional fields are dropped rather than stored as empty strings,
        // so "no phone on file" reads as NULL and not as an empty value.
        const payload = Object.fromEntries(
            Object.entries(form)
                .map(([key, value]) => [key, value.trim()])
                .filter(([, value]) => value !== '')
        );
        const vendor = await store.createVendor(payload);
        emit('created', vendor.id);
        emit('close');
    } catch (err) {
        errorMsg.value = apiErrorMessage(err, 'Failed to create vendor');
    } finally {
        saving.value = false;
    }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Add Vendor</span>
        <button class="close-btn" type="button" @click="emit('close')">&times;</button>
      </div>

      <div class="modal-body">
        <div class="field">
          <label for="new-vendor-name">Name <span class="required">*</span></label>
          <input id="new-vendor-name" v-model="form.name" type="text"
                 placeholder="Northwind Supply Co." autofocus @keyup.enter="save" />
        </div>

        <div class="field-row">
          <div class="field">
            <label for="new-vendor-phone">Phone</label>
            <input id="new-vendor-phone" v-model="form.phone" type="text" placeholder="Optional" />
          </div>
          <div class="field">
            <label for="new-vendor-website">Website</label>
            <input id="new-vendor-website" v-model="form.website" type="text" placeholder="Optional" />
          </div>
        </div>

        <div class="field">
          <label for="new-vendor-address">Address</label>
          <input id="new-vendor-address" v-model="form.address" type="text" placeholder="Optional" />
        </div>

        <div class="field-row">
          <div class="field">
            <label for="new-vendor-city">City</label>
            <input id="new-vendor-city" v-model="form.city" type="text" placeholder="Optional" />
          </div>
          <div class="field narrow">
            <label for="new-vendor-state">State</label>
            <input id="new-vendor-state" v-model="form.state" type="text" placeholder="Optional" />
          </div>
          <div class="field narrow">
            <label for="new-vendor-zip">ZIP</label>
            <input id="new-vendor-zip" v-model="form.zip" type="text" placeholder="Optional" />
          </div>
          <div class="field narrow">
            <label for="new-vendor-country">Country</label>
            <input id="new-vendor-country" v-model="form.country" type="text" placeholder="Optional" />
          </div>
        </div>

        <div class="field">
          <label for="new-vendor-notes">Notes</label>
          <input id="new-vendor-notes" v-model="form.notes" type="text" placeholder="Optional" />
        </div>

        <div v-if="errorMsg" class="error">{{ errorMsg }}</div>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn-cancel" @click="emit('close')">Cancel</button>
        <button type="button" class="btn-save" :disabled="saving" @click="save">
          {{ saving ? 'Creating…' : 'Create Vendor' }}
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
  background: #fff; border-radius: 8px; width: min(560px, 96vw);
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
.field-row {
  display: flex; gap: 0.75rem;
  .field { flex: 1 1 auto; min-width: 0; }
  .field.narrow { flex: 0 1 6rem; }
}
.field {
  display: flex; flex-direction: column; gap: 0.25rem;
  label {
    font-size: 0.8rem; color: #555;
    .required { color: #c0392b; }
  }
  input {
    padding: 0.4rem 0.6rem; border: 1px solid #ccc; border-radius: 4px;
    font-size: 0.95rem; background: #fff; min-width: 0;
    &:focus { outline: none; border-color: #8090BF; }
  }
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
