/**
 * Every message key (docs/design/output-and-languages.md §9.1): the namespace, a dot, and a key of
 * that namespace's English file. Built from the JSON files with template literal types, so a key that
 * does not exist in English does not compile, and parts adding keys to different namespaces never
 * touch the same file. Type imports only: nothing here is bundled.
 */
import type commonEn from './messages/en/common.json'
import type keysEn from './messages/en/keys.json'
import type commandsEn from './messages/en/commands.json'
import type homeEn from './messages/en/home.json'
import type editorEn from './messages/en/editor.json'
import type timelineEn from './messages/en/timeline.json'
import type styleEn from './messages/en/style.json'
import type zoomEn from './messages/en/zoom.json'
import type cameraEn from './messages/en/camera.json'
import type soundEn from './messages/en/sound.json'
import type captionsEn from './messages/en/captions.json'
import type textEn from './messages/en/text.json'
import type reviewEn from './messages/en/review.json'
import type smartEn from './messages/en/smart.json'
import type exportEn from './messages/en/export.json'
import type settingsEn from './messages/en/settings.json'
import type errorsEn from './messages/en/errors.json'
import type mainEn from './messages/en/main.json'
import type codecsEn from './messages/en/codecs.json'
import type alphaEn from './messages/en/alpha.json'
import type stemsEn from './messages/en/stems.json'
import type timelinesEn from './messages/en/timelines.json'
import type presetsEn from './messages/en/presets.json'
import type languageEn from './messages/en/language.json'
import type recordingEn from './messages/en/recording.json'

type Keys<Ns extends string, M> = `${Ns}.${keyof M & string}`

/** The namespaces, one JSON file each (§9.2). */
export type Namespace =
  | 'common'
  | 'keys'
  | 'commands'
  | 'home'
  | 'editor'
  | 'timeline'
  | 'style'
  | 'zoom'
  | 'camera'
  | 'sound'
  | 'captions'
  | 'text'
  | 'review'
  | 'smart'
  | 'export'
  | 'settings'
  | 'errors'
  | 'main'
  | 'codecs'
  | 'alpha'
  | 'stems'
  | 'timelines'
  | 'presets'
  | 'language'
  | 'recording'

export type MessageKey =
  | Keys<'common', typeof commonEn>
  | Keys<'keys', typeof keysEn>
  | Keys<'commands', typeof commandsEn>
  | Keys<'home', typeof homeEn>
  | Keys<'editor', typeof editorEn>
  | Keys<'timeline', typeof timelineEn>
  | Keys<'style', typeof styleEn>
  | Keys<'zoom', typeof zoomEn>
  | Keys<'camera', typeof cameraEn>
  | Keys<'sound', typeof soundEn>
  | Keys<'captions', typeof captionsEn>
  | Keys<'text', typeof textEn>
  | Keys<'review', typeof reviewEn>
  | Keys<'smart', typeof smartEn>
  | Keys<'export', typeof exportEn>
  | Keys<'settings', typeof settingsEn>
  | Keys<'errors', typeof errorsEn>
  | Keys<'main', typeof mainEn>
  | Keys<'codecs', typeof codecsEn>
  | Keys<'alpha', typeof alphaEn>
  | Keys<'stems', typeof stemsEn>
  | Keys<'timelines', typeof timelinesEn>
  | Keys<'presets', typeof presetsEn>
  | Keys<'language', typeof languageEn>
  | Keys<'recording', typeof recordingEn>
