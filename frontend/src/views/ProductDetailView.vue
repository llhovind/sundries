<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import api from '@/services/api';
import { fixedNum } from '@/composables/utils';
import { useCartStore } from '@/stores/cart';
import { useAuthStore } from '@/stores/auth';

const route  = useRoute();
const router = useRouter();
const cart   = useCartStore();
const auth   = useAuthStore();

const product  = ref(null);
const error    = ref('');
const added    = ref(false);
const qty      = ref(1);
const selected = ref({});   // option name → value_no

const isMeasure = computed(() => product.value?.sell_method === 'measure');
const minQty    = computed(() =>
    isMeasure.value ? (Number(product.value?.min_cut_qty) || 0.25) : 1);
const qtyStep   = computed(() => (isMeasure.value ? 0.25 : 1));

/** The variant matching every selected option value (or the only variant). */
const currentVariant = computed(() => {
    if (!product.value) return null;
    const variants = product.value.variants || [];
    if (!product.value.options.length) return variants[0] || null;
    const chosen = Object.values(selected.value);
    if (chosen.length < product.value.options.length) return null;
    return variants.find(v =>
        chosen.every(valueNo => v.option_values.some(ov => ov.value_no === valueNo))
    ) || null;
});

const available = computed(() => Number(currentVariant.value?.qty_available) || 0);

async function load() {
    try {
        const res = await api.get('/api/v1/products/' + route.params.product_no);
        product.value = res.data.content.product;
        qty.value = minQty.value;
        // pre-select when an option has a single value
        for (const opt of product.value.options) {
            if (opt.values.length === 1) selected.value[opt.name] = opt.values[0].value_no;
        }
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Product not found';
    }
}

async function addToCart() {
    if (!currentVariant.value) return;
    added.value = false;
    try {
        // Variant details ride along so a guest (local) cart can render the
        // line without another API call; the server cart ignores them.
        const v = currentVariant.value;
        await cart.addItem(v.variant_no, Number(qty.value), {
            name:          product.value.name,
            sku:           v.sku,
            unit_price:    v.price,
            sell_method:   product.value.sell_method,
            base_uom:      product.value.base_uom,
            min_cut_qty:   product.value.min_cut_qty,
            primary_image: v.primary_image || product.value.primary_image,
        });
        added.value = true;
        setTimeout(() => { added.value = false; }, 2000);
    } catch { /* error surfaced via cart.error */ }
}

onMounted(load);
</script>

<template>
  <div v-if="error" class="error-text">{{ error }}</div>
  <div v-else-if="product" class="detail">
    <button class="btn back" @click="router.push('/shop')">‹ Back to shop</button>

    <div class="layout">
      <div class="thumb card">
        <img v-if="product.primary_image" :src="'/images/' + product.primary_image" :alt="product.name" />
        <span v-else class="thumb-fallback">{{ product.name.slice(0, 1) }}</span>
      </div>

      <div class="info">
        <h2>{{ product.name }}</h2>
        <p v-if="product.brand" class="muted">{{ product.brand }}</p>
        <p v-if="product.descr" class="descr">{{ product.descr }}</p>

        <div v-for="opt in product.options" :key="opt.option_no" class="option">
          <span class="option-name">{{ opt.name }}</span>
          <div class="values">
            <button v-for="val in opt.values" :key="val.value_no"
                    class="btn value-btn"
                    :class="{ active: selected[opt.name] === val.value_no }"
                    @click="selected[opt.name] = val.value_no">
              {{ val.value }}
            </button>
          </div>
        </div>

        <div class="purchase card">
          <template v-if="currentVariant">
            <div class="price-row">
              <strong class="price">
                $ {{ fixedNum(currentVariant.price, 2) }}<span v-if="isMeasure" class="muted"> / {{ product.base_uom }}</span>
              </strong>
              <span v-if="available > 0" class="pill ok">{{ available }} {{ isMeasure ? product.base_uom : '' }} available</span>
              <span v-else class="pill warn">Out of stock — you can backorder at checkout</span>
            </div>
            <p v-if="currentVariant.sku" class="muted sku">SKU {{ currentVariant.sku }}</p>
            <p v-if="isMeasure && product.min_cut_qty" class="muted">
              Minimum cut: {{ product.min_cut_qty }} {{ product.base_uom }}
            </p>

            <div class="qty-row" v-if="!auth.isStaff()">
              <label>Qty</label>
              <input v-model.number="qty" type="number" class="input qty-input"
                     :min="minQty" :step="qtyStep" />
              <span v-if="isMeasure" class="muted">{{ product.base_uom }}</span>
              <button class="btn btn-primary" :disabled="!(qty >= minQty)" @click="addToCart">
                Add to cart
              </button>
              <span v-if="added" class="pill ok">Added ✓</span>
            </div>
            <p v-if="cart.error" class="error-text">{{ cart.error }}</p>
          </template>
          <p v-else class="muted">Select {{ product.options.map(o => o.name.toLowerCase()).join(' and ') }} to see price and availability.</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back { margin-bottom: 0.8rem; }
.layout { display: grid; grid-template-columns: minmax(200px, 340px) 1fr; gap: 1.2rem; }
@media (max-width: 800px) { .layout { grid-template-columns: 1fr; } }

.thumb { display: flex; align-items: center; justify-content: center; min-height: 240px; }
.thumb img { max-width: 100%; border-radius: 6px; }
.thumb-fallback { font-size: 4rem; font-weight: 700; color: var(--color-border-strong); }

.descr { margin: 0.6rem 0 1rem; max-width: 60ch; }

.option { margin-bottom: 0.8rem; }
.option-name { display: block; font-weight: 600; color: var(--color-heading); margin-bottom: 0.3rem; font-size: 0.9rem; }
.values { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.value-btn.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }

.purchase { margin-top: 1rem; max-width: 480px; }
.price-row { display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap; }
.price { font-size: 1.3rem; color: var(--color-heading); }
.sku { font-size: 0.78rem; margin-top: 0.2rem; }

.qty-row { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.8rem; flex-wrap: wrap; }
.qty-input { width: 90px; }
</style>
