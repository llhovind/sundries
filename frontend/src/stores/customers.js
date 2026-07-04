import { ref } from 'vue';
import { defineStore } from 'pinia';
import api from '@/services/api';
import { buildListParams, applyListResponse, watchAuthUser, watchQuery } from './storeUtils';

export const useCustomersStore = defineStore('customers', () => {
    const loadingCnt = ref(0);
    const error      = ref('');
    const customers  = ref([]);
    const totalCnt   = ref(0);
    const totalPgs   = ref(0);
    const curPg      = ref(1);
    const query      = ref({ page: 1, pageSize: 25, q: '' });

    function reset() {
        customers.value = [];
        totalCnt.value  = 0;
        totalPgs.value  = 0;
        curPg.value     = 1;
        query.value     = { page: 1, pageSize: 25, q: '' };
        error.value     = '';
    }

    function getCustomers() {
        loadingCnt.value++;
        error.value = '';
        return api.get('/api/v1/customers?' + buildListParams(query.value))
            .then(res => {
                const c         = res.data.content;
                customers.value = c.customers;
                applyListResponse({ totalCnt, curPg, totalPgs }, c);
            })
            .catch(err => {
                error.value = err.response?.data?.message || 'Failed to load customers';
                return Promise.reject(err);
            })
            .finally(() => { loadingCnt.value--; });
    }

    async function getCustomer(id) {
        const res = await api.get(`/api/v1/customers/${id}`);
        return res.data.content.customer;
    }

    watchQuery(query, () => getCustomers().catch(() => {}));
    watchAuthUser(null, reset);

    const fieldsConfig = {
        id:    { label: '#' },
        name:  { label: 'Name' },
        email: { label: 'Email', format: 'fallback' },
        city:  { label: 'City',  format: 'fallback' },
        state: { label: 'State', format: 'fallback' },
        phone: { label: 'Phone', format: 'fallback' },
    };

    return {
        loadingCnt, error, customers, totalCnt, totalPgs, curPg, query,
        getCustomers, getCustomer, fieldsConfig, getAll: getCustomers,
    };
});
