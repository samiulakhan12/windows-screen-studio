/**
 * The speaker notes' words in the UI language (docs/design/output-and-languages.md §10.3 rule 1,
 * part X4): NOTES_COPY's words are getters that make their messages where they are read, and in
 * English each is the text the table held before (TODAY); readingText says how long reading takes
 * as blocks.ts's readingLabel does, over a grid of lengths.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setCatalogue } from '../src/shared/i18n/t'
import { readingLabel } from '../src/shared/notes/blocks'
import { countLine, NOTES_COPY, notesSummary, readingText, wordsLabel } from '../src/shared/notes/notesCopy'

const TODAY: Record<string, string> = {
  groupLabel: "Speaker notes",
  emptyHint: "Add a script or bullet points to read while you record. Only you see them: they stay out of the video.",
  add: "Add notes…",
  edit: "Edit notes…",
  rehearse: "Rehearse",
  stopRehearsing: "Stop rehearsing",
  showWhileRecording: "Show while recording",
  olderWindows: "On this version of Windows your notes would show in the video as a black box (the recording bar does too). They appear only when they are outside what you record, and never in a window recording. Windows 10 version 2004 or later keeps them out of the video.",
  dialogTitle: "Speaker notes",
  textLabel: "Your script or bullet points",
  placeholder: "Paste your script or a few bullet points. Each line is a step; a blank line adds space. [Text in brackets] is a cue you do not read aloud.",
  saved: "Saved",
  whileRecording: "While recording",
  showMyNotes: "Show my notes while recording",
  autoStart: "Start scrolling when the recording starts",
  autoStartHint: "Turn off for bullet notes you step through with Forward.",
  keep: "Keep a copy with the recording",
  keepHint: "You find it in the editor’s Captions tab.",
  speed: "Speed",
  textSize: "Text size",
  width: "Width",
  height: "Height",
  sizeHint: "Narrow keeps your eyes near the camera. You can also drag the window’s corner.",
  position: "Position",
  positionDefault: "Top centre of the main screen, under the camera",
  positionSaved: "Where you left it",
  resetPosition: "Reset position",
  hotkeysLabel: "Hotkeys",
  hotkeysHint: "They work while your notes are open.",
  done: "Done",
  draft: "Draft script",
  drafting: "Drafting…",
  cancel: "Cancel",
  draftHintLocal: "Turns your bullet points into sentences to read aloud, on this PC: nothing is sent.",
  noProvider: "Draft script needs an AI provider with your own key: OpenAI, Gemini or Claude.",
  addProvider: "Add an AI provider",
  draftEmpty: "Write a few bullet points first.",
  draftTooLong: "Draft script works on up to 20,000 characters of notes.",
  drafted: "Script drafted from your notes. Read it through before you record.",
  restore: "Restore my notes",
  stale: "Your notes changed while the script was drafted, so the draft was not used. Try again.",
  tryAgain: "Try again",
  windowLabel: "Speaker notes",
  emptyRehearsal: "No notes yet. Add them on the home screen.",
  hotkeyProblem: "Hotkey problem",
  locked: "Locked in place so it stays out of the recording on this version of Windows",
  backToStart: "Back to start",
  resize: "Drag to resize",
  barShow: "Show notes",
  barHide: "Hide notes",
  barShowTitle: "Show your notes",
  barHideTitle: "Hide your notes (they are never in the recording)",
  scriptSection: "Your script",
  scriptIntro: "You read from these notes while recording.",
  copyScript: "Copy script",
  useAgain: "Use as notes again",
  replaceQuestion: "Replace your current notes?",
  replace: "Replace"
}

afterEach(() => setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' }))

describe('the speaker notes in the UI language', () => {
  it("gives today's English for every word of NOTES_COPY, made when read", () => {
    const copy = NOTES_COPY as unknown as Record<string, unknown>
    for (const [key, english] of Object.entries(TODAY)) expect([key, copy[key]]).toEqual([key, english])
    expect(NOTES_COPY.saveFailed('disk full')).toBe('Could not save your notes: disk full')
    expect(NOTES_COPY.couldNotSave('disk full')).toBe('Could not save: disk full')
    expect(NOTES_COPY.draftHint('My OpenAI')).toBe('Turns your bullet points into sentences to read aloud. Only these notes are sent to My OpenAI, with your key.')
    // A getter, not a value fixed when the module loaded: another language's message shows at once.
    setCatalogue({ language: 'bn', messages: { 'review.notes.add': 'নোট লিখুন…' }, formatLocale: 'bn-BD', dir: 'ltr' })
    expect(NOTES_COPY.add).toBe('নোট লিখুন…')
  })

  it('says how long reading takes as readingLabel does', () => {
    for (const s of [-5, 0, 0.4, 1, 44.6, 59.4, 59.6, 60, 61, 119.5, 144, 3599, 3599.6, 3600, 3629, 3631, 3900, 7200, 7229, 7231, 36000, NaN, Infinity]) expect(readingText(s)).toBe(readingLabel(s))
    expect(countLine(312, 130)).toBe('312 words · about 2 min 24 s')
    expect(notesSummary(312, 130)).toBe('312 words · about 2 min 24 s at 130 words a minute')
    expect([0, 1, 2, 1204].map(wordsLabel)).toEqual(['0 words', '1 word', '2 words', '1,204 words'])
  })
})
