import { ref } from 'vue';
import { defineStore } from 'pinia';
import api from '@/services/api';
import { watchAuthUser } from './storeUtils';

/**
 * Roles & permissions editor store. Not a createListStore: /api/v1/roles is
 * a small, unpaginated set feeding a master-detail editor, not a table.
 */
export const useRolesStore = defineStore('roles-admin', () => {
    const roles       = ref([]);
    const permissions = ref([]);   // full catalog (read-only by design)
    const loadingCnt  = ref(0);
    const saving      = ref(false);

    function reset() {
        roles.value       = [];
        permissions.value = [];
    }

    async function load() {
        loadingCnt.value++;
        try {
            const [r, p] = await Promise.all([
                api.get('/api/v1/roles'),
                api.get('/api/v1/roles/permissions'),
            ]);
            roles.value       = r.data.content.roles;
            permissions.value = p.data.content.permissions;
        } finally {
            loadingCnt.value--;
        }
    }

    function patchRole(code, updated) {
        const idx = roles.value.findIndex(r => r.code === code);
        if (idx !== -1) Object.assign(roles.value[idx], updated);
    }

    async function withSaving(fn) {
        saving.value = true;
        try { return await fn(); }
        finally { saving.value = false; }
    }

    function createRole(payload) {
        return withSaving(async () => {
            const res  = await api.post('/api/v1/roles', payload);
            const role = res.data.content.role;
            roles.value = [...roles.value, role].sort((a, b) => a.code.localeCompare(b.code));
            return role;
        });
    }

    function updateRole(code, patch) {
        return withSaving(async () => {
            const res = await api.put(`/api/v1/roles/${code}`, patch);
            patchRole(code, res.data.content.role);
        });
    }

    function setPermissions(code, perms) {
        return withSaving(async () => {
            const res = await api.put(`/api/v1/roles/${code}/permissions`, { permissions: perms });
            patchRole(code, { permissions: res.data.content.permissions });
        });
    }

    function deleteRole(code) {
        return withSaving(async () => {
            await api.delete(`/api/v1/roles/${code}`);
            roles.value = roles.value.filter(r => r.code !== code);
        });
    }

    watchAuthUser(null, reset);

    return {
        roles, permissions, loadingCnt, saving,
        load, createRole, updateRole, setPermissions, deleteRole,
    };
});
