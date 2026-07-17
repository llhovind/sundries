import { ref } from 'vue';
import { defineStore } from 'pinia';
import api from '@/services/api';
import { watchAuthUser, buildListParams, apiErrorMessage } from './storeUtils';

/**
 * Reporting store — a thin client over the generic reporting API.
 *
 * The backend report registry describes every report (category, params,
 * columns, mode), so this store carries no per-report knowledge: the catalog
 * drives the whole Reports UI generically, and the catalog only ever
 * contains what the current user's permissions allow.
 */
export const useReportsStore = defineStore('reports', () => {
    const categories = ref([]);
    const loadingCnt = ref(0);
    const error      = ref('');

    function reset() {
        categories.value = [];
        error.value      = '';
    }

    async function withLoading(fn, failMessage) {
        loadingCnt.value++;
        error.value = '';
        try {
            return await fn();
        } catch (err) {
            error.value = apiErrorMessage(err, failMessage);
            throw err;
        } finally {
            loadingCnt.value--;
        }
    }

    /** Categories + reports visible to the current user. */
    function loadCatalog() {
        return withLoading(async () => {
            const res = await api.get('/api/v1/reports');
            categories.value = res.data.content.categories;
        }, 'Failed to load the report catalog');
    }

    /** Execute an immediate report. @returns {{columns, rows, params}} */
    function runImmediate(slug, params) {
        return withLoading(async () => {
            const qs = buildListParams(params);
            const res = await api.get(`/api/v1/reports/${slug}/results${qs ? '?' + qs : ''}`);
            return res.data.content;
        }, 'Report failed');
    }

    /** Queue a stored-report generation. @returns the queued run */
    function startRun(slug, params) {
        return withLoading(async () => {
            const res = await api.post(`/api/v1/reports/${slug}/runs`, params);
            return res.data.content.run;
        }, 'Failed to start the report');
    }

    /** Saved runs for a stored report, newest first. */
    function listRuns(slug) {
        return withLoading(async () => {
            const res = await api.get(`/api/v1/reports/${slug}/runs`);
            return res.data.content.runs;
        }, 'Failed to load saved reports');
    }

    /** One saved run including its rows (when succeeded). */
    function getRun(slug, runNo) {
        return withLoading(async () => {
            const res = await api.get(`/api/v1/reports/${slug}/runs/${runNo}`);
            return res.data.content.run;
        }, 'Failed to load the report run');
    }

    /**
     * Download a run as CSV. Fetched through the API client (the download
     * needs the Authorization header) and handed to the browser as a blob.
     */
    async function downloadRun(slug, runNo) {
        const res = await api.get(
            `/api/v1/reports/${slug}/runs/${runNo}/download`,
            { responseType: 'blob' },
        );
        const url = URL.createObjectURL(res.data);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${slug}-${runNo}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    watchAuthUser(null, reset);

    return {
        categories, loadingCnt, error,
        loadCatalog, runImmediate, startRun, listRuns, getRun, downloadRun,
    };
});
