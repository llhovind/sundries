<script setup>
import { computed, watchEffect, onUnmounted } from 'vue';
import { CONTENT_PAGES, STORE_INFO } from '@/config/content';

// The slug is supplied by the router as a prop (one static route per page), so
// this view stays a pure function of its input and carries no routing concerns.
const props = defineProps({
    slug: { type: String, required: true },
});

const page = computed(() => CONTENT_PAGES[props.slug] ?? null);

const effectiveDate = computed(() => {
    if (!page.value?.effective) return null;
    // Render in the visitor's locale; the config holds a stable ISO date.
    return new Date(page.value.effective + 'T00:00:00').toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
    });
});

// Keep the browser tab in sync with the current document.
const BASE_TITLE = STORE_INFO.name;
watchEffect(() => {
    document.title = page.value ? `${page.value.title} · ${BASE_TITLE}` : BASE_TITLE;
});
onUnmounted(() => { document.title = BASE_TITLE; });
</script>

<template>
  <article v-if="page" class="content-page">
    <h1>{{ page.title }}</h1>
    <p v-if="effectiveDate" class="effective">Effective {{ effectiveDate }}</p>
    <p v-if="page.intro" class="intro">{{ page.intro }}</p>

    <section v-for="(section, i) in page.sections" :key="i">
      <h2 v-if="section.heading">{{ section.heading }}</h2>
      <p v-for="(paragraph, j) in section.paragraphs" :key="j">{{ paragraph }}</p>
    </section>
  </article>

  <article v-else class="content-page">
    <h1>Page not found</h1>
    <p>The page you're looking for doesn't exist.</p>
  </article>
</template>

<style lang="scss" scoped>
.content-page {
  max-width: 760px;
  margin: 0 auto;
  color: var(--color-text);
  line-height: 1.65;

  h1 {
    color: var(--color-heading);
    font-size: 1.6rem;
    margin: 0 0 0.5rem;
    letter-spacing: -0.01em;
  }

  h2 {
    color: var(--color-heading);
    font-size: 1.1rem;
    margin: 1.75rem 0 0.5rem;
  }

  .effective {
    color: var(--color-text-muted, #888);
    font-size: 0.85rem;
    margin: 0 0 1.25rem;
  }

  .intro {
    font-size: 1.05rem;
    margin: 0 0 1rem;
  }

  p { margin: 0 0 0.75rem; }

  section:last-child p:last-child { margin-bottom: 0; }
}
</style>
