<script setup>
defineProps({
    /** Pre-filtered nav groups — see visibleNavGroups() in @/config/navigation. */
    groups: { type: Array, required: true },
});
</script>

<template>
  <nav class="staff-nav" aria-label="Staff">
    <template v-for="group in groups" :key="group.label ?? group.items[0].route">
      <span v-if="group.label" class="group-label">{{ group.label }}</span>
      <router-link
        v-for="item in group.items"
        :key="item.route"
        :to="{ name: item.route }"
        class="nav-item"
        :class="{ ungrouped: !group.label }">
        {{ item.label }}
      </router-link>
    </template>
  </nav>
</template>

<style lang="scss" scoped>
.staff-nav {
  display: flex;
  flex-direction: column;
  padding: 0.75rem 0.6rem;
  gap: 0.1rem;

  .group-label {
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-text);
    opacity: 0.6;
    padding: 0.9rem 0.6rem 0.25rem;

    &:first-child { padding-top: 0; }
  }

  .nav-item {
    color: var(--color-text);
    text-decoration: none;
    font-weight: 500;
    font-size: 0.9rem;
    padding: 0.3rem 0.6rem;
    border-radius: 6px;

    &.ungrouped { margin-top: 0.9rem; }

    &:hover { background: var(--color-surface-muted); color: var(--color-heading); }
    &.router-link-active { background: var(--accent-soft); color: var(--accent); }
  }
}
</style>
