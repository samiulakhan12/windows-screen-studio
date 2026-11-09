/**
 * Every English namespace, registered for the renderer and the tests (docs/design/output-and-languages.md
 * §9.1). Imported first by src/renderer/src/main.tsx and by the vitest setup; main imports main.ts
 * instead. Meta files are never imported at runtime.
 */
import { registerMessages } from '../../t'
import { prefixed } from './prefixed'
import commonEn from './common.json'
import keysEn from './keys.json'
import commandsEn from './commands.json'
import homeEn from './home.json'
import editorEn from './editor.json'
import timelineEn from './timeline.json'
import styleEn from './style.json'
import zoomEn from './zoom.json'
import cameraEn from './camera.json'
import soundEn from './sound.json'
import captionsEn from './captions.json'
import textEn from './text.json'
import reviewEn from './review.json'
import smartEn from './smart.json'
import exportEn from './export.json'
import settingsEn from './settings.json'
import errorsEn from './errors.json'
import mainEn from './main.json'
import codecsEn from './codecs.json'
import alphaEn from './alpha.json'
import stemsEn from './stems.json'
import timelinesEn from './timelines.json'
import presetsEn from './presets.json'
import languageEn from './language.json'
import recordingEn from './recording.json'

registerMessages('en', {
  ...prefixed('common', commonEn),
  ...prefixed('keys', keysEn),
  ...prefixed('commands', commandsEn),
  ...prefixed('home', homeEn),
  ...prefixed('editor', editorEn),
  ...prefixed('timeline', timelineEn),
  ...prefixed('style', styleEn),
  ...prefixed('zoom', zoomEn),
  ...prefixed('camera', cameraEn),
  ...prefixed('sound', soundEn),
  ...prefixed('captions', captionsEn),
  ...prefixed('text', textEn),
  ...prefixed('review', reviewEn),
  ...prefixed('smart', smartEn),
  ...prefixed('export', exportEn),
  ...prefixed('settings', settingsEn),
  ...prefixed('errors', errorsEn),
  ...prefixed('main', mainEn),
  ...prefixed('codecs', codecsEn),
  ...prefixed('alpha', alphaEn),
  ...prefixed('stems', stemsEn),
  ...prefixed('timelines', timelinesEn),
  ...prefixed('presets', presetsEn),
  ...prefixed('language', languageEn),
  ...prefixed('recording', recordingEn)
})
