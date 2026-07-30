<script setup>
import { ref, computed } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import CartSidebar from '@/components/CartSidebar.vue';
import StaffSidebar from '@/components/StaffSidebar.vue';
import ProfileModal from '@/components/ProfileModal.vue';
import { visibleNavGroups } from '@/config/navigation';
import { CONTENT_NAV, STORE_INFO } from '@/config/content';

const auth        = useAuthStore();
const router      = useRouter();
const showProfile = ref(false);

const displayName = computed(() =>
    auth.user?.customerName || auth.user?.username || auth.user?.email
);

const isShopper = computed(() => !auth.isStaff());

const staffNavGroups = computed(() =>
    auth.isStaff() ? visibleNavGroups(router.getRoutes(), auth.hasPerm) : []
);

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
  <aside :class="{ 'staff-side': !isShopper, collapsed: !isShopper && !staffNavGroups.length }">
    <CartSidebar v-if="isShopper" />
    <StaffSidebar v-else-if="staffNavGroups.length" :groups="staffNavGroups" />
  </aside>
  <main>
    <router-view />
  </main>
  <footer class="muted">
    <nav class="footer-links">
      <router-link v-for="item in CONTENT_NAV" :key="item.slug" :to="'/' + item.slug">
        {{ item.label }}
      </router-link>
    </nav>
    <!-- AGPL §13: network users must be able to reach this deployment's source.
         Renders as a link once STORE_INFO.sourceUrl is set, plain text until then. -->
    <a v-if="STORE_INFO.sourceUrl" class="footer-credit" :href="STORE_INFO.sourceUrl"
       target="_blank" rel="noopener noreferrer">Powered by Sundries — source</a>
    <span v-else class="footer-credit">Powered by Sundries</span>
  </footer>
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

  &.staff-side { min-width: 175px; }
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
  // Single row: links left, credit right — stays within the fixed 1.5rem footer
  // track defined in assets/main.css, so the page never gains a second scrollbar.
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  line-height: 1.5rem;
  font-size: 0.8rem;
  overflow: hidden;

  .footer-links {
    display: flex;
    align-items: center;
    gap: 1rem;
    min-width: 0;
    overflow: hidden;

    a {
      color: inherit;
      text-decoration: none;
      white-space: nowrap;
      &:hover { color: var(--accent); text-decoration: underline; }
    }
  }

  .footer-credit {
    white-space: nowrap;
    color: inherit;
    text-decoration: none;

    // Only the source-link variant is interactive; the plain <span> ignores this.
    &:hover { color: var(--accent); text-decoration: underline; }
  }
}
</style>
