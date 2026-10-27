import { defineConfig } from 'vitest/config'

// The speech helper's tests against the real host build (npm run test:native; docs/design/
// offline-captions.md §10.2). Outside the main tests/**/*.test.ts pattern: they need
// `npm run build:speech-host` and `npm run fetch:test-speech` first, and fail (never skip)
// without them.
export default defineConfig({
  test: { include: ['tests/native/*.spec.ts'], environment: 'node', testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false }
})
