import { defineConfig } from 'vitest/config'

/**
 * Vitest config for the extension subproject (design doc §11 / Phase 8).
 * Pure-function/unit tests only — no `chrome.*` runtime is available under
 * Vitest's Node environment, so anything touching `chrome.storage`/
 * `chrome.runtime` goes through the `Map`-backed fakes in
 * `src/background/testUtils.ts` instead of the real API.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
