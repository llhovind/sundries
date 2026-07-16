import api from '@/services/api';
import { createListStore } from './storeUtils';

export const useRmasStore = createListStore('rmas', {
    endpoint:         '/api/v1/rmas',
    collectionKey:    'rmas',
    initialQuery:     () => ({ page: 1, pageSize: 25, status: '' }),
    loadErrorMessage: 'Failed to load returns',

    fieldsConfig: {
        rma_no:        { label: 'RMA #', width: '80px' },
        _ord_no:       { label: 'Order', width: '80px' },
        customer_name: { label: 'Customer' },
        status:        { label: 'Status', width: '110px' },
        reason:        { label: 'Reason' },
        line_count:    { label: 'Lines', width: '70px' },
        _create_ts:    { label: 'Requested', width: '130px' },
    },

    extend: ({ getAll }) => {

        async function getRma(rmaNo) {
            const res = await api.get(`/api/v1/rmas/${rmaNo}`);
            return res.data.content.rma;
        }

        async function updateStatus(rmaNo, status, notes = null) {
            await api.put(`/api/v1/rmas/${rmaNo}/status`, { status, notes });
            await getAll();
        }

        /** @param {Array<{rma_line_id:number, restock:boolean}>} lines */
        async function receiveRma(rmaNo, lines) {
            const res = await api.post(`/api/v1/rmas/${rmaNo}/receive`, { lines });
            await getAll();
            return res.data.content;
        }

        /** amount null → the server refunds what the customer paid. */
        async function refundRma(rmaNo, amount, reason) {
            const res = await api.post(`/api/v1/rmas/${rmaNo}/refund`,
                { amount: amount ?? undefined, reason });
            await getAll();
            return res.data.content;
        }

        return { getRma, updateStatus, receiveRma, refundRma };
    },
});
