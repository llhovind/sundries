import api from '@/services/api';
import { createListStore } from './storeUtils';

export const useOrdersStore = createListStore('orders', {
    endpoint:         '/api/v1/orders',
    collectionKey:    'orders',
    loadErrorMessage: 'Failed to load orders',

    // The orders endpoint filters by status, not free-text q.
    initialQuery: () => ({ page: 1, pageSize: 25, status: '' }),

    fieldsConfig: {
        ord_no:        { label: '#', width: '5rem' },
        placed_at:     { label: 'Placed', format: 'datetime' },
        customer_name: { label: 'Customer' },
        status:        { label: 'Status' },
        total:         { label: 'Total', format: 'usd' },
    },

    extend: ({ getAll }) => ({
        async getOrder(ordNo) {
            const res = await api.get(`/api/v1/orders/${ordNo}`);
            return res.data.content.order;
        },

        /** @param {{carrier?:string, tracking_no?:string, notes?:string}} [details] */
        async shipOrder(ordNo, details = {}) {
            await api.post(`/api/v1/orders/${ordNo}/ship`, details);
            await getAll();
        },

        async updateShipment(ordNo, shipmentNo, details) {
            const res = await api.put(`/api/v1/orders/${ordNo}/shipments/${shipmentNo}`, details);
            return res.data.content.shipment;
        },
    }),
});
