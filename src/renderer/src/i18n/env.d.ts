/**
 * The one part of Vite's `import.meta.env` the renderer reads (the build mode: 'development' under
 * `npm run dev`, 'production' in a build, 'test' under vitest), declared as vite/client declares it.
 */
interface ImportMetaEnv {
  readonly MODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
