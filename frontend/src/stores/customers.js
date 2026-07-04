import api from '@/services/api';
import { createListStore } from './storeUtils';

export const useCustomersStore = createListStore('customers', {
    endpoint:         '/api/v1/customers',
    collectionKey:    'customers',
    loadErrorMessage: 'Failed to load customers',

    fieldsConfig: {
        id:    { label: '#' },
        name:  { label: 'Name' },
        email: { label: 'Email', format: 'fallback' },
        city:  { label: 'City',  format: 'fallback' },
        state: { label: 'State', format: 'fallback' },
        phone: { label: 'Phone', format: 'fallback' },
    },

    extend: () => ({
        async getCustomer(id) {
            const res = await api.get(`/api/v1/customers/${id}`);
            return res.data.content.customer;
        },
    }),
});
