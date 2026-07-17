import { ref } from 'vue';
import api from '@/services/api';
import { createListStore } from './storeUtils';

/**
 * Audit trail browser (audit:read). Rows come from the DB audit triggers —
 * this surface is strictly read-only; there are no mutations to expose.
 */
export const useAuditLogStore = createListStore('auditLog', {
    endpoint:         '/api/v1/audit-log',
    collectionKey:    'entries',
    initialQuery:     () => ({ page: 1, pageSize: 25, q: '', entity: '', action: '', from: '', to: '' }),
    loadErrorMessage: 'Failed to load audit entries',

    fieldsConfig: {
        ts:        { label: 'When', width: '170px' },
        actor:     { label: 'Actor' },                    // synthetic: username/email or system
        action:    { label: 'Action', width: '90px' },
        entity:    { label: 'Entity' },
        entity_id: { label: 'Record', width: '110px' },
        ip:        { label: 'IP', width: '130px' },
    },

    extend: () => {
        const entities = ref([]);   // distinct audited tables — filter dropdown

        async function loadEntities() {
            const res = await api.get('/api/v1/audit-log/entities');
            entities.value = res.data.content.entities;
        }

        return { entities, loadEntities };
    },
});
