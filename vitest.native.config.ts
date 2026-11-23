import { defineConfig } from 'vitest/config'

// The native helpers' tests against their real host builds (npm run test:native): the speech
// helper's (docs/design/offline-captions.md §10.2) need `npm run build:speech-host` and
// `npm run fetch:test-speech`; the text reader's (tests/native/ocr.spec.ts, docs/design/auto-blur.md
// §16.2) need `node scripts/build-native.mjs --ocr-host` and the five pinned model files in
// SSW_OCR_MODELS. Outside the main tests/**/*.test.ts pattern; they fail (never skip) without them.
export default defineConfig({
  test: { include: ['tests/native/*.spec.ts'], environment: 'node', setupFiles: ['tests/setup/i18n.ts'], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false }
})
