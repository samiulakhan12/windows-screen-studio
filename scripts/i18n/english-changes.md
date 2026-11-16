# English changes for later

The English UI does not change in wave 12 (docs/design/output-and-languages.md §0 decision 12). This file
lists English text that only a deliberate change could improve, as §10.3 rule 8 asks. Nothing listed
here was changed. Each entry needs the owner's approval, and its commit has to name the change, because
it changes the English guard's baseline (tests 9 and 10, §10.6) on purpose.

Other languages are not held back by any of these. Each sentence built from pieces is a `merge: true`
group, and translations use the group's `.whole` message, which the reviewers can order freely (§9.3).

| English today | Where | What a later change could do |
|---|---|---|
| "Bengali" in the captions' spoken-language list and the caption tracks' language names, while new text says "Bangla" (the Bangla model, Settings › Language) | the captions' spoken languages (`CaptionsPanel.tsx` shows `captionTracks.ts`'s `TRACK_LANGUAGES`, `{ code: 'bn', name: 'Bengali' }`, through `captionLanguageName`), the caption tracks' names from `Intl.DisplayNames(['en'])` (`captionTracks.ts`), the font menu's `text.fontPicker.script.bengali` and `text.fontPicker.letters.bn` | Say "Bangla" everywhere the UI names the language (§0 decision 12). The names written into exported files stay as they are (§0 decision 10). |
| "Text, titles and chapter names are edited one at a time. Ctrl + Alt + C copies one item's look; " with only the copy key set, and "… one at a time. " with neither key set | Selection tab, `style.selectionPanel.lookKeys.*` (`SelectionPanel.tsx`) | End the sentence properly in every case: no dangling semicolon and no trailing space. The `.whole` message already does this for other languages. |
| "Freeze frame: adds 1.5 s here, the recording waits. Drag the edge to change, Delete to remove · selected: …" | the freeze block tooltip, `style.freezeMarks.freezeFrameAddsHere` with `style.freezeMarks.tip.*` (`FreezeMarks.tsx`) | Say what the edge changes ("Drag the edge to change its length; press Delete to remove it"), and make the tooltip one message in English too. |
| "Settings · for “Also” and the encoder" | the Export dialog's Settings heading in Batch mode, `export.settings.batch.lead` (`ExportDialog.tsx`) | Read as one heading ("Settings for “Also” and the encoder") instead of a heading followed by a fragment. |
| A notice followed by ". Review (Shift + R)" or ". Review mode lists them" | `keys.reviewHint` and `keys.reviewHintNoKey` (`shortcuts.ts`), which carry the full stop of the sentence before them; other files' notices (`captions/great.ts`) add them at their end | Let each notice end its own sentence and add "Review (Shift + R)." as a sentence of its own. |
| The undo hint " · Ctrl + Z to undo" after a notice | `keys.undoHint.lead` (`shortcuts.ts`), which other files' notices add at their end (`cutsCopy.ts`, `multiSelectCopy.ts`, `polishCopy.ts`, `directorCopy.ts`, `captions/great.ts`) | Give the separator to the notices so the hint is a phrase on its own in English too, as `keys.undoHint.whole` already is. |
| "This file is 31 MB: too big for some email. " before the *Make it smaller* button, the space inside the message | `smart.guide.tooBig.lead` (`GuidePanel.tsx`) | Keep the sentence whole and put the space in the markup. |
| The Clip tab's edit hint in four pieces ("Press S to split at the playhead," + "select a clip and" + "press Delete" + "to cut it, or …") | `style.clipPanel.editHint.*` (`ClipPanel.tsx`) | One message in English too. Merging the text nodes moved glyphs under the guard at S3b, so this waits for a deliberate re-record of that screen. |
