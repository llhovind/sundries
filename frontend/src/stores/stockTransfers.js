import { ref } from 'vue';
import api from '@/services/api';
import { createListStore } from './storeUtils';

export const useStockTransfersStore = createListStore('stockTransfers', {
    endpoint:         '/api/v1/inventory/transfers',
    collectionKey:    'transfers',
    initialQuery:     () => ({ page: 1, pageSize: 25, status: '' }),
    loadErrorMessage: 'Failed to load transfers',

    fieldsConfig: {
        transfer_no: { label: '#', width: '70px' },
        route:       { label: 'Route' },                 // synthetic: from_code → to_code
        status:      { label: 'Status', width: '110px' },
        carrier:     { label: 'Carrier / tracking' },
        line_count:  { label: 'Lines', width: '70px' },
        _create_ts:  { label: 'Created' },
    },

    extend: ({ getAll }) => {
        const warehouses = ref([]);   // all active, both types — views filter by wh_type

        async function loadWarehouses() {
            const res = await api.get('/api/v1/inventory/warehouses');
            warehouses.value = res.data.content.warehouses;
        }

        /** Variant picker backing search (name/SKU → balances rows). */
        async function searchVariants(q) {
            const res = await api.get(
                '/api/v1/inventory/balances?pageSize=10&q=' + encodeURIComponent(q));
            return res.data.content.balances;
        }

        async function getTransfer(transferNo) {
            const res = await api.get(`/api/v1/inventory/transfers/${transferNo}`);
            return res.data.content.transfer;
        }

        async function createTransfer(payload) {
            const res = await api.post('/api/v1/inventory/transfers', payload);
            await getAll();
            return res.data.content.transfer_no;
        }

        const lifecycle = (action) => async (transferNo) => {
            await api.post(`/api/v1/inventory/transfers/${transferNo}/${action}`);
            await getAll();
        };

        return {
            warehouses, loadWarehouses, searchVariants, getTransfer, createTransfer,
            dispatch: lifecycle('dispatch'),
            receive:  lifecycle('receive'),
            cancel:   lifecycle('cancel'),
        };
    },
});
