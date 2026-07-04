<script setup>
/**
 * PaginationBar — reusable pagination controls.
 *
 * Props:
 *   curPage         – current page number
 *   totalPages      – total number of pages
 *   totalCnt        – total record count (for display)
 *   pageSize        – current rows-per-page setting
 *   pgArry          – array of page numbers to render (from usePagination)
 *   pageSizeOptions – selectable rows-per-page values
 *   label           – text after the count, e.g. "Total Items Found"
 *
 * Emits:
 *   goto(page)            – navigate to a specific page number
 *   update:pageSize(size) – user changed rows per page
 *
 * Slot (default): optional left-side filter content (e.g. a checkbox)
 */
const props = defineProps({
    curPage:         { type: Number, required: true },
    totalPages:      { type: Number, required: true },
    totalCnt:        { type: Number, default: 0 },
    pageSize:        { type: Number, required: true },
    pgArry:          { type: Array,  required: true },
    pageSizeOptions: { type: Array,  default: () => [10, 20, 25, 35, 50] },
    label:           { type: String, default: 'Records Found' },
});

const emit = defineEmits(['goto', 'update:pageSize']);

function nav(pg) {
    if      (pg === 'prev') pg = Math.max(1, props.curPage - 1);
    else if (pg === 'next') pg = Math.min(props.totalPages, props.curPage + 1);
    emit('goto', pg);
}
</script>

<template>
    <div class="pager">
        <slot />
        <div class="inline fltRt">
            <div class="inline tItems">
                <span class="totalCnt">{{ totalCnt }}</span> {{ label }}
            </div>
            <div class="inline rpp">
                <select :value="pageSize" @change="emit('update:pageSize', +$event.target.value)">
                    <option v-for="n in pageSizeOptions" :key="n" :value="n">{{ n }}</option>
                </select>
                <span class="rpp-label">Items/Page</span>
            </div>
            <div class="inline">
                <i class="btnP" @click="nav('prev')"><span class="cf">&lt;</span></i>
                <i v-if="curPage > 4"  class="btnP" @click="nav(1)">1</i>
                <i v-if="curPage > 5"  class="btnEllip">&hellip;</i>
                <i v-for="p in pgArry" :key="p" class="btnP" :class="{ active: p === curPage }" @click="nav(p)">{{ p }}</i>
                <i v-if="curPage < (totalPages - 4)" class="btnEllip">&hellip;</i>
                <i v-if="curPage < (totalPages - 3)" class="btnP" @click="nav(totalPages)">{{ totalPages }}</i>
                <i class="btnP" @click="nav('next')"><span class="cf">&gt;</span></i>
            </div>
        </div>
    </div>
</template>

<style lang="scss" scoped>
.pager {
    overflow: hidden; /* clear float */
    margin-bottom: 0.25rem;
}

.inline  { display: inline-block; }
.fltRt   { float: right; }

.tItems {
    margin-right: 2rem;
    .totalCnt { font-weight: bold; color: purple; }
}

.rpp {
    margin-right: 2rem;
    select {
        border: 1px solid rgb(4, 111, 212);
        border-radius: 4px;
        background-color: white;
        margin-right: 0.5rem;
        font-size: 15px;
    }
}

.btnP {
    display: inline-block;
    height: 30px; width: 34px;
    border: 1px solid rgb(4, 111, 212);
    border-radius: 3px;
    margin: 2px; padding: 2px;
    text-align: center;
    font-style: normal;
    cursor: pointer;
    user-select: none;
    &.active { background-color: blue; color: white; }
}

.btnEllip {
    display: inline-block;
    height: 28px; width: 28px;
    margin: 2px; text-align: center; font-size: large;
}

.cf { font-family: 'Courier'; font-weight: bold; }
</style>
