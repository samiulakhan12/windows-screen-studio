/**
 * The bundled caption fonts as same-origin URLs (docs/design/captions-studio.md §6.5): Vite `?url`
 * imports of resources/fonts/*.woff2, by WOFF2 file name (fontCatalog.ts CatalogFile.woff2.file),
 * so the CSP (`default-src 'self'`) covers them.
 *
 * CONTRACT (part P2): the imports are to be written; until then no bundled font has a URL.
 */
export const BUNDLED_FONT_URLS: Readonly<Record<string, string>> = {}
