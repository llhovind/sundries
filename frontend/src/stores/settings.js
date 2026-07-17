import { ref } from 'vue';
import { defineStore } from 'pinia';
import api from '@/services/api';
import { watchAuthUser } from './storeUtils';

/**
 * Store configuration editor store (settings values, shipping rules, weight
 * bands, tax rates, warehouses). Not a createListStore: these are small,
 * unpaginated sets feeding inline editors, not searchable tables.
 */
export const useSettingsStore = defineStore('settings-admin', () => {
    const settings   = ref([]);
    const rules      = ref([]);
    const bands      = ref([]);
    const rates      = ref([]);
    const warehouses = ref([]);
    const loadingCnt = ref(0);
    const saving     = ref(false);

    function reset() {
        settings.value   = [];
        rules.value      = [];
        bands.value      = [];
        rates.value      = [];
        warehouses.value = [];
    }

    async function load() {
        loadingCnt.value++;
        try {
            const [s, r, b, t, w] = await Promise.all([
                api.get('/api/v1/settings/values'),
                api.get('/api/v1/settings/shipping-rules'),
                api.get('/api/v1/settings/weight-bands'),
                api.get('/api/v1/settings/tax-rates'),
                api.get('/api/v1/settings/warehouses'),
            ]);
            settings.value   = s.data.content.settings;
            rules.value      = r.data.content.rules;
            bands.value      = b.data.content.bands;
            rates.value      = t.data.content.rates;
            warehouses.value = w.data.content.warehouses;
        } finally {
            loadingCnt.value--;
        }
    }

    async function withSaving(fn) {
        saving.value = true;
        try { return await fn(); }
        finally { saving.value = false; }
    }

    function updateSetting(key, value) {
        return withSaving(async () => {
            const res = await api.put(`/api/v1/settings/values/${key}`, { value });
            const updated = res.data.content.setting;
            const idx = settings.value.findIndex(s => s.key === key);
            if (idx !== -1) settings.value[idx] = updated;
            return updated;
        });
    }

    /**
     * Shared create/update for the four CRUD resources. `collection` is the
     * local ref to patch, `path` the API sub-resource, `idKey`/`itemKey` the
     * row id column and response envelope key.
     */
    function makeCrud(collection, path, idKey, itemKey) {
        return {
            create(payload) {
                return withSaving(async () => {
                    const res = await api.post(`/api/v1/settings/${path}`, payload);
                    const row = res.data.content[itemKey];
                    collection.value = [...collection.value, row];
                    return row;
                });
            },
            update(id, payload) {
                return withSaving(async () => {
                    const res = await api.put(`/api/v1/settings/${path}/${id}`, payload);
                    const row = res.data.content[itemKey];
                    const idx = collection.value.findIndex(r => r[idKey] === row[idKey]);
                    if (idx !== -1) collection.value[idx] = row;
                    return row;
                });
            },
        };
    }

    const ruleActions      = makeCrud(rules, 'shipping-rules', 'rule_no', 'rule');
    const bandActions      = makeCrud(bands, 'weight-bands', 'band_no', 'band');
    const rateActions      = makeCrud(rates, 'tax-rates', 'rate_no', 'rate');
    const warehouseActions = makeCrud(warehouses, 'warehouses', 'warehouse_no', 'warehouse');

    watchAuthUser(null, reset);

    return {
        settings, rules, bands, rates, warehouses, loadingCnt, saving,
        load, updateSetting,
        createRule:      ruleActions.create,      updateRule:      ruleActions.update,
        createBand:      bandActions.create,      updateBand:      bandActions.update,
        createRate:      rateActions.create,      updateRate:      rateActions.update,
        createWarehouse: warehouseActions.create, updateWarehouse: warehouseActions.update,
    };
});
