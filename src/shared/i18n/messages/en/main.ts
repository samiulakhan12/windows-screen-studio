/**
 * The English namespaces main uses: common, errors and main (docs/design/output-and-languages.md §9.1).
 * Imported first by src/main/index.ts, so main never carries the renderer's messages (test 86).
 */
import { registerMessages } from '../../t'
import { prefixed } from './prefixed'
import commonEn from './common.json'
import errorsEn from './errors.json'
import mainEn from './main.json'

registerMessages('en', { ...prefixed('common', commonEn), ...prefixed('errors', errorsEn), ...prefixed('main', mainEn) })
