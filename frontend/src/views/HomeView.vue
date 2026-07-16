<script setup>
import { ref, computed } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import CartSidebar from '@/components/CartSidebar.vue';
import ProfileModal from '@/components/ProfileModal.vue';

const auth        = useAuthStore();
const router      = useRouter();
const showProfile = ref(false);

const displayName = computed(() =>
    auth.user?.customerName || auth.user?.username || auth.user?.email
);

const isShopper = computed(() => !auth.isStaff());

async function logout() {
    await auth.logout();
    router.push('/login');
}
</script>

<template>
  <header>
    <span class="brand">Storefront</span>
    <nav>
      <router-link to="/shop">Shop</router-link>
      <router-link v-if="isShopper && auth.isLoggedIn()" to="/orders">My Orders</router-link>

      <span v-if="auth.isStaff()" class="nav-sep" />
      <router-link v-if="auth.hasPerm('orders:read', 'orders:fulfill')" to="/admin/orders">Orders</router-link>
      <router-link v-if="auth.hasPerm('catalog:write')" to="/admin/products">Products</router-link>
      <router-link v-if="auth.hasPerm('inventory:read')" to="/admin/inventory">Inventory</router-link>
      <router-link v-if="auth.hasPerm('inventory:transfer')" to="/admin/transfers">Transfers</router-link>
      <router-link v-if="auth.hasPerm('purchasing:manage', 'inventory:receive')" to="/admin/purchasing">Purchasing</router-link>
      <router-link v-if="auth.hasPerm('rma:manage', 'refunds:create')" to="/admin/rmas">Returns</router-link>
      <router-link v-if="auth.hasPerm('reports:view', 'reports:cogs')" to="/admin/reports">Reports</router-link>
      <router-link v-if="auth.hasPerm('promotions:manage')" to="/admin/promotions">Promotions</router-link>
      <router-link v-if="auth.hasPerm('catalog:write')" to="/categories">Categories</router-link>
      <router-link v-if="auth.hasPerm('customers:read')" to="/customers">Customers</router-link>
      <router-link v-if="auth.hasPerm('users:manage')" to="/users">Users</router-link>
    </nav>
    <span v-if="auth.user" class="user-info">
      <button v-if="isShopper" class="username-btn" @click="showProfile = true">{{ displayName }}</button>
      <span v-else class="username">{{ displayName }}</span>
      <span v-if="auth.isStaff()" class="pill accent">{{ auth.user.role }}</span>
      <button class="btn logout-btn" @click="logout">Logout</button>
    </span>
    <span v-else class="user-info">
      <button class="btn logout-btn" @click="router.push('/login')">Log in</button>
    </span>
    <ProfileModal v-if="showProfile" @close="showProfile = false" />
  </header>
  <aside :class="{ collapsed: !isShopper }">
    <CartSidebar v-if="isShopper" />
  </aside>
  <main>
    <router-view />
  </main>
  <footer class="muted">Powered by Online Store</footer>
</template>

<style lang="scss" scoped>
header {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.45rem 1rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;

  .brand {
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--color-heading);
    white-space: nowrap;
    margin-right: 0.5rem;
    letter-spacing: -0.01em;
  }

  nav {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    flex: 1;
    flex-wrap: wrap;

    .nav-sep {
      width: 1px;
      height: 1.2rem;
      background: var(--color-border-strong);
      margin: 0 0.4rem;
    }

    a {
      color: var(--color-text);
      text-decoration: none;
      font-weight: 500;
      font-size: 0.9rem;
      padding: 0.25rem 0.6rem;
      border-radius: 6px;
      &:hover { background: var(--color-surface-muted); color: var(--color-heading); }
      &.router-link-active { background: var(--accent-soft); color: var(--accent); }
    }
  }

  .user-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    margin-left: auto;
  }

  .username { color: var(--color-heading); font-weight: 500; }

  .username-btn {
    color: var(--color-heading); font-weight: 500; font-size: 0.9rem;
    background: none; border: none; padding: 0; cursor: pointer;
    &:hover { color: var(--accent); }
  }

  .logout-btn { padding: 0.2rem 0.7rem; font-size: 0.85rem; }
}

aside {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  min-width: 250px;

  &.collapsed { min-width: 0; width: 0; border: none; }
}

main {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 1rem;
  overflow: auto;
}

footer {
  grid-column: 1 / -1;
  text-align: center;
  line-height: 1.5rem;
  font-size: 0.8rem;
}
</style>
