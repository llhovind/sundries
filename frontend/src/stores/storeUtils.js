/**
 * Shared utilities for Pinia list stores.
 * All stores that fetch paginated lists use these functions so that
 * parameter building, response parsing, and auth lifecycle are defined
 * exactly once.
 */
import { ref, watch } from 'vue';
import { defineStore } from 'pinia';
import api from '@/services/api';
import { useAuthStore } from './auth';

/**
 * Wires a list store to the authenticated user lifecycle.
 *
 * - Calls onLogin()  when a user session starts, including immediately if one
 *   is already active at the time the store is first instantiated.
 * - Calls onLogout() when the session ends, so stale data from a previous
 *   user is cleared before a new user can see it.
 *
 * Replaces the bare `getFoo().catch(() => {})` eager-init pattern that broke
 * store isolation between users (Pinia stores are singletons — they never
 * re-initialise on their own when a different user logs in).
 *
 * @param {() => void} onLogin   - e.g. () => fetchData().catch(() => {})
 * @param {() => void} onLogout  - store's reset() function
 */
export function watchAuthUser(onLogin, onLogout) {
    const auth = useAuthStore();
    watch(
        () => auth.user,
        (user) => { if (user) onLogin?.(); else onLogout(); },
        { immediate: true },
    );
}

/**
 * Watches a store's query ref and calls fetchFn when it changes, but only
 * while a user session is active. Prevents API calls fired by reset() on
 * logout, which replaces the query object and would otherwise trigger the
 * watcher against an unauthenticated session.
 *
 * @param {import('vue').Ref} query  - the store's query ref
 * @param {() => void}        fetchFn
 */
export function watchQuery(query, fetchFn) {
    const auth = useAuthStore();
    watch(query, () => { if (auth.user) fetchFn(); }, { deep: true });
}

/**
 * Build a URLSearchParams string from a store query object.
 * Skips keys whose value is empty string, false, or null/undefined.
 *
 * @param {object} query  - plain object (e.g. store's query.value)
 * @returns {string}      - query string without leading '?'
 */
export function buildListParams(query) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
        if (v !== '' && v !== false && v != null) params.set(k, v);
    });
    return params.toString();
}

/**
 * Apply a standard paginated list response to store state refs.
 * Every list endpoint returns { <collection>, total, page, pageSize }.
 *
 * @param {{ totalCnt, curPg, totalPgs }} refs  - reactive refs from the store
 * @param {object} content                      - res.data.content from the API
 */
export function applyListResponse(refs, content) {
    refs.totalCnt.value = content.total;
    refs.curPg.value    = content.page;
    refs.totalPgs.value = Math.max(1, Math.ceil(content.total / content.pageSize));
}

/**
 * Extract the human-readable message from a standard API error response.
 * The backend envelope puts it at data.outcome.message; data.message is
 * kept as a fallback for non-envelope errors (e.g. proxies).
 *
 * @param {unknown} err       - axios error
 * @param {string}  fallback  - message when the response carries none
 * @returns {string}
 */
export function apiErrorMessage(err, fallback) {
    return err?.response?.data?.outcome?.message
        || err?.response?.data?.message
        || fallback;
}

/**
 * Factory for paginated list stores. Defines the standard contract that
 * TableComponent consumes — query / curPg / totalPgs / totalCnt /
 * loadingCnt / error / fieldsConfig / getAll — so list behaviour
 * (pagination, search, future filters) is implemented exactly once.
 *
 * The query object drives fetching: any mutation (page, pageSize, q,
 * or a future filter key) triggers a refetch via watchQuery. Keys with
 * empty-string/null values are omitted from the request.
 *
 * @param {string} storeId - unique Pinia store id
 * @param {object} options
 * @param {string}   options.endpoint          - list endpoint, e.g. '/api/v1/orders'
 * @param {string}   options.collectionKey     - key of the row array in the API response
 *                                               content AND the name the rows are exposed
 *                                               under on the store (e.g. store.orders)
 * @param {object}   options.fieldsConfig      - column config consumed by TableComponent
 * @param {() => object} [options.initialQuery] - factory for the initial query object
 * @param {string}   [options.loadErrorMessage] - error shown when the list fetch fails
 * @param {(ctx: object) => object} [options.extend]
 *        Adds store-specific state/actions. Receives the base context
 *        ({ rows, loadingCnt, error, totalCnt, totalPgs, curPg, query,
 *        getAll, reset }); whatever it returns is merged into the store.
 * @returns {import('pinia').StoreDefinition}
 */
export function createListStore(storeId, {
    endpoint,
    collectionKey,
    fieldsConfig,
    initialQuery = () => ({ page: 1, pageSize: 25, q: '' }),
    loadErrorMessage = 'Failed to load records',
    extend = null,
}) {
    return defineStore(storeId, () => {
        const loadingCnt = ref(0);
        const error      = ref('');
        const rows       = ref([]);
        const totalCnt   = ref(0);
        const totalPgs   = ref(0);
        const curPg      = ref(1);
        const query      = ref(initialQuery());

        function reset() {
            rows.value     = [];
            totalCnt.value = 0;
            totalPgs.value = 0;
            curPg.value    = 1;
            query.value    = initialQuery();
            error.value    = '';
        }

        function getAll() {
            loadingCnt.value++;
            error.value = '';
            return api.get(endpoint + '?' + buildListParams(query.value))
            .then(res => {
                const content = res.data.content;
                rows.value    = content[collectionKey];
                applyListResponse({ totalCnt, curPg, totalPgs }, content);
            })
            .catch(err => {
                error.value = apiErrorMessage(err, loadErrorMessage);
                return Promise.reject(err);
            })
            .finally(() => { loadingCnt.value--; });
        }

        watchQuery(query, () => getAll().catch(() => {}));
        watchAuthUser(null, reset);

        const base = {
            loadingCnt, error, totalCnt, totalPgs, curPg, query,
            fieldsConfig, getAll, reset,
            [collectionKey]: rows,
        };
        const extra = extend
            ? extend({ ...base, rows })
            : {};
        return { ...base, ...extra };
    });
}
