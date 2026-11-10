# Extraction logs

One file per extraction part (`x1.json` … `x7.json`, docs/design/output-and-languages.md §21.8), so no
two parts write the same file. Each holds the rows the codemod (`npm run i18n:extract`) proposed and
the part kept, edited by hand where needed:

```json
[{ "key": "editor.saveIndicator.saved", "file": "src/renderer/src/editor/SaveIndicator.tsx", "line": 25, "english": " Saved", "sample": {} }]
```

`english` is the exact text the code showed before the extraction and `sample` the values that
reproduce it; a plural row has arrays of four, for the counts 0, 1, 2 and 1000. Test 69
(`tests/i18nExtractionLog.test.ts`) formats every row's message with its sample and requires the
literal it replaced.
