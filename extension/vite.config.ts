import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json' with { type: 'json' }

// Multi-entry MV3 build (background service worker, content script, popup,
// options page) driven entirely by manifest.json — @crxjs/vite-plugin infers
// the entries from the manifest so we don't hand-list them here.
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
  },
})
