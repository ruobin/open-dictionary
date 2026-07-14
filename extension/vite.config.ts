import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json' with { type: 'json' }

// Multi-entry MV3 build (background service worker, content script, popup,
// options page) driven entirely by manifest.json — @crxjs/vite-plugin infers
// the entries from the manifest so we don't hand-list them here.
//
// Production (Web Store) builds are triggered with `npm run build:prod`
// (i.e. `vite build --mode prod`), which (1) strips the dev-only
// `localhost:3001` host permission and (2) disables source maps, so the
// published bundle ships neither TS/React source nor a dev-only permission.
// `npm run dev` / `npm run build` keep the full dev manifest + sourcemaps.
export default defineConfig(({ mode }) => {
  const isProd = mode === 'prod'

  // Deep-clone so we never mutate the imported manifest module.
  const buildManifest = isProd
    ? {
        ...structuredClone(manifest),
        host_permissions: manifest.host_permissions.filter(
          (h) => !h.includes('localhost'),
        ),
      }
    : manifest

  return {
    plugins: [react(), crx({ manifest: buildManifest })],
    build: {
      outDir: 'dist',
      sourcemap: !isProd,
      target: 'es2020',
    },
  }
})
