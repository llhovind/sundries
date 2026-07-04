import { ref } from 'vue';
import api from '@/services/api';
import { createListStore } from './storeUtils';

export const useInventoryStore = createListStore('inventory', {
    endpoint:         '/api/v1/inventory/balances',
    collectionKey:    'balances',
    loadErrorMessage: 'Failed to load balances',

    fieldsConfig: {
        product_name:  { label: 'Product' },
        sku:           { label: 'SKU' },
        qty_on_hand:   { label: 'On hand' },
        qty_reserved:  { label: 'Reserved', format: 'fixedNum2' },
        qty_available: { label: 'Available' },
        warehouses:    { label: 'Warehouses' },
    },

    extend: ({ getAll }) => {
        const warehouses = ref([]);   // standard warehouses, for receive/adjust forms

        async function loadWarehouses() {
            const res = await api.get('/api/v1/inventory/warehouses');
            warehouses.value = res.data.content.warehouses
                .filter(w => w.wh_type === 'standard');
        }

        async function getLedger(variantNo) {
            const res = await api.get(`/api/v1/inventory/ledger/${variantNo}`);
            return res.data.content.transactions;
        }

        async function receive(payload) {
            await api.post('/api/v1/inventory/receive', payload);
            await getAll();
        }

        async function adjust(payload) {
            await api.post('/api/v1/inventory/adjust', payload);
            await getAll();
        }

        return { warehouses, loadWarehouses, getLedger, receive, adjust };
    },
});
