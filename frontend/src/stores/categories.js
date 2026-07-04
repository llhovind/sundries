import { ref } from 'vue';
import { defineStore } from 'pinia';
import api from '@/services/api';
import { buildListParams, applyListResponse, watchAuthUser, watchQuery } from './storeUtils';

export const useCategoriesStore = defineStore('categories', () => {
    const loadingCnt    = ref(0);
    const error         = ref('');
    const categories    = ref([]);
    const allCategories = ref([]);  // full un-paginated list for dropdowns
    const totalCnt      = ref(0);
    const totalPgs      = ref(0);
    const curPg         = ref(1);
    const query         = ref({ page: 1, pageSize: 50, q: '' });

    function reset() {
        categories.value    = [];
        allCategories.value = [];
        totalCnt.value      = 0;
        totalPgs.value      = 0;
        curPg.value         = 1;
        query.value         = { page: 1, pageSize: 50, q: '' };
        error.value         = '';
    }

    function getCategories() {
        loadingCnt.value++;
        error.value = '';
        return api.get('/api/v1/categories?' + buildListParams(query.value))
            .then(res => {
                const c          = res.data.content;
                categories.value = c.categories;
                applyListResponse({ totalCnt, curPg, totalPgs }, c);
            })
            .catch(err => {
                error.value = err.response?.data?.message || 'Failed to load categories';
                return Promise.reject(err);
            })
            .finally(() => { loadingCnt.value--; });
    }

    async function getAll() {
        if (allCategories.value.length > 0) return allCategories.value;
        const res = await api.get('/api/v1/categories', { params: { pageSize: 9999 } });
        allCategories.value = res.data.content.categories;
        return allCategories.value;
    }

    async function createCategory(name) {
        await api.post('/api/v1/categories', { name });
        allCategories.value = [];
        await getCategories();
    }

    async function updateCategory(id, name) {
        await api.put(`/api/v1/categories/${id}`, { name });
        allCategories.value = [];
        await getCategories();
    }

    async function deleteCategory(id) {
        await api.delete(`/api/v1/categories/${id}`);
        allCategories.value = [];
        await getCategories();
    }

    watchQuery(query, () => getCategories().catch(() => {}));
    watchAuthUser(null, reset);

    return {
        loadingCnt, error, categories, allCategories, totalCnt, totalPgs, curPg, query,
        getCategories, getAll, createCategory, updateCategory, deleteCategory,
    };
});
