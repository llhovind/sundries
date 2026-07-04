import api from '@/services/api';
import { createListStore } from './storeUtils';

export const usePromotionsStore = createListStore('promotions', {
    endpoint:         '/api/v1/promotions',
    collectionKey:    'promotions',
    loadErrorMessage: 'Failed to load promotions',

    // The promotions endpoint has no free-text search; status is its only filter.
    initialQuery: () => ({ page: 1, pageSize: 25, status: '' }),

    fieldsConfig: {
        code:             { label: 'Code' },
        name:             { label: 'Name' },
        promo_type:       { label: 'Discount' },
        starts_at:        { label: 'Window' },
        redemption_count: { label: 'Used' },
        status:           { label: 'Status' },
    },

    extend: ({ getAll }) => ({
        async createPromotion(body) {
            await api.post('/api/v1/promotions', body);
            await getAll();
        },

        async togglePromotionStatus(promo) {
            await api.put(`/api/v1/promotions/${promo.promo_no}`, {
                status: promo.status === 'active' ? 'inactive' : 'active',
            });
            await getAll();
        },
    }),
});
