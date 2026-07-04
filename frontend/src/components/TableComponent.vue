<script setup>
import { computed, ref, useSlots } from 'vue';
import PaginationBar from '@/components/PaginationBar.vue';
import { useTableColumns } from '@/composables/useTableColumns';
import { usePagination } from '@/composables/usePagination';

const props = defineProps({
    store:         { type: Object,  required: true },
    rows:          { type: Array,   required: true },
    displayFields: { type: Array,   required: true },
    rowKey:        { type: String,  default: 'id' },
    label:         { type: String,  default: 'Records Found' },
    selectable:    { type: String,  default: null },   // 'single' | 'multi' | null
    clickable:     { type: Boolean, default: false },  // show pointer cursor without selectable
});

const emit = defineEmits(['row-click', 'update:selected']);
const slots = useSlots();

// ── Column config (from store schema, filtered to the view's chosen subset) ──

const { fields_config, displayFields, colCount, cellValue } =
    useTableColumns(props.store.fieldsConfig, props.displayFields);

// ── Pagination ────────────────────────────────────────────────────────────────

const { pgArry } = usePagination(
    computed(() => props.store.curPg),
    computed(() => props.store.totalPgs),
);

function onGoto(page) {
    clearSelection();
    props.store.query.page = page;
}

function onPageSize(size) {
    clearSelection();
    props.store.query.page     = 1;
    props.store.query.pageSize = size;
}

// ── Selection state (Set of rowKey values for O(1) lookup) ───────────────────

const selectedKeys = ref(new Set());

const selectedRows = computed(() =>
    props.rows.filter(r => selectedKeys.value.has(r[props.rowKey]))
);

const allSelected = computed(() =>
    props.rows.length > 0 &&
    props.rows.every(r => selectedKeys.value.has(r[props.rowKey]))
);

const someSelected = computed(() =>
    !allSelected.value &&
    props.rows.some(r => selectedKeys.value.has(r[props.rowKey]))
);

function toggleRow(row) {
    const key  = row[props.rowKey];
    const next = new Set(selectedKeys.value);
    if (next.has(key)) {
        next.delete(key);
    } else {
        if (props.selectable === 'single') next.clear();
        next.add(key);
    }
    selectedKeys.value = next;
    emit('update:selected', selectedRows.value);
}

function toggleAll() {
    selectedKeys.value = allSelected.value
        ? new Set()
        : new Set(props.rows.map(r => r[props.rowKey]));
    emit('update:selected', selectedRows.value);
}

function clearSelection() {
    selectedKeys.value = new Set();
    emit('update:selected', []);
}

// ── Derived flags ─────────────────────────────────────────────────────────────

const isLoading     = computed(() => props.store.loadingCnt > 0);
const hasRowActions = computed(() => !!slots['row-actions']);
const isMulti       = computed(() => props.selectable === 'multi');
const isSelectable  = computed(() => props.selectable === 'single' || props.selectable === 'multi');
const isClickable   = computed(() => isSelectable.value || props.clickable);

const totalColCount = computed(() =>
    colCount.value + (isMulti.value ? 1 : 0) + (hasRowActions.value ? 1 : 0)
);

function onRowClick(row) {
    if (isSelectable.value) toggleRow(row);
    else emit('row-click', row);
}
</script>

<template>
    <div class="table-component">

        <!-- Pagination bar (above table, consistent with existing view layout) -->
        <PaginationBar
            :curPage="store.curPg"
            :totalPages="store.totalPgs"
            :totalCnt="store.totalCnt"
            :pageSize="store.query.pageSize"
            :pgArry="pgArry"
            :label="label"
            @goto="onGoto"
            @update:pageSize="onPageSize"
        >
            <slot name="filters" />
        </PaginationBar>

        <!-- Bulk action bar: only shown in multi-select mode when rows are selected -->
        <div v-if="isMulti && selectedRows.length" class="tc-bulk-bar">
            <span class="tc-bulk-count">
                {{ selectedRows.length }} row{{ selectedRows.length !== 1 ? 's' : '' }} selected
            </span>
            <slot name="bulk-actions" :selected="selectedRows" :clearSelection="clearSelection" />
            <button class="tc-bulk-clear" @click="clearSelection">Clear</button>
        </div>

        <!-- Scrollable table -->
        <div class="tc-scroll">
            <table class="tc-table">
                <thead>
                    <tr>
                        <th v-if="isMulti" class="tc-col--check">
                            <input
                                type="checkbox"
                                :checked="allSelected"
                                :indeterminate="someSelected"
                                @change="toggleAll"
                            />
                        </th>
                        <th
                            v-for="key in displayFields" :key="key"
                            :style="fields_config[key]?.width ? { width: fields_config[key].width } : {}"
                            :class="fields_config[key]?.class"
                        >
                            {{ fields_config[key]?.label ?? key }}
                        </th>
                        <th v-if="hasRowActions" class="tc-col--actions"></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!rows.length">
                        <td :colspan="totalColCount" class="tc-empty">
                            <slot name="empty">No records found.</slot>
                        </td>
                    </tr>
                    <tr
                        v-for="row in rows" :key="row[rowKey]"
                        :class="{
                            'tc-row--selected':  selectedKeys.has(row[rowKey]),
                            'tc-row--clickable': isClickable,
                        }"
                        @click="onRowClick(row)"
                    >
                        <td v-if="isMulti" class="tc-col--check" @click.stop>
                            <input
                                type="checkbox"
                                :checked="selectedKeys.has(row[rowKey])"
                                @change="toggleRow(row)"
                            />
                        </td>
                        <td
                            v-for="key in displayFields" :key="key"
                            :class="fields_config[key]?.class"
                            :title="fields_config[key]?.title ? String(row[key] ?? '') : undefined"
                        >
                            <template v-if="$slots['cell-' + key]">
                                <slot :name="'cell-' + key" :row="row" :value="row[key]" />
                            </template>
                            <template v-else>{{ cellValue(row, key) }}</template>
                        </td>
                        <td v-if="hasRowActions" class="tc-col--actions" @click.stop>
                            <slot name="row-actions" :row="row" />
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <!-- Loading overlay (absolute, does not shift layout) -->
        <div class="tc-overlay" :class="{ 'tc-overlay--active': isLoading }">
            <div class="tc-overlay__message">LOADING DATA&hellip;</div>
        </div>

    </div>
</template>

<style lang="scss" scoped>
.table-component {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    position: relative;
}

// ── Bulk action bar ───────────────────────────────────────────────────────────

.tc-bulk-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 0.75rem;
    background: #ede8f8;
    border: 1px solid #c5b5e8;
    border-radius: 4px;
    margin-bottom: 0.25rem;
    font-size: 0.875rem;
}

.tc-bulk-count {
    font-weight: 600;
    color: #3a2060;
    margin-right: auto;
}

.tc-bulk-clear {
    background: none;
    border: 1px solid #9b86c8;
    border-radius: 4px;
    padding: 0.2rem 0.6rem;
    cursor: pointer;
    color: #5a3e8a;
    font-size: 0.8rem;
    &:hover { background: #d9cff0; }
}

// ── Scrollable table wrapper ──────────────────────────────────────────────────

.tc-scroll {
    flex: 1;
    overflow-y: auto;
    position: relative;
}

// ── Table ─────────────────────────────────────────────────────────────────────

.tc-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 0.9rem;

    thead tr th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: royalblue;
        color: #fff;
        text-align: left;
        padding: 0.4rem 0.6rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        border-left: 1px solid rgba(255, 255, 255, 0.3);

        &:first-child { border-left: none; }
    }

    tbody tr {
        td {
            padding: 0.35rem 0.6rem;
            border-bottom: 1px solid #eee;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        &.tc-row--clickable { cursor: pointer; }

        &:hover td { background: rgba(96, 176, 250, 0.15); }

        &.tc-row--selected td { background: rgba(90, 62, 138, 0.1); }

        &:last-child td { border-bottom: none; }
    }
}

// ── Column variants ───────────────────────────────────────────────────────────

.tc-col--check {
    width: 2.25rem;
    text-align: center;
}

.tc-col--actions {
    width: auto;
    text-align: right;
    white-space: nowrap;
}

.rAlign { text-align: right; }

// ── Empty state ───────────────────────────────────────────────────────────────

.tc-empty {
    text-align: center;
    color: #999;
    padding: 2rem 1rem;
    cursor: default;
    font-style: italic;
}

// ── Loading overlay ───────────────────────────────────────────────────────────

.tc-overlay {
    display: none;
    position: absolute;
    inset: 0;
    z-index: 10;
    background: rgba(128, 128, 128, 0.5);
    align-items: center;
    justify-content: center;

    &--active { display: flex; }

    &__message {
        padding: 2em;
        width: 20em;
        background: rgba(243, 225, 64, 0.85);
        color: #000;
        font-size: x-large;
        border: 3px solid #333;
        text-align: center;
        animation: tc-pulse 0.5s infinite alternate;
    }
}

@keyframes tc-pulse {
    from { color: rgba(0, 0, 0, 1); }
    to   { color: rgba(0, 0, 0, 0.1); }
}
</style>
