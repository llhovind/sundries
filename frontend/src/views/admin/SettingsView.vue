<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import { apiErrorMessage } from '@/stores/storeUtils';

const store = useSettingsStore();
const error = ref('');

onMounted(async () => {
    try {
        await store.load();
    } catch (err) {
        error.value = apiErrorMessage(err, 'Failed to load store configuration');
    }
});

// ── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = [
    { id: 'store',      label: 'Store Settings' },
    { id: 'shipping',   label: 'Shipping' },
    { id: 'tax',        label: 'Tax Rates' },
    { id: 'warehouses', label: 'Warehouses' },
];
const activeTab = ref('store');

// Which generic CRUD resources render on each tab (store settings are special-cased).
const TAB_RESOURCES = {
    store:      [],
    shipping:   ['rules', 'bands'],
    tax:        ['rates'],
    warehouses: ['warehouses'],
};

const STATUS_OPTIONS = ['active', 'inactive'];

/**
 * Generic CRUD resource configs. `createOnly` fields are editable on the new
 * row but immutable (rendered as text) on existing rows.
 */
const RESOURCES = {
    rules: {
        title: 'Subtotal rules',
        hint:  'Base shipping rate by order subtotal. The active rule with the lowest priority number whose range contains the subtotal wins. Leave max empty for “and up”.',
        idKey: 'rule_no',
        fields: [
            { key: 'name',         label: 'Name',         type: 'text' },
            { key: 'min_subtotal', label: 'Min subtotal', type: 'number' },
            { key: 'max_subtotal', label: 'Max subtotal', type: 'number', placeholder: 'no cap' },
            { key: 'base_amount',  label: 'Base rate',    type: 'number' },
            { key: 'priority',     label: 'Priority',     type: 'number' },
            { key: 'status',       label: 'Status',       type: 'select', options: STATUS_OPTIONS },
        ],
        create: p => store.createRule(p),
        update: (id, p) => store.updateRule(id, p),
    },
    bands: {
        title: 'Weight surcharge bands',
        hint:  'Freight surcharge per package weight (lbs). Unit goods: one package per unit; measured goods: the whole cut is one package.',
        idKey: 'band_no',
        fields: [
            { key: 'min_weight_lbs', label: 'Min weight', type: 'number' },
            { key: 'max_weight_lbs', label: 'Max weight', type: 'number', placeholder: 'no cap' },
            { key: 'surcharge',      label: 'Surcharge',  type: 'number' },
            { key: 'status',         label: 'Status',     type: 'select', options: STATUS_OPTIONS },
        ],
        create: p => store.createBand(p),
        update: (id, p) => store.updateBand(id, p),
    },
    rates: {
        title: 'Tax rates',
        hint:  'Used by the local tax provider — the most specific active row wins (country + state beats country-wide). Rate is a fraction: 0.0825 means 8.25%.',
        idKey: 'rate_no',
        fields: [
            { key: 'name',          label: 'Name',          type: 'text' },
            { key: 'country',       label: 'Country',       type: 'text' },
            { key: 'state',         label: 'State',         type: 'text',  placeholder: 'all' },
            { key: 'postal_prefix', label: 'Postal prefix', type: 'text',  placeholder: 'all' },
            { key: 'rate',          label: 'Rate',          type: 'number' },
            { key: 'status',        label: 'Status',        type: 'select', options: STATUS_OPTIONS },
        ],
        create: p => store.createRate(p),
        update: (id, p) => store.updateRate(id, p),
    },
    warehouses: {
        title: 'Warehouses',
        hint:  'Reservations are sourced from active standard warehouses in priority order (lowest first). Transport warehouses hold in-transit transfer stock. Deactivating keeps existing stock on the ledger but stops new allocations.',
        idKey: 'warehouse_no',
        fields: [
            { key: 'code',            label: 'Code',     type: 'text', createOnly: true },
            { key: 'name',            label: 'Name',     type: 'text' },
            { key: 'wh_type',         label: 'Type',     type: 'select', options: ['standard', 'transport'] },
            { key: 'city',            label: 'City',     type: 'text', placeholder: '—' },
            { key: 'state',           label: 'State',    type: 'text', placeholder: '—' },
            { key: 'priority',        label: 'Priority', type: 'number' },
            { key: 'default_carrier', label: 'Carrier',  type: 'text', placeholder: '—' },
            { key: 'status',          label: 'Status',   type: 'select', options: STATUS_OPTIONS },
        ],
        create: p => store.createWarehouse(p),
        update: (id, p) => store.updateWarehouse(id, p),
    },
};

function itemsOf(resId) {
    return store[resId];
}

// ── Row drafts (existing rows) ───────────────────────────────────────────────

const drafts = reactive({});   // `${resId}:${id}` → editable copy of the row

function snapshot(row, fields) {
    const copy = {};
    for (const f of fields) copy[f.key] = row[f.key] ?? (f.type === 'select' ? f.options[0] : '');
    return copy;
}

function draftFor(resId, row) {
    const cfg = RESOURCES[resId];
    const k = `${resId}:${row[cfg.idKey]}`;
    if (!drafts[k]) drafts[k] = snapshot(row, cfg.fields);
    return drafts[k];
}

function isDirty(resId, row) {
    const cfg = RESOURCES[resId];
    const k = `${resId}:${row[cfg.idKey]}`;
    if (!drafts[k]) return false;
    const saved = snapshot(row, cfg.fields);
    return cfg.fields.some(f => String(drafts[k][f.key] ?? '') !== String(saved[f.key] ?? ''));
}

async function saveRow(resId, row) {
    const cfg = RESOURCES[resId];
    const k = `${resId}:${row[cfg.idKey]}`;
    const payload = {};
    for (const f of cfg.fields) {
        if (f.createOnly) continue;
        payload[f.key] = drafts[k][f.key] === '' ? null : drafts[k][f.key];
    }
    error.value = '';
    try {
        await cfg.update(row[cfg.idKey], payload);
        delete drafts[k];
    } catch (err) {
        error.value = apiErrorMessage(err, `Failed to update ${cfg.title.toLowerCase()}`);
    }
}

function resetRow(resId, row) {
    delete drafts[`${resId}:${row[RESOURCES[resId].idKey]}`];
}

// ── New-row form ─────────────────────────────────────────────────────────────

const newDrafts = reactive({});   // resId → draft object | undefined

function startNew(resId) {
    const blank = {};
    for (const f of RESOURCES[resId].fields) blank[f.key] = f.type === 'select' ? f.options[0] : '';
    newDrafts[resId] = blank;
}

async function saveNew(resId) {
    const cfg = RESOURCES[resId];
    const payload = {};
    for (const f of cfg.fields) {
        payload[f.key] = newDrafts[resId][f.key] === '' ? null : newDrafts[resId][f.key];
    }
    error.value = '';
    try {
        await cfg.create(payload);
        delete newDrafts[resId];
    } catch (err) {
        error.value = apiErrorMessage(err, `Failed to create ${cfg.title.toLowerCase()}`);
    }
}

// ── Store settings tab ───────────────────────────────────────────────────────

const settingDrafts = reactive({});   // key → draft value

function settingDraft(s) {
    if (!(s.key in settingDrafts)) settingDrafts[s.key] = s.value;
    return settingDrafts[s.key];
}

function setSettingDraft(s, value) {
    // Preserve the value's JSONB type — the backend rejects type changes.
    settingDrafts[s.key] = typeof s.value === 'number' ? Number(value) : value;
}

function settingDirty(s) {
    return s.key in settingDrafts && settingDrafts[s.key] !== s.value;
}

async function saveSetting(s) {
    error.value = '';
    try {
        await store.updateSetting(s.key, settingDrafts[s.key]);
        delete settingDrafts[s.key];
    } catch (err) {
        error.value = apiErrorMessage(err, `Failed to update ${s.key}`);
    }
}

const sortedSettings = computed(() => [...store.settings].sort((a, b) => a.key.localeCompare(b.key)));
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2>Store Configuration</h2>
    </div>

    <div class="tabs">
      <button
        v-for="t in TABS" :key="t.id"
        class="tab" :class="{ active: activeTab === t.id }"
        @click="activeTab = t.id"
      >{{ t.label }}</button>
    </div>

    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="store.loadingCnt" class="hint">Loading…</div>

    <!-- ── Store settings ─────────────────────────────────────────────── -->
    <section v-if="activeTab === 'store'" class="resource">
      <p class="hint">
        Values are read live by the services that use them — changes apply to the
        next order, email, or job without a restart.
      </p>
      <table class="cfg-table settings-table">
        <thead>
          <tr><th>Setting</th><th>Description</th><th>Value</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="s in sortedSettings" :key="s.key">
            <td class="mono">{{ s.key }}</td>
            <td class="descr">{{ s.descr }}</td>
            <td>
              <select
                v-if="typeof s.value === 'boolean'"
                :value="String(settingDraft(s))"
                :disabled="store.saving"
                @change="setSettingDraft(s, $event.target.value === 'true')"
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
              <input
                v-else
                :type="typeof s.value === 'number' ? 'number' : 'text'"
                :value="settingDraft(s)"
                :disabled="store.saving"
                step="any"
                @input="setSettingDraft(s, $event.target.value)"
              />
            </td>
            <td class="row-actions">
              <button class="btn-primary" :disabled="!settingDirty(s) || store.saving" @click="saveSetting(s)">Save</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ── Generic CRUD resources (shipping / tax / warehouses) ─────────── -->
    <section v-for="resId in TAB_RESOURCES[activeTab]" :key="resId" class="resource">
      <div class="resource-header">
        <h3>{{ RESOURCES[resId].title }}</h3>
        <button class="btn-add" v-if="!newDrafts[resId]" @click="startNew(resId)">+ Add</button>
      </div>
      <p class="hint">{{ RESOURCES[resId].hint }}</p>

      <table class="cfg-table">
        <thead>
          <tr>
            <th v-for="f in RESOURCES[resId].fields" :key="f.key">{{ f.label }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <!-- New row -->
          <tr v-if="newDrafts[resId]" class="new-row">
            <td v-for="f in RESOURCES[resId].fields" :key="f.key">
              <select v-if="f.type === 'select'" v-model="newDrafts[resId][f.key]" :disabled="store.saving">
                <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
              </select>
              <input v-else v-model="newDrafts[resId][f.key]" :type="f.type" step="any"
                     :placeholder="f.placeholder || ''" :disabled="store.saving" />
            </td>
            <td class="row-actions">
              <button class="btn-primary" :disabled="store.saving" @click="saveNew(resId)">Create</button>
              <button class="btn-ghost" @click="delete newDrafts[resId]">Cancel</button>
            </td>
          </tr>

          <!-- Existing rows -->
          <tr v-for="row in itemsOf(resId)" :key="row[RESOURCES[resId].idKey]"
              :class="{ inactive: row.status === 'inactive' }">
            <td v-for="f in RESOURCES[resId].fields" :key="f.key">
              <span v-if="f.createOnly" class="mono">{{ row[f.key] }}</span>
              <select v-else-if="f.type === 'select'" v-model="draftFor(resId, row)[f.key]" :disabled="store.saving">
                <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
              </select>
              <input v-else v-model="draftFor(resId, row)[f.key]" :type="f.type" step="any"
                     :placeholder="f.placeholder || ''" :disabled="store.saving" />
            </td>
            <td class="row-actions">
              <button class="btn-primary" :disabled="!isDirty(resId, row) || store.saving" @click="saveRow(resId, row)">Save</button>
              <button class="btn-ghost" v-if="isDirty(resId, row)" @click="resetRow(resId, row)">Reset</button>
            </td>
          </tr>

          <tr v-if="!itemsOf(resId).length && !newDrafts[resId]">
            <td :colspan="RESOURCES[resId].fields.length + 1" class="empty">Nothing configured yet.</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style lang="scss" scoped>
.view { display: flex; flex-direction: column; height: 100%; overflow-y: auto; }

.view-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;
  h2 { margin: 0; color: #3a2060; }
}

.tabs {
  display: flex; gap: 0.25rem; border-bottom: 2px solid #e0e0e0; margin-bottom: 0.75rem;
}
.tab {
  padding: 0.4rem 1rem; background: none; border: none; border-bottom: 2px solid transparent;
  margin-bottom: -2px; cursor: pointer; font-size: 0.9rem; color: #555; border-radius: 0;
  &:hover { color: #3a2060; }
  &.active { color: #3a2060; font-weight: 600; border-bottom-color: #5a3e8a; }
}

.error { color: #c0392b; margin-bottom: 0.5rem; font-size: 0.9rem; }
.hint  { font-size: 0.78rem; color: #888; margin: 0 0 0.5rem; }

.resource { margin-bottom: 1.5rem; }
.resource-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.25rem;
  h3 { margin: 0; font-size: 0.95rem; color: #3a2060; }
}

.btn-add {
  padding: 0.3rem 0.8rem; background: #5a3e8a; color: #fff;
  border: none; border-radius: 4px; cursor: pointer; font-size: 0.8rem;
  &:hover { background: #7a5ea8; }
}

.cfg-table {
  width: 100%; border-collapse: collapse; font-size: 0.85rem;
  border: 1px solid #e0e0e0; border-radius: 6px;

  th {
    text-align: left; padding: 0.45rem 0.6rem; background: #f5f3ff;
    color: #3a2060; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em;
  }
  td { padding: 0.35rem 0.6rem; border-top: 1px solid #eee; vertical-align: middle; }

  tr.inactive td { opacity: 0.55; }
  tr.new-row td  { background: #fbfaff; }

  input, select {
    width: 100%; box-sizing: border-box; padding: 0.3rem 0.45rem;
    border: 1px solid #ccc; border-radius: 4px; font-size: 0.85rem;
    &:focus { outline: none; border-color: #8090BF; }
    &:disabled { opacity: 0.6; }
  }
  .empty { color: #999; text-align: center; padding: 0.9rem; }
}

.settings-table {
  .mono  { white-space: nowrap; }
  .descr { color: #777; font-size: 0.78rem; }
  td:nth-child(3) { width: 220px; }
}

.mono { font-family: monospace; color: #3a2060; }

.row-actions {
  white-space: nowrap; width: 1%;
  display: flex; gap: 0.35rem;
}

button {
  border-radius: 4px; cursor: pointer; font-size: 0.8rem; border: none; padding: 0.3rem 0.75rem;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}
.btn-primary { background: #5a3e8a; color: #fff; &:hover:not(:disabled) { background: #7a5ea8; } }
.btn-ghost   { background: none; border: 1px solid #9b86c8; color: #5a3e8a; &:hover:not(:disabled) { background: #ede8f8; } }
</style>
