<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import api from '@/services/api';
import { fixedNum, debounce } from '@/composables/utils';

const router   = useRouter();
const products = ref([]);
const total    = ref(0);
const page     = ref(1);
const pageSize = 24;
const search   = ref('');
const loading  = ref(false);
const error    = ref('');
const scroller = ref(null);
const searchEl = ref(null);

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

async function load() {
    loading.value = true;
    error.value = '';
    try {
        const params = new URLSearchParams({ page: page.value, pageSize });
        if (search.value) params.set('q', search.value);
        const res = await api.get('/api/v1/products?' + params.toString());
        products.value = res.data.content.products;
        total.value    = res.data.content.totalItems ?? res.data.content.total ?? products.value.length;
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Failed to load products';
    } finally {
        loading.value = false;
    }
}

const onSearch = debounce(() => { page.value = 1; load(); }, 300);

function clearSearch() {
    if (!search.value) return;
    search.value = '';
    page.value   = 1;
    load();
    searchEl.value?.focus();
}

/** The grid — not the page — owns the scroll, so a page change must reset it. */
async function gotoPage(target) {
    const clamped = Math.min(Math.max(target, 1), totalPages.value);
    if (clamped === page.value) return;
    page.value = clamped;
    await load();
    scroller.value?.scrollTo({ top: 0 });
}

function goto(p) {
    router.push('/shop/' + p.product_no);
}

onMounted(load);
</script>

<template>
  <div class="shop">
    <div class="toolbar">
      <h2>Shop</h2>
      <div class="search-box">
        <input v-model="search" ref="searchEl" class="input search" type="text"
               placeholder="Search products…" @input="onSearch" @keyup.esc="clearSearch" />
        <button v-if="search" class="clear-btn" type="button"
                aria-label="Clear search" title="Clear search" @click="clearSearch">✕</button>
      </div>
      <div class="pager" v-if="total > pageSize">
        <button class="btn" :disabled="page <= 1" @click="gotoPage(page - 1)">‹ Prev</button>
        <span class="muted">Page {{ page }} / {{ totalPages }}</span>
        <button class="btn" :disabled="page >= totalPages" @click="gotoPage(page + 1)">Next ›</button>
      </div>
    </div>

    <div class="scroll-area" ref="scroller">
      <p v-if="error" class="error-text">{{ error }}</p>
      <p v-if="!loading && !products.length" class="muted">No products found.</p>

      <div class="grid">
        <div v-for="p in products" :key="p.product_no" class="card product" @click="goto(p)">
          <div class="thumb">
            <img v-if="p.primary_image" :src="'/images/' + p.primary_image" :alt="p.name" />
            <span v-else class="thumb-fallback">{{ p.name.slice(0, 1) }}</span>
          </div>
          <div class="body">
            <span class="name">{{ p.name }}</span>
            <span v-if="p.brand" class="muted brand">{{ p.brand }}</span>
            <div class="meta">
              <strong v-if="p.price_from != null">
                $ {{ fixedNum(p.price_from, 2) }}<span v-if="p.sell_method === 'measure'" class="muted"> / {{ p.base_uom }}</span>
              </strong>
              <span v-if="Number(p.qty_available) > 0" class="pill ok">In stock</span>
              <span v-else class="pill warn">Out of stock</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * The view owns its scrolling: the toolbar stays pinned while only the product
 * grid scrolls. `min-height: 0` on both the column and the scroll area is what
 * lets the flex child shrink below its content height instead of overflowing
 * <main> and taking the toolbar out of view with it.
 */
.shop {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 1rem;
  padding-bottom: 0.8rem;
  border-bottom: 1px solid var(--color-border);
}
.search-box { position: relative; display: flex; align-items: center; flex: 0 1 320px; }
.search { width: 100%; padding-right: 1.9rem; }

/* Sits inside the input's trailing padding, so it reads as part of the field. */
.clear-btn {
  position: absolute;
  right: 0.3rem;
  display: flex;
  align-items: center;
  padding: 0.2rem 0.3rem;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--color-text);
  font-size: 0.8rem;
  line-height: 1;
  cursor: pointer;
}
.clear-btn:hover { color: var(--accent); background: var(--color-surface-muted); }

.scroll-area {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 0.9rem 0.6rem 0.4rem 0;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 0.9rem;
}
.product { cursor: pointer; padding: 0; overflow: hidden; transition: border-color 0.15s; }
.product:hover { border-color: var(--accent); }

.thumb {
  height: 130px;
  background: var(--color-surface-muted);
  display: flex; align-items: center; justify-content: center;
}
.thumb img { max-height: 100%; max-width: 100%; object-fit: cover; }
.thumb-fallback { font-size: 2.4rem; font-weight: 700; color: var(--color-border-strong); }

.body { padding: 0.7rem 0.8rem; display: flex; flex-direction: column; gap: 0.15rem; }
.name { font-weight: 600; color: var(--color-heading); font-size: 0.92rem; }
.brand { font-size: 0.78rem; }
.meta { display: flex; align-items: center; justify-content: space-between; margin-top: 0.3rem; }

.pager { display: flex; align-items: center; gap: 0.6rem; margin-left: auto; white-space: nowrap; }
</style>
