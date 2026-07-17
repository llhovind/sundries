<script setup>
import { ref, computed, reactive, onMounted, onUnmounted } from 'vue';
import { useProductsStore } from '@/stores/products';
import { apiErrorMessage } from '@/stores/storeUtils';
import { fixedNum } from '@/composables/utils';
import TableComponent from '@/components/TableComponent.vue';

const store = useProductsStore();
onMounted(() => store.getAll().catch(() => {}));

const displayFields = ['name', 'status', 'sell_method', 'price_from', 'variant_count', 'qty_available'];

const mutationError = ref('');
const showCreate    = ref(false);

const blank = () => ({ name: '', brand: '', descr: '', sell_method: 'unit', base_uom: 'each',
                       min_cut_qty: null, weight_lbs: null, status: 'draft' });
const createForm  = reactive(blank());
const variantForm = reactive({ open: null, sku: '', price: null, weight_lbs: null, valueSel: {} });
const optionForm  = reactive({ open: null, name: 'Color', values: '' });

// Per-variant option selections for inline editing: variant_no → { option_no → value_no }.
// Seeded from the server on every detail (re)load so failed saves snap back.
const variantSel = reactive({});

// Transient per-variant save confirmation. Each successful inline save flashes
// "Saved ✓" on its own row and self-dismisses, so a confirmation from one edit
// (e.g. options) can't be mistaken for a later one (e.g. price).
const SAVED_FLASH_MS = 2500;
const savedFlash  = reactive({});   // variant_no → true while the confirmation shows
const savedTimers = new Map();      // variant_no → timeout handle

function flashSaved(variantNo) {
    clearTimeout(savedTimers.get(variantNo));
    savedFlash[variantNo] = true;
    savedTimers.set(variantNo, setTimeout(() => {
        delete savedFlash[variantNo];
        savedTimers.delete(variantNo);
    }, SAVED_FLASH_MS));
}

onUnmounted(() => savedTimers.forEach(clearTimeout));

// ── Expandable product detail (lazy-fetched per product) ─────────────────────

const detail       = ref({});   // product_no → full product
const expandedKeys = computed(() =>
    store.products.filter(p => detail.value[p.product_no]).map(p => p.product_no));

function seedVariantSelections(product) {
    for (const v of product.variants) {
        const sel = {};
        for (const ov of v.option_values) sel[ov.option_no] = ov.value_no;
        variantSel[v.variant_no] = sel;
    }
}

async function toggleDetail(product) {
    const key = product.product_no;
    if (detail.value[key]) { delete detail.value[key]; return; }
    try {
        const full = await store.getProduct(key);
        seedVariantSelections(full);
        detail.value = { ...detail.value, [key]: full };
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Failed to load product detail');
    }
}

async function refreshDetail(productNo) {
    const full = await store.getProduct(productNo);
    seedVariantSelections(full);
    detail.value = { ...detail.value, [productNo]: full };
}

// ── Mutations ─────────────────────────────────────────────────────────────────

async function createProduct() {
    mutationError.value = '';
    try {
        const body = { ...createForm };
        if (body.sell_method === 'unit') body.min_cut_qty = null;
        await store.createProduct(body);
        Object.assign(createForm, blank());
        showCreate.value = false;
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Create failed');
    }
}

async function setStatus(product, status) {
    mutationError.value = '';
    try {
        await store.updateStatus(product.product_no, status);
        if (detail.value[product.product_no]) await refreshDetail(product.product_no);
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Status update failed');
    }
}

function openVariantForm(productNo) {
    variantForm.open = productNo;
    variantForm.sku = ''; variantForm.price = null; variantForm.weight_lbs = null;
    variantForm.valueSel = {};
}

/** Every product option needs a chosen value before a variant can be saved. */
function variantFormComplete(productNo) {
    const options = detail.value[productNo]?.options || [];
    return options.every(o => variantForm.valueSel[o.option_no] != null);
}

async function addVariant(productNo) {
    mutationError.value = '';
    const options = detail.value[productNo]?.options || [];
    try {
        await store.saveVariant(productNo, {
            sku: variantForm.sku, price: variantForm.price, weight_lbs: variantForm.weight_lbs,
            valueNos: options.map(o => Number(variantForm.valueSel[o.option_no])),
        });
        variantForm.open = null;
        await refreshDetail(productNo);
        await store.getAll();
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Variant save failed');
    }
}

/** Saves a variant's option combination once a value is chosen for every option. */
async function saveVariantOptions(productNo, variant) {
    mutationError.value = '';
    const options = detail.value[productNo]?.options || [];
    const sel = variantSel[variant.variant_no] || {};
    if (options.some(o => sel[o.option_no] == null)) return;
    try {
        await store.saveVariant(productNo, {
            variant_no: variant.variant_no,
            valueNos:   options.map(o => Number(sel[o.option_no])),
        });
        flashSaved(variant.variant_no);
        await refreshDetail(productNo);
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Variant option save failed');
        await refreshDetail(productNo);
    }
}

async function saveVariantPrice(productNo, variant, price) {
    mutationError.value = '';
    try {
        await store.saveVariant(productNo, { variant_no: variant.variant_no, price: Number(price) });
        flashSaved(variant.variant_no);
        await refreshDetail(productNo);
        await store.getAll();
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Variant save failed');
    }
}

/** Adds a new option, or merges values into an existing option of the same name. */
async function addOption(productNo) {
    mutationError.value = '';
    const existing = (detail.value[productNo]?.options || [])
        .map(o => ({ name: o.name, values: o.values.map(v => v.value) }));
    const entered = { name: optionForm.name.trim(),
                      values: optionForm.values.split(',').map(s => s.trim()).filter(Boolean) };
    const match = existing.find(o => o.name === entered.name);
    if (match) match.values.push(...entered.values.filter(v => !match.values.includes(v)));
    else existing.push(entered);
    try {
        await store.saveOptions(productNo, existing);
        optionForm.open = null; optionForm.values = '';
        await refreshDetail(productNo);
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Option save failed');
    }
}
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2>Products</h2>
      <button class="btn btn-primary" @click="showCreate = !showCreate">+ New product</button>
    </div>

    <div v-if="store.error || mutationError" class="error">{{ store.error || mutationError }}</div>

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

    <TableComponent
      :store="store"
      :rows="store.products"
      :displayFields="displayFields"
      rowKey="product_no"
      clickable
      :expandedKeys="expandedKeys"
      searchPlaceholder="Search…"
      label="Products Found"
      @row-click="toggleDetail"
    >
      <template #cell-name="{ row }">
        {{ row.name }} <span v-if="row.brand" class="muted">· {{ row.brand }}</span>
      </template>

      <template #cell-status="{ row }">
        <span class="pill" :class="row.status === 'active' ? 'ok' : (row.status === 'draft' ? 'warn' : '')">{{ row.status }}</span>
      </template>

      <template #cell-sell_method="{ row }">
        {{ row.sell_method }} <span class="muted">({{ row.base_uom }})</span>
      </template>

      <template #row-actions="{ row }">
        <button v-if="row.status !== 'active'" class="btn mini" @click="setStatus(row, 'active')">Activate</button>
        <button v-else class="btn mini" @click="setStatus(row, 'inactive')">Deactivate</button>
      </template>

      <template #detail="{ row }">
        <div class="options">
          <strong>Options:</strong>
          <span v-for="o in detail[row.product_no].options" :key="o.option_no" class="pill accent">
            {{ o.name }}: {{ o.values.map(v => v.value).join(', ') }}
          </span>
          <button v-if="optionForm.open !== row.product_no" class="btn mini"
                  @click="optionForm.open = row.product_no">+ option</button>
          <template v-else>
            <input v-model="optionForm.name" class="input mini-in" type="text" placeholder="Option (Color)" />
            <input v-model="optionForm.values" class="input" type="text" placeholder="Values, comma separated" />
            <button class="btn mini" @click="addOption(row.product_no)">Save</button>
          </template>
        </div>
        <table class="table-plain inner">
          <thead><tr><th>SKU</th><th>Options</th><th>Price</th><th>Status</th><th>Available</th><th class="save-col"></th></tr></thead>
          <tbody>
            <tr v-for="v in detail[row.product_no].variants" :key="v.variant_no">
              <td>{{ v.sku }}</td>
              <td class="muted">
                <template v-if="detail[row.product_no].options.length">
                  <select v-for="o in detail[row.product_no].options" :key="o.option_no"
                          class="input opt-sel" v-model.number="variantSel[v.variant_no][o.option_no]"
                          @change="saveVariantOptions(row.product_no, v)">
                    <option :value="undefined" disabled>{{ o.name }}…</option>
                    <option v-for="val in o.values" :key="val.value_no" :value="val.value_no">{{ val.value }}</option>
                  </select>
                </template>
                <template v-else>—</template>
              </td>
              <td>
                $ <input class="input price-in" type="number" step="0.01" :value="v.price"
                         @change="saveVariantPrice(row.product_no, v, $event.target.value)" />
              </td>
              <td><span class="pill" :class="v.status === 'active' ? 'ok' : ''">{{ v.status }}</span></td>
              <td>{{ fixedNum(v.qty_available, 1) }}</td>
              <td class="save-col">
                <Transition name="saved">
                  <span v-if="savedFlash[v.variant_no]" class="pill ok">Saved ✓</span>
                </Transition>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="inline-form add-variant">
          <template v-if="variantForm.open === row.product_no">
            <input v-model="variantForm.sku" class="input" type="text" placeholder="SKU *" />
            <input v-model.number="variantForm.price" class="input num" type="number" step="0.01" placeholder="Price *" />
            <input v-model.number="variantForm.weight_lbs" class="input num" type="number" step="0.1" placeholder="Weight lbs" />
            <select v-for="o in detail[row.product_no].options" :key="o.option_no"
                    class="input opt-sel" v-model.number="variantForm.valueSel[o.option_no]">
              <option :value="undefined" disabled>{{ o.name }} *</option>
              <option v-for="val in o.values" :key="val.value_no" :value="val.value_no">{{ val.value }}</option>
            </select>
            <button class="btn btn-primary mini"
                    :disabled="!variantForm.sku || variantForm.price == null || !variantFormComplete(row.product_no)"
                    @click="addVariant(row.product_no)">Add variant</button>
            <button class="btn mini" @click="variantForm.open = null">Cancel</button>
          </template>
          <button v-else class="btn mini" @click="openVariantForm(row.product_no)">+ variant</button>
        </div>
      </template>

      <template #empty>No products found.</template>
    </TableComponent>
  </div>
</template>

<style lang="scss" scoped>
.view { display: flex; flex-direction: column; height: 100%; }
.view-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;
  h2 { margin: 0; color: #3a2060; }
}
.error { color: #c0392b; margin-bottom: 0.5rem; font-size: 0.9rem; }
.create { margin-bottom: 1rem; }
.inline-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.num { width: 110px; }
.descr { width: 100%; margin-top: 0.5rem; }
.mini { padding: 0.1rem 0.5rem; font-size: 0.75rem; }
.mini-in { width: 130px; }
.options { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.5rem; }
.inner { font-size: 0.85rem; margin: 0.4rem 0; }
.price-in { width: 90px; }
.opt-sel { width: auto; min-width: 90px; margin-right: 0.3rem; font-size: 0.85rem; padding: 0.15rem 0.3rem; }
.save-col { width: 70px; }
.saved-enter-active { transition: opacity 0.15s ease; }
.saved-leave-active { transition: opacity 0.6s ease; }
.saved-enter-from, .saved-leave-to { opacity: 0; }
.add-variant { margin-top: 0.4rem; }
</style>
