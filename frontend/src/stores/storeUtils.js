/**
 * Shared utilities for Pinia list stores.
 * All stores that fetch paginated lists use these functions so that
 * parameter building, response parsing, and auth lifecycle are defined
 * exactly once.
 */
import { watch } from 'vue';
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
