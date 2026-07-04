<script setup>
import { ref, reactive, onMounted } from 'vue';
import api from '@/services/api';
import { fixedNum, debounce } from '@/composables/utils';

const products = ref([]);
const search   = ref('');
const error    = ref('');
const detail   = ref({});   // product_no → full product
const showCreate = ref(false);

const blank = () => ({ name: '', brand: '', descr: '', sell_method: 'unit', base_uom: 'each',
                       min_cut_qty: null, weight_lbs: null, status: 'draft' });
const createForm  = reactive(blank());
const variantForm = reactive({ open: null, sku: '', price: null, weight_lbs: null });
const optionForm  = reactive({ open: null, name: 'Color', values: '' });

async function load() {
    error.value = '';
    try {
        const params = new URLSearchParams({ pageSize: 50 });
        if (search.value) params.set('q', search.value);
        const res = await api.get('/api/v1/products?' + params.toString());
        products.value = res.data.content.products;
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Failed to load products';
    }
}
const onSearch = debounce(load, 300);

async function toggle(productNo) {
    if (detail.value[productNo]) { delete detail.value[productNo]; return; }
    const res = await api.get('/api/v1/products/' + productNo);
    detail.value = { ...detail.value, [productNo]: res.data.content.product };
}

async function refreshDetail(productNo) {
    const res = await api.get('/api/v1/products/' + productNo);
    detail.value = { ...detail.value, [productNo]: res.data.content.product };
    await load();
}

async function createProduct() {
    error.value = '';
    try {
        const body = { ...createForm };
        if (body.sell_method === 'unit') body.min_cut_qty = null;
        await api.post('/api/v1/products', body);
        Object.assign(createForm, blank());
        showCreate.value = false;
        await load();
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Create failed';
    }
}

async function setStatus(p, status) {
    await api.put('/api/v1/products/' + p.product_no, { status });
    await load();
    if (detail.value[p.product_no]) await refreshDetail(p.product_no);
}

async function addVariant(productNo) {
    error.value = '';
    try {
        await api.post('/api/v1/products/' + productNo + '/variants', {
            sku: variantForm.sku, price: variantForm.price, weight_lbs: variantForm.weight_lbs,
        });
        variantForm.open = null; variantForm.sku = ''; variantForm.price = null; variantForm.weight_lbs = null;
        await refreshDetail(productNo);
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Variant save failed';
    }
}

async function saveVariantPrice(productNo, variant, price) {
    await api.post('/api/v1/products/' + productNo + '/variants',
        { variant_no: variant.variant_no, price: Number(price) });
    await refreshDetail(productNo);
}

async function addOption(productNo) {
    error.value = '';
    const existing = (detail.value[productNo]?.options || [])
        .map(o => ({ name: o.name, values: o.values.map(v => v.value) }));
    existing.push({ name: optionForm.name, values: optionForm.values.split(',').map(s => s.trim()).filter(Boolean) });
    try {
        await api.put('/api/v1/products/' + productNo + '/options', { options: existing });
        optionForm.open = null; optionForm.values = '';
        await refreshDetail(productNo);
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Option save failed';
    }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>Products</h2>
      <input v-model="search" class="input search" type="text" placeholder="Search…" @input="onSearch" />
      <button class="btn btn-primary" @click="showCreate = !showCreate">+ New product</button>
    </div>
    <p v-if="error" class="error-text">{{ error }}</p>

    <div v-if="showCreate" class="card create">
      <div class="inline-form">
        <input v-model="createForm.name" class="input" type="text" placeholder="Name *" />
        <input v-model="createForm.brand" class="input" type="text" placeholder="Brand" />
        <select v-model="createForm.sell_method" class="input">
          <option value="unit">Sold per unit</option>
          <option value="measure">Sold by length/measure</option>
        </select>
        <select v-model="createForm.base_uom" class="input">
          <option v-for="u in ['each','in','ft','yd','m']" :key="u" :value="u">{{ u }}</option>
        </select>
        <input v-if="createForm.sell_method === 'measure'" v-model.number="createForm.min_cut_qty"
               class="input num" type="number" step="0.25" placeholder="Min cut" />
        <input v-model.number="createForm.weight_lbs" class="input num" type="number" step="0.1" placeholder="Weight lbs" />
        <button class="btn btn-primary" :disabled="!createForm.name" @click="createProduct">Create draft</button>
      </div>
      <textarea v-model="createForm.descr" class="input descr" placeholder="Description" rows="2" />
    </div>

    <table class="table-plain">
      <thead><tr><th>Name</th><th>Status</th><th>Method</th><th>From $</th><th>Variants</th><th>Available</th><th></th></tr></thead>
      <tbody>
        <template v-for="p in products" :key="p.product_no">
          <tr class="row" @click="toggle(p.product_no)">
            <td>{{ p.name }} <span v-if="p.brand" class="muted">· {{ p.brand }}</span></td>
            <td><span class="pill" :class="p.status === 'active' ? 'ok' : (p.status === 'draft' ? 'warn' : '')">{{ p.status }}</span></td>
            <td>{{ p.sell_method }} <span class="muted">({{ p.base_uom }})</span></td>
            <td>{{ p.price_from != null ? fixedNum(p.price_from, 2) : '—' }}</td>
            <td>{{ p.variant_count }}</td>
            <td>{{ fixedNum(p.qty_available, 1) }}</td>
            <td class="actions">
              <button v-if="p.status !== 'active'" class="btn mini" @click.stop="setStatus(p, 'active')">Activate</button>
              <button v-else class="btn mini" @click.stop="setStatus(p, 'inactive')">Deactivate</button>
            </td>
          </tr>
          <tr v-if="detail[p.product_no]">
            <td colspan="7" class="detail">
              <div class="options">
                <strong>Options:</strong>
                <span v-for="o in detail[p.product_no].options" :key="o.option_no" class="pill accent">
                  {{ o.name }}: {{ o.values.map(v => v.value).join(', ') }}
                </span>
                <button v-if="optionForm.open !== p.product_no" class="btn mini"
                        @click="optionForm.open = p.product_no">+ option</button>
                <template v-else>
                  <input v-model="optionForm.name" class="input mini-in" type="text" placeholder="Option (Color)" />
                  <input v-model="optionForm.values" class="input" type="text" placeholder="Values, comma separated" />
                  <button class="btn mini" @click="addOption(p.product_no)">Save</button>
                </template>
              </div>
              <table class="table-plain inner">
                <thead><tr><th>SKU</th><th>Options</th><th>Price</th><th>Status</th><th>Available</th></tr></thead>
                <tbody>
                  <tr v-for="v in detail[p.product_no].variants" :key="v.variant_no">
                    <td>{{ v.sku }}</td>
                    <td class="muted">{{ v.option_values.map(ov => ov.value).join(' / ') || '—' }}</td>
                    <td>
                      $ <input class="input price-in" type="number" step="0.01" :value="v.price"
                               @change="saveVariantPrice(p.product_no, v, $event.target.value)" />
                    </td>
                    <td><span class="pill" :class="v.status === 'active' ? 'ok' : ''">{{ v.status }}</span></td>
                    <td>{{ fixedNum(v.qty_available, 1) }}</td>
                  </tr>
                </tbody>
              </table>
              <div class="inline-form add-variant">
                <template v-if="variantForm.open === p.product_no">
                  <input v-model="variantForm.sku" class="input" type="text" placeholder="SKU *" />
                  <input v-model.number="variantForm.price" class="input num" type="number" step="0.01" placeholder="Price *" />
                  <input v-model.number="variantForm.weight_lbs" class="input num" type="number" step="0.1" placeholder="Weight lbs" />
                  <button class="btn btn-primary mini" :disabled="!variantForm.sku || variantForm.price == null"
                          @click="addVariant(p.product_no)">Add variant</button>
                  <button class="btn mini" @click="variantForm.open = null">Cancel</button>
                </template>
                <button v-else class="btn mini" @click="variantForm.open = p.product_no">+ variant</button>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 0.8rem; margin-bottom: 0.8rem; }
.search { flex: 0 1 280px; margin-left: auto; }
.create { margin-bottom: 1rem; }
.inline-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.num { width: 110px; }
.descr { width: 100%; margin-top: 0.5rem; }
.row { cursor: pointer; }
.actions { white-space: nowrap; }
.mini { padding: 0.1rem 0.5rem; font-size: 0.75rem; }
.mini-in { width: 130px; }
.detail { background: var(--color-surface-muted); }
.options { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.5rem; }
.inner { font-size: 0.85rem; margin: 0.4rem 0; }
.price-in { width: 90px; }
.add-variant { margin-top: 0.4rem; }
</style>
