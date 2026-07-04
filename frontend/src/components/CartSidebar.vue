<script setup>
import { useCartStore } from '@/stores/cart';
import { fixedNum } from '@/composables/utils';
import { useRouter } from 'vue-router';

const cart   = useCartStore();
const router = useRouter();

function step(item) {
    return item.sell_method === 'measure' ? 0.25 : 1;
}

async function changeQty(item, delta) {
    const next = Math.round((Number(item.qty) + delta * step(item)) * 100) / 100;
    const min  = item.sell_method === 'measure' ? (Number(item.min_cut_qty) || step(item)) : 1;
    if (next < min) return;
    await cart.updateItemQty(item.variant_no, next).catch(() => {});
}
</script>

<template>
  <div class="cart">
    <h3>Cart</h3>
    <p v-if="cart.error" class="error-text">{{ cart.error }}</p>

    <p v-if="!cart.itemCount" class="muted empty">Your cart is empty.</p>

    <ul v-else class="lines">
      <li v-for="item in cart.cart.items" :key="item.id">
        <div class="line-top">
          <span class="name">{{ item.name }}</span>
          <button class="remove" title="Remove" @click="cart.removeItem(item.variant_no)">×</button>
        </div>
        <div class="line-detail muted">
          <span v-if="item.sku">{{ item.sku }}</span>
          <span v-if="Number(item.current_price) !== Number(item.unit_price)" class="pill warn">
            price now $ {{ fixedNum(item.current_price, 2) }}
          </span>
        </div>
        <div class="line-qty">
          <button class="btn qty-btn" @click="changeQty(item, -1)">−</button>
          <span class="qty">{{ item.qty }} <span v-if="item.sell_method === 'measure'" class="muted">{{ item.base_uom }}</span></span>
          <button class="btn qty-btn" @click="changeQty(item, 1)">+</button>
          <span class="line-total">$ {{ fixedNum(item.unit_price * item.qty, 2) }}</span>
        </div>
      </li>
    </ul>

    <div class="summary">
      <span>Subtotal</span>
      <strong>{{ cart.totalDisplay }}</strong>
    </div>
    <button
      class="btn btn-primary checkout-btn"
      :disabled="!cart.itemCount"
      @click="router.push('/checkout')">
      Checkout
    </button>
  </div>
</template>

<style scoped>
.cart { padding: 0.9rem; display: flex; flex-direction: column; height: 100%; }
h3 { margin-bottom: 0.6rem; }
.empty { font-size: 0.9rem; }

.lines { list-style: none; padding: 0; flex: 1; overflow: auto; }
.lines li { padding: 0.5rem 0; border-bottom: 1px solid var(--color-border); }

.line-top { display: flex; justify-content: space-between; gap: 0.4rem; }
.name { font-weight: 500; color: var(--color-heading); font-size: 0.9rem; }
.remove {
  background: none; border: none; cursor: pointer;
  color: var(--color-text-muted); font-size: 1rem; line-height: 1;
}
.remove:hover { color: var(--danger); }

.line-detail { font-size: 0.75rem; display: flex; gap: 0.4rem; align-items: center; }

.line-qty { display: flex; align-items: center; gap: 0.45rem; margin-top: 0.3rem; }
.qty-btn { padding: 0 0.5rem; line-height: 1.4; }
.qty { font-size: 0.9rem; min-width: 3rem; text-align: center; }
.line-total { margin-left: auto; font-size: 0.9rem; font-weight: 600; color: var(--color-heading); }

.summary {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.6rem 0; border-top: 2px solid var(--color-border-strong); margin-top: 0.5rem;
}
.checkout-btn { width: 100%; justify-content: center; }
</style>
