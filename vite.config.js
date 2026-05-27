import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  build: {
    sourcemap: mode !== 'production',
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks(id) {
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
