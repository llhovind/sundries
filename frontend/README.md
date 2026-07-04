# Storefront UI

Vue 3 + Pinia + Vite frontend for the online store. See the [root README](../README.md)
for architecture, deployment and configuration.

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api and /images to :3000
npm run build      # production bundle in dist/
npm run test:unit  # vitest component tests
```

The dev server expects the backend on port 3000 (`npm run dev` in `../backend`).
Theme lives in `src/assets/base.css` — semantic CSS variables, light/dark aware;
swap the palette block to rebrand.
