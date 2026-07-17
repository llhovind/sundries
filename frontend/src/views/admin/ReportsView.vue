<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useReportsStore } from '@/stores/reports';

/**
 * Reports — fully generic over the backend report catalog. Categories,
 * reports, parameter controls, and result columns all come from the
 * registry's descriptors, so a report added on the backend appears here
 * with zero UI changes, and the catalog only ever contains what the
 * current user's permissions allow.
 */
const store = useReportsStore();

const selected   = ref(null);    // report descriptor from the catalog
const params     = ref({});      // current parameter values
const results    = ref(null);    // { columns, rows } — immediate results or a viewed run
const runs       = ref([]);      // saved runs (stored reports)
const viewedRun  = ref(null);    // run_no whose rows are displayed
const notice     = ref('');

const POLL_MS = 3000;
let pollTimer = null;

const isStored = computed(() => selected.value?.mode === 'stored');
const hasActiveRuns = computed(() => runs.value.some(r => ['queued', 'running'].includes(r.status)));

onMounted(async () => {
    await store.loadCatalog().catch(() => {});
    const first = store.categories[0]?.reports[0];
    if (first) pick(first);
});
onUnmounted(stopPolling);

function pick(report) {
    stopPolling();
    selected.value  = report;
    results.value   = null;
    runs.value      = [];
    viewedRun.value = null;
    notice.value    = '';
    params.value    = Object.fromEntries(report.params.map(p => [p.name, p.default ?? '']));
    if (report.mode === 'stored') refreshRuns();
    else runReport();
}

async function runReport() {
    results.value = null;
    try {
        const content = await store.runImmediate(selected.value.slug, params.value);
        results.value = { columns: content.columns, rows: content.rows };
    } catch { /* store.error is shown */ }
}

async function generate() {
    notice.value = '';
    try {
        await store.startRun(selected.value.slug, params.value);
        notice.value = 'Report queued — it is generated in the background and you will be emailed when it is ready.';
        await refreshRuns();
    } catch { /* store.error is shown */ }
}

async function refreshRuns() {
    try {
        runs.value = await store.listRuns(selected.value.slug);
    } catch { return; }
    // Keep polling while any run is still being generated.
    if (hasActiveRuns.value && !pollTimer) {
        pollTimer = setInterval(async () => {
            runs.value = await store.listRuns(selected.value.slug).catch(() => runs.value);
            if (!hasActiveRuns.value) stopPolling();
        }, POLL_MS);
    }
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function viewRun(run) {
    try {
        const full = await store.getRun(selected.value.slug, run.run_no);
        results.value   = { columns: full.columns, rows: full.rows || [] };
        viewedRun.value = run.run_no;
    } catch { /* store.error is shown */ }
}

function download(run) {
    store.downloadRun(selected.value.slug, run.run_no).catch(() => {});
}

// ── Generic cell formatting driven by the report's column descriptors ────────
// NUMERIC columns arrive as strings (JSON has no decimal type), so coerce.
function fmt(value, format) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    switch (format) {
        case 'int':      return Number.isFinite(n) ? String(Math.trunc(n)) : '—';
        case 'qty':      return Number.isFinite(n) ? n.toFixed(1) : '—';
        case 'money':    return Number.isFinite(n) ? '$ ' + n.toFixed(2) : '—';
        case 'date':     return String(value).slice(0, 10);
        case 'datetime': return new Date(value).toLocaleString();
        case 'bool':     return value === true || value === 'true' ? '✓' : '—';
        default:         return String(value);
    }
}

const STATUS_PILL = { queued: 'accent', running: 'warn', succeeded: 'ok', failed: 'danger' };
const fmtTs = ts => ts ? new Date(ts).toLocaleString() : '—';
</script>

<template>
  <div>
    <h2>Reports</h2>
    <p v-if="!store.categories.length && !store.error" class="muted">
      Loading report catalog…
    </p>

    <div v-if="store.categories.length" class="layout">
      <!-- Catalog: categories → reports (already filtered by permissions) -->
      <nav class="catalog">
        <div v-for="cat in store.categories" :key="cat.code" class="category">
          <h3>{{ cat.label }}</h3>
          <button v-for="r in cat.reports" :key="r.slug" class="report-link"
                  :class="{ active: selected?.slug === r.slug }" @click="pick(r)">
            {{ r.name }}
          </button>
        </div>
      </nav>

      <!-- Selected report -->
      <section v-if="selected" class="detail">
        <header class="detail-head">
          <div>
            <h3>{{ selected.name }}</h3>
            <p class="muted">{{ selected.descr }}</p>
          </div>
          <span v-if="selected.schedule" class="pill accent">runs on a schedule</span>
        </header>

        <!-- Parameters — rendered from the report's declarations -->
        <div class="filters" v-if="selected.params.length || isStored">
          <label v-for="p in selected.params" :key="p.name">
            {{ p.label }}
            <select v-if="p.type === 'select'" v-model="params[p.name]" class="input">
              <option v-for="o in p.options" :key="o" :value="o">{{ o }}</option>
            </select>
            <input v-else-if="p.type === 'date'"   v-model="params[p.name]" type="date"   class="input" />
            <input v-else-if="p.type === 'month'"  v-model="params[p.name]" type="month"  class="input" />
            <input v-else                          v-model="params[p.name]" type="number" class="input" />
          </label>
          <button v-if="!isStored" class="btn" @click="runReport">Run</button>
          <button v-else class="btn" :disabled="store.loadingCnt > 0" @click="generate">Generate now</button>
        </div>

        <p v-if="store.error" class="error-text">{{ store.error }}</p>
        <p v-if="notice" class="muted">{{ notice }}</p>

        <!-- Saved runs (stored reports) -->
        <template v-if="isStored">
          <h4>Saved reports</h4>
          <p v-if="!runs.length" class="muted">No saved reports yet — generate one, or wait for the schedule.</p>
          <table v-else class="table-plain">
            <thead>
              <tr><th>#</th><th>Status</th><th>Trigger</th><th>Requested</th><th>Finished</th><th>Rows</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="run in runs" :key="run.run_no">
                <td>{{ run.run_no }}</td>
                <td>
                  <span class="pill" :class="STATUS_PILL[run.status]">{{ run.status }}</span>
                  <span v-if="run.error" class="error-text err-detail">{{ run.error }}</span>
                </td>
                <td>{{ run.trigger }}</td>
                <td>{{ fmtTs(run._create_ts) }}</td>
                <td>{{ fmtTs(run.finished_at) }}</td>
                <td>{{ run.row_count ?? '—' }}</td>
                <td class="actions">
                  <button v-if="run.status === 'succeeded'" class="btn" @click="viewRun(run)">View</button>
                  <button v-if="run.status === 'succeeded'" class="btn" @click="download(run)">CSV</button>
                </td>
              </tr>
            </tbody>
          </table>
          <h4 v-if="viewedRun">Run #{{ viewedRun }}</h4>
        </template>

        <!-- Results — immediate output or a viewed saved run -->
        <template v-if="results">
          <p v-if="!results.rows.length" class="muted">No data for this selection.</p>
          <div v-else class="results-scroll">
            <table class="table-plain">
              <thead>
                <tr><th v-for="c in results.columns" :key="c.key">{{ c.label }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="(row, i) in results.rows" :key="i">
                  <td v-for="c in results.columns" :key="c.key">{{ fmt(row[c.key], c.format) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
h2 { margin-bottom: 0.6rem; }
.layout { display: flex; gap: 1.2rem; align-items: flex-start; }
.catalog { flex: 0 0 12rem; display: flex; flex-direction: column; gap: 0.8rem; }
.category h3 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;
               color: var(--color-text-muted); margin-bottom: 0.3rem; }
.report-link { display: block; width: 100%; text-align: left; background: none; border: none;
               padding: 0.3rem 0.5rem; border-radius: 6px; cursor: pointer; color: inherit; }
.report-link:hover  { background: var(--accent-soft); }
.report-link.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.detail { flex: 1; min-width: 0; }
.detail-head { display: flex; justify-content: space-between; align-items: start; gap: 1rem; }
.detail-head h3 { margin: 0; }
h4 { margin: 1rem 0 0.5rem; }
.filters { display: flex; gap: 1rem; margin: 0.8rem 0; align-items: end; flex-wrap: wrap; }
.filters label { display: flex; flex-direction: column; font-size: 0.8rem;
                 color: var(--color-text-muted); gap: 0.2rem; }
.actions { display: flex; gap: 0.3rem; }
.err-detail { display: block; font-size: 0.75rem; }
.results-scroll { overflow-x: auto; }
</style>
