import { ref } from 'vue';
import api from '@/services/api';
import { createListStore } from './storeUtils';

export const useUsersStore = createListStore('users', {
    endpoint:         '/api/v1/users',
    collectionKey:    'users',
    loadErrorMessage: 'Failed to load users',

    fieldsConfig: {
        id:         { label: '#' },
        username:   { label: 'Username' },
        email:      { label: 'Email', format: 'fallback' },
        role:       { label: 'Role' },
        status:     { label: 'Status' },
        _create_ts: { label: 'Created', format: 'date' },
    },

    extend: ({ rows }) => {
        const saving = ref(null);   // id of user currently being mutated
        const roles  = ref([]);     // roles are data, not a hardcoded list — RBAC tables define them

        function patchRow(id, updated) {
            const idx = rows.value.findIndex(u => u.id === id);
            if (idx !== -1) Object.assign(rows.value[idx], updated);
        }

        async function updateUser(id, patch) {
            saving.value = id;
            try {
                const res = await api.put(`/api/v1/users/${id}`, patch);
                patchRow(id, res.data.content.user);
            } finally {
                saving.value = null;
            }
        }

        async function deactivateUser(id) {
            saving.value = id;
            try {
                const res = await api.delete(`/api/v1/users/${id}`);
                patchRow(id, res.data.content.user);
            } finally {
                saving.value = null;
            }
        }

        async function loadRoles() {
            try {
                const res = await api.get('/api/v1/users/roles');
                roles.value = res.data.content.roles;
            } catch {
                roles.value = [{ code: 'customer' }, { code: 'admin' }];   // safe fallback
            }
        }

        return { saving, roles, loadRoles, updateUser, deactivateUser };
    },
});
