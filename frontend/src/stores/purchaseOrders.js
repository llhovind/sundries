import { ref } from 'vue';
import api from '@/services/api';
import { createListStore } from './storeUtils';

export const usePurchaseOrdersStore = createListStore('purchaseOrders', {
    endpoint:         '/api/v1/purchase-orders',
    collectionKey:    'purchase_orders',
    initialQuery:     () => ({ page: 1, pageSize: 25, status: '' }),
    loadErrorMessage: 'Failed to load purchase orders',

    fieldsConfig: {
        po_no:          { label: 'PO #', width: '80px' },
        vendor_name:    { label: 'Vendor' },
        warehouse_code: { label: 'Deliver to', width: '110px' },
        po_status:      { label: 'Status', width: '100px' },
        progress:       { label: 'Received' },              // synthetic: qty_received / qty_ordered
        subtotal:       { label: 'Subtotal', class: 'rAlign', width: '110px' },
        po_dt:          { label: 'Date', width: '110px' },
    },

    extend: ({ getAll }) => {
        const vendors    = ref([]);
        const warehouses = ref([]);

        async function loadPicklists() {
            const [vRes, wRes] = await Promise.all([
                api.get('/api/v1/vendors'),
                api.get('/api/v1/inventory/warehouses'),
            ]);
            vendors.value    = vRes.data.content.vendors;
            warehouses.value = wRes.data.content.warehouses.filter(w => w.wh_type === 'standard');
        }

        /**
         * Creates a vendor and refreshes the picklist so the caller can select
         * it immediately. Vendors are a purchasing prerequisite — without this
         * a fresh install has no way to raise its first purchase order.
         * @returns {Promise<{id: number, name: string}>}
         */
        async function createVendor(payload) {
            const res = await api.post('/api/v1/vendors', payload);
            await loadPicklists();
            return res.data.content.vendor;
        }

        /** Variant picker backing search (name/SKU → balances rows). */
        async function searchVariants(q) {
            const res = await api.get(
                '/api/v1/inventory/balances?pageSize=10&q=' + encodeURIComponent(q));
            return res.data.content.balances;
        }

        async function getPo(poNo) {
            const res = await api.get(`/api/v1/purchase-orders/${poNo}`);
            return res.data.content.purchase_order;
        }

        async function createPo(payload) {
            const res = await api.post('/api/v1/purchase-orders', payload);
            await getAll();
            return res.data.content.po_no;
        }

        /** @param {Array<{po_line_id:number, qty:number}>} lines */
        async function receivePo(poNo, lines) {
            const res = await api.post(`/api/v1/purchase-orders/${poNo}/receive`, { lines });
            await getAll();
            return res.data.content;
        }

        const lifecycle = (action) => async (poNo) => {
            await api.post(`/api/v1/purchase-orders/${poNo}/${action}`);
            await getAll();
        };

        return {
            vendors, warehouses, loadPicklists, searchVariants,
            createVendor, getPo, createPo, receivePo,
            close:  lifecycle('close'),
            cancel: lifecycle('cancel'),
        };
    },
});
