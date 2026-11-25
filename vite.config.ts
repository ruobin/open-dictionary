
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  test: {
    include: ['**/*.test.ts'],
    // server/config.ts exits the process when a required AUTH0_* variable is
    // missing, and most server tests import it. No test talks to Auth0, so
    // placeholders are enough; they also keep `npm test` working on a fresh
    // clone (or in CI) with no server/.env.
    env: {
      AUTH0_DOMAIN: 'test.invalid',
      AUTH0_AUDIENCE: 'https://test.invalid/api',
      AUTH0_MGMT_CLIENT_ID: 'test-client-id',
      AUTH0_MGMT_CLIENT_SECRET: 'test-client-secret',
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  build: {
    sourcemap: mode !== 'production',
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|@remix-run)[\\/]/.test(id)) {
            return 'react'
          }
          if (/[\\/]node_modules[\\/]@auth0[\\/]/.test(id)) {
            return 'auth'
          }
        },
      },
    },
  },
  preview: {
    port: 5173,
  },
}))
