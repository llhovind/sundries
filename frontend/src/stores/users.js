import { ref } from 'vue';
import api from '@/services/api';
import { createListStore } from './storeUtils';

export const useUsersStore = createListStore('users', {
    endpoint:         '/api/v1/users',
    collectionKey:    'users',
    loadErrorMessage: 'Failed to load users',

    // Staff-only by default: customers have no special permissions, so the
    // admin view starts scoped to accounts that can actually hold any.
    // buildListParams drops false/empty values, so staff:false sends nothing.
    initialQuery: () => ({ page: 1, pageSize: 25, q: '', staff: true, role: '', status: '' }),

    fieldsConfig: {
        id:         { label: '#' },
        username:   { label: 'Username' },
        email:      { label: 'Email', format: 'fallback' },
        roles:      { label: 'Roles' },
        status:     { label: 'Status' },
        _create_ts: { label: 'Created', format: 'date' },
    },

    extend: ({ rows, getAll }) => {
        const saving = ref(null);   // id of user currently being mutated
        const roles  = ref([]);     // roles are data, not a hardcoded list — RBAC tables define them

        function patchRow(id, updated) {
            const idx = rows.value.findIndex(u => u.id === id);
            if (idx !== -1) Object.assign(rows.value[idx], updated);
        }

        async function updateUser(id, patch) {
            saving.value = id;
            try {
                const res  = await api.put(`/api/v1/users/${id}`, patch);
                const user = res.data.content.user;
                // Setting the primary role resets all grants to exactly that
                // role (backend semantics) — mirror it without a refetch.
                patchRow(id, patch.role ? { ...user, roles: [patch.role] } : user);
            } finally {
                saving.value = null;
            }
        }

        async function createUser(payload) {
            const res = await api.post('/api/v1/users', payload);
            await getAll();   // refetch: the new user's page position is unknown
            return res.data.content.user;
        }

        async function grantRole(id, role) {
            saving.value = id;
            try {
                const res = await api.post(`/api/v1/users/${id}/roles`, { role });
                patchRow(id, { roles: res.data.content.roles });
            } finally {
                saving.value = null;
            }
        }

        async function revokeRole(id, role) {
            saving.value = id;
            try {
                const res = await api.delete(`/api/v1/users/${id}/roles/${role}`);
                patchRow(id, { roles: res.data.content.roles });
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

        return { saving, roles, loadRoles, createUser, updateUser, deactivateUser, grantRole, revokeRole };
    },
});
