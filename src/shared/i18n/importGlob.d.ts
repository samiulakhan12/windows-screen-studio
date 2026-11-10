/**
 * Vite's `import.meta.glob`, which electron-vite and vitest resolve when they build: the built
 * catalogues (docs/design/output-and-languages.md §9.2) are imported this way, so a language whose
 * file does not exist yet is simply absent. Only the forms Flown uses.
 */
interface ImportMeta {
  glob<T = unknown>(pattern: string | readonly string[], options: { eager: true; import?: string }): Record<string, T>
  glob<T = unknown>(pattern: string | readonly string[], options?: { eager?: false; import?: string }): Record<string, () => Promise<T>>
}
