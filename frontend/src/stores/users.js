import { ref } from 'vue';
import { defineStore } from 'pinia';
import api from '@/services/api';
import { applyListResponse } from './storeUtils';

export const useUsersStore = defineStore('users', () => {
    const loadingCnt = ref(0);
    const error      = ref('');
    const saving     = ref(null);  // id of user currently being mutated
    const users      = ref([]);
    const totalCnt   = ref(0);
    const totalPgs   = ref(0);
    const curPg      = ref(1);

    async function getUsers(page = 1, q = '', pageSize = 25) {
        loadingCnt.value++;
        error.value = '';
        try {
            const params = { page, pageSize };
            if (q) params.q = q;
            const res = await api.get('/api/v1/users', { params });
            const c   = res.data.content;
            users.value = c.users;
            applyListResponse({ totalCnt, curPg, totalPgs }, c);
        } catch (err) {
            error.value = err.response?.data?.message || 'Failed to load users';
            throw err;
        } finally {
            loadingCnt.value--;
        }
    }

    async function updateUser(id, patch) {
        saving.value = id;
        try {
            const res     = await api.put(`/api/v1/users/${id}`, patch);
            const updated = res.data.content.user;
            const idx     = users.value.findIndex(u => u.id === id);
            if (idx !== -1) Object.assign(users.value[idx], updated);
        } finally {
            saving.value = null;
        }
    }

    async function deactivateUser(id) {
        saving.value = id;
        try {
            const res     = await api.delete(`/api/v1/users/${id}`);
            const updated = res.data.content.user;
            const idx     = users.value.findIndex(u => u.id === id);
            if (idx !== -1) Object.assign(users.value[idx], updated);
        } finally {
            saving.value = null;
        }
    }

    return {
        loadingCnt, error, saving, users, totalCnt, totalPgs, curPg,
        getUsers, updateUser, deactivateUser,
    };
});
