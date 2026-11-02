/**
 * The bundled caption fonts as same-origin URLs (docs/design/captions-studio.md §6.5): Vite `?url`
 * imports of resources/fonts/*.woff2, by WOFF2 file name (fontCatalog.ts CatalogFile.woff2.file),
 * so the CSP (`default-src 'self'`) covers them. Vite copies each file into the build unchanged,
 * where scripts/verify-dist.mjs checks it against the catalogue's pin.
 *
 * One import per file of the catalogue (tests/catalogFonts.test.ts checks that none is missing).
 */
import montserrat from '../../../../resources/fonts/montserrat.woff2?url'
import interTight from '../../../../resources/fonts/inter-tight.woff2?url'
import poppins600 from '../../../../resources/fonts/poppins-600.woff2?url'
import poppins700 from '../../../../resources/fonts/poppins-700.woff2?url'
import poppins800 from '../../../../resources/fonts/poppins-800.woff2?url'
import anton from '../../../../resources/fonts/anton.woff2?url'
import bebasNeue from '../../../../resources/fonts/bebas-neue.woff2?url'
import oswald from '../../../../resources/fonts/oswald.woff2?url'
import nunito from '../../../../resources/fonts/nunito.woff2?url'
import outfit from '../../../../resources/fonts/outfit.woff2?url'
import bangers from '../../../../resources/fonts/bangers.woff2?url'
import luckiestGuy from '../../../../resources/fonts/luckiest-guy.woff2?url'
import permanentMarker from '../../../../resources/fonts/permanent-marker.woff2?url'
import caveat from '../../../../resources/fonts/caveat.woff2?url'
import jetbrainsMono from '../../../../resources/fonts/jetbrains-mono.woff2?url'
import instrumentSerif from '../../../../resources/fonts/instrument-serif.woff2?url'
import instrumentSerifItalic from '../../../../resources/fonts/instrument-serif-italic.woff2?url'
import archivoBlack from '../../../../resources/fonts/archivo-black.woff2?url'
import lilitaOne from '../../../../resources/fonts/lilita-one.woff2?url'
import pressStart2p from '../../../../resources/fonts/press-start-2p.woff2?url'
import rubik from '../../../../resources/fonts/rubik.woff2?url'
import playfairDisplay from '../../../../resources/fonts/playfair-display.woff2?url'
import fredoka from '../../../../resources/fonts/fredoka.woff2?url'
import notoSansBengali from '../../../../resources/fonts/noto-sans-bengali.woff2?url'
import notoSansDevanagari from '../../../../resources/fonts/noto-sans-devanagari.woff2?url'
import notoSansArabic from '../../../../resources/fonts/noto-sans-arabic.woff2?url'
import notoSansHebrew from '../../../../resources/fonts/noto-sans-hebrew.woff2?url'
import notoSansThai from '../../../../resources/fonts/noto-sans-thai.woff2?url'
import balooDa2 from '../../../../resources/fonts/baloo-da-2.woff2?url'
import hindSiliguri400 from '../../../../resources/fonts/hind-siliguri-400.woff2?url'
import hindSiliguri600 from '../../../../resources/fonts/hind-siliguri-600.woff2?url'
import hindSiliguri700 from '../../../../resources/fonts/hind-siliguri-700.woff2?url'
import anekBangla from '../../../../resources/fonts/anek-bangla.woff2?url'
import notoSerifBengali from '../../../../resources/fonts/noto-serif-bengali.woff2?url'
import tiroBangla from '../../../../resources/fonts/tiro-bangla.woff2?url'
import tiroBanglaItalic from '../../../../resources/fonts/tiro-bangla-italic.woff2?url'
import galada from '../../../../resources/fonts/galada.woff2?url'
import atma500 from '../../../../resources/fonts/atma-500.woff2?url'
import atma700 from '../../../../resources/fonts/atma-700.woff2?url'
import mina400 from '../../../../resources/fonts/mina-400.woff2?url'
import mina700 from '../../../../resources/fonts/mina-700.woff2?url'
import notoColorEmoji from '../../../../resources/fonts/noto-color-emoji.woff2?url'

/** Each bundled WOFF2 file's URL, by file name. */
export const BUNDLED_FONT_URLS: Readonly<Record<string, string>> = {
  'montserrat.woff2': montserrat,
  'inter-tight.woff2': interTight,
  'poppins-600.woff2': poppins600,
  'poppins-700.woff2': poppins700,
  'poppins-800.woff2': poppins800,
  'anton.woff2': anton,
  'bebas-neue.woff2': bebasNeue,
  'oswald.woff2': oswald,
  'nunito.woff2': nunito,
  'outfit.woff2': outfit,
  'bangers.woff2': bangers,
  'luckiest-guy.woff2': luckiestGuy,
  'permanent-marker.woff2': permanentMarker,
  'caveat.woff2': caveat,
  'jetbrains-mono.woff2': jetbrainsMono,
  'instrument-serif.woff2': instrumentSerif,
  'instrument-serif-italic.woff2': instrumentSerifItalic,
  'archivo-black.woff2': archivoBlack,
  'lilita-one.woff2': lilitaOne,
  'press-start-2p.woff2': pressStart2p,
  'rubik.woff2': rubik,
  'playfair-display.woff2': playfairDisplay,
  'fredoka.woff2': fredoka,
  'noto-sans-bengali.woff2': notoSansBengali,
  'noto-sans-devanagari.woff2': notoSansDevanagari,
  'noto-sans-arabic.woff2': notoSansArabic,
  'noto-sans-hebrew.woff2': notoSansHebrew,
  'noto-sans-thai.woff2': notoSansThai,
  'baloo-da-2.woff2': balooDa2,
  'hind-siliguri-400.woff2': hindSiliguri400,
  'hind-siliguri-600.woff2': hindSiliguri600,
  'hind-siliguri-700.woff2': hindSiliguri700,
  'anek-bangla.woff2': anekBangla,
  'noto-serif-bengali.woff2': notoSerifBengali,
  'tiro-bangla.woff2': tiroBangla,
  'tiro-bangla-italic.woff2': tiroBanglaItalic,
  'galada.woff2': galada,
  'atma-500.woff2': atma500,
  'atma-700.woff2': atma700,
  'mina-400.woff2': mina400,
  'mina-700.woff2': mina700,
  'noto-color-emoji.woff2': notoColorEmoji
}
