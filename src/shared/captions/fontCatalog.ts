/**
 * The caption font catalogue (docs/design/captions-studio.md §6, §0.1, §0.2): every font a Captions
 * Studio look, graphic or title card can draw with, referred to as `cat:<id>`. Fonts are never
 * copied into projects; a file never changes in place (a new version gets a new id).
 *
 * Every file is pinned twice: the upstream TTF at a pinned commit of google/fonts or
 * googlefonts/noto-emoji (bytes and SHA-256: what a download is checked against and what
 * scripts/fonts.mjs converts), and, for bundled fonts, the WOFF2 made from it and committed in
 * resources/fonts (bytes and SHA-256: what the build and packaging check). The WOFF2 files hold the
 * TTF's tables byte for byte (null transforms), which `node scripts/fonts.mjs check` proves by
 * decoding them. Coverage was read from each file's character map.
 *
 * This module has no runtime imports, so scripts/fonts.mjs can load it with Node's type stripping.
 */

/** Letters a font draws (from its character map). */
export type FontCoverage =
  | 'latin'
  | 'latin-ext'
  | 'vietnamese'
  | 'cyrillic'
  | 'greek'
  | 'bengali'
  | 'devanagari'
  | 'arabic'
  | 'hebrew'
  | 'thai'
  | 'han-sc'
  | 'han-tc'
  | 'japanese'
  | 'korean'
  | 'emoji'

export type FontLicence = 'OFL-1.1' | 'Apache-2.0'

/**
 * Where a font shows in the font menu: caption fonts (§6.1 and the looks of §0.1), script fonts
 * (§6.2), the extra Bangla families (§0.2), the colour emoji (§6.3), downloads (§6.4).
 */
export type FontGroup = 'caption' | 'script' | 'bangla' | 'emoji' | 'download'

/** One file of a catalogue font. */
export interface CatalogFile {
  /** Path in the upstream repository at its pinned commit. */
  path: string
  /** The upstream TTF: bytes and SHA-256 (a download is checked against them, and never reads more bytes). */
  bytes: number
  sha256: string
  /** A static file of a family with several (Poppins, Hind Siliguri, Atma, Mina): the weight it draws. */
  weight?: number
  /** Bundled fonts: the WOFF2 made from the TTF (scripts/fonts.mjs), committed as resources/fonts/<file>. */
  woff2?: { file: string; bytes: number; sha256: string }
}

export interface CatalogFont {
  id: string
  /** The upstream family name, shown in the font menu (registered as FlownCat-<id>, §6.5). */
  family: string
  group: FontGroup
  repo: 'google/fonts' | 'googlefonts/noto-emoji'
  files: readonly CatalogFile[]
  /** The weights of static files, or a variable font's wght axis range (weights are clamped to it, §6.5). */
  weights: readonly number[] | { min: number; max: number }
  /** A variable font's wdth axis range, percent (the FontFace stretch descriptor). */
  stretch?: { min: number; max: number }
  /** An italic face (never used to fake italics of another font). */
  italic?: true
  coverage: readonly FontCoverage[]
  licence: FontLicence
  /** The font drawing a caption whose language needs letters this one lacks (§6.6); absent: none. */
  partner?: string
  /** Shipped with the app (resources/fonts) or downloaded on demand (§6.4). */
  bundled: boolean
  /** The family's own source repository and commit, from its METADATA.pb at the pinned commit (FONTS.md, notices). */
  upstream: { repository: string; commit: string }
  copyright: string
  /** Downloaded fonts: the caption languages they are offered for, and the Windows font that draws until then. */
  download?: { languages: readonly string[]; until: string }
}

/** google/fonts at this commit (2026-10-30) holds every catalogue font but the emoji. */
export const GOOGLE_FONTS_COMMIT = '6c1dbe27dcf7d817d4b62cec033ba77fa8e2a5ec'
/** googlefonts/noto-emoji at tag v2026-09-24-unicode18_0. */
export const NOTO_EMOJI_COMMIT = 'e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e'
export const NOTO_EMOJI_TAG = 'v2026-09-24-unicode18_0'

/**
 * The Qbexel mirror of the downloadable files (a Hugging Face repository at a pinned commit, §12),
 * tried before upstream; null until it exists (§0.3 decision 1: upstream only for wave 9).
 */
export const CAPTION_MIRROR: { repository: string; commit: string } | null = null

/** The prefix of a catalogue font in StudioText.font, graphics and title cards. */
export const CATALOG_PREFIX = 'cat:'

export const CATALOG_FONTS: readonly CatalogFont[] = [
  {
    id: 'montserrat',
    family: 'Montserrat',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/montserrat/Montserrat[wght].ttf', bytes: 744936, sha256: '0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7', woff2: { file: 'montserrat.woff2', bytes: 228932, sha256: '29a13364221abeed00bfc95cc417f940225b04c6ace8300571b7a91ddc3a72f1' } }
    ],
    weights: { min: 100, max: 900 },
    coverage: ['latin', 'latin-ext', 'vietnamese', 'cyrillic'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/JulietaUla/Montserrat', commit: 'cc8daf2e7085006b9c112542fc82b58afc13521d' },
    copyright: 'Copyright 2011 The Montserrat Project Authors (https://github.com/JulietaUla/Montserrat)'
  },
  {
    id: 'inter-tight',
    family: 'Inter Tight',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/intertight/InterTight[wght].ttf', bytes: 581588, sha256: 'b81b73dcb64df3c230cabade7df6c5773bf863233f24c9ee51087519f1f88b6f', woff2: { file: 'inter-tight.woff2', bytes: 249040, sha256: '72759a7d2d541715db2b923f9ea3e562ec7f4044798164438ba8466de4a54b14' } }
    ],
    weights: { min: 100, max: 900 },
    coverage: ['latin', 'latin-ext', 'vietnamese', 'cyrillic', 'greek'],
    licence: 'OFL-1.1',
    bundled: true,
    upstream: { repository: 'https://github.com/rsms/inter-gf-tight', commit: 'c194f94c60b569b47876811321f5ef1f0c2614a2' },
    copyright: 'Copyright 2022 The Inter Project Authors (https://github.com/rsms/inter-tight)'
  },
  {
    id: 'poppins',
    family: 'Poppins',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/poppins/Poppins-SemiBold.ttf', bytes: 157312, sha256: 'd3bf1bdaf0550e83da9ac0b1d1d9fe6db086835a83aa28578e609a394b9a0286', weight: 600, woff2: { file: 'poppins-600.woff2', bytes: 63692, sha256: 'bbeea534d1a4f2ade82a2a2ec02e4932178879bae3a0816082e24623f9c1220b' } },
      { path: 'ofl/poppins/Poppins-Bold.ttf', bytes: 155996, sha256: '983676516167748b74de6f4771fb384c664fd913acb8b471122ecacf5da5ea6c', weight: 700, woff2: { file: 'poppins-700.woff2', bytes: 63000, sha256: 'c109399a17bf24caf81ab49005b717c86f4d546a45502c208122d60110707ce0' } },
      { path: 'ofl/poppins/Poppins-ExtraBold.ttf', bytes: 154836, sha256: 'f2ab17c1a63a0ecc12c2461848fc8a469395e3cd2d641803e889c643d9f958e1', weight: 800, woff2: { file: 'poppins-800.woff2', bytes: 63112, sha256: '85738c4502498c5dd875c370ce6eddb7ee9143317acc13b7f4af281722d52be2' } }
    ],
    weights: [600, 700, 800],
    coverage: ['latin', 'latin-ext', 'devanagari'],
    licence: 'OFL-1.1',
    partner: 'montserrat',
    bundled: true,
    upstream: { repository: 'https://github.com/itfoundry/Poppins', commit: '738d9d691b66f1ad917123c58df104d16c74e1a7' },
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)'
  },
  {
    id: 'anton',
    family: 'Anton',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/anton/Anton-Regular.ttf', bytes: 170812, sha256: 'a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab', woff2: { file: 'anton.woff2', bytes: 65148, sha256: '3efd05f689894364f11df6c916fb942480458863388c64e5b7b105cd634a8a69' } }
    ],
    weights: [400],
    coverage: ['latin', 'latin-ext', 'vietnamese'],
    licence: 'OFL-1.1',
    partner: 'oswald',
    bundled: true,
    upstream: { repository: 'https://github.com/googlefonts/AntonFont', commit: 'beb92fcad87808357123bb66881b4032dc96efe7' },
    copyright: 'Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont.git)'
  },
  {
    id: 'bebas-neue',
    family: 'Bebas Neue',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/bebasneue/BebasNeue-Regular.ttf', bytes: 61400, sha256: '08e4623805102d819f58601e46e345648846075e363b2ceb23313c2d1c83ec73', woff2: { file: 'bebas-neue.woff2', bytes: 24588, sha256: '614beaf779f0467a77e5cfc0051f3c6db645d6772205ed43ec40ede3b4a4c690' } }
    ],
    weights: [400],
    coverage: ['latin', 'latin-ext'],
    licence: 'OFL-1.1',
    partner: 'oswald',
    bundled: true,
    upstream: { repository: 'https://github.com/dharmatype/Bebas-Neue', commit: '686d14af640c17af3691c597778f121d840d9051' },
    copyright: 'Copyright 2019 The Bebas Neue Project Authors (https://github.com/dharmatype/Bebas-Neue)'
  },
  {
    id: 'oswald',
    family: 'Oswald',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/oswald/Oswald[wght].ttf', bytes: 172088, sha256: '5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817', woff2: { file: 'oswald.woff2', bytes: 76644, sha256: '84f26d0ba69ad2de18360801e15600bb2e0e858a1ef43af00728c352bbf16e7c' } }
    ],
    weights: { min: 200, max: 700 },
    coverage: ['latin', 'latin-ext', 'vietnamese', 'cyrillic'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/googlefonts/OswaldFont', commit: '89795261ac9eeb9aa8cd99f43982c4e4b0e53261' },
    copyright: 'Copyright 2016 The Oswald Project Authors (https://github.com/googlefonts/OswaldFont)'
  },
  {
    id: 'nunito',
    family: 'Nunito',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/nunito/Nunito[wght].ttf', bytes: 276932, sha256: 'bb55a5ca5c2042335b3991af27c4d0705d0ef41cac6164ac737fd8f2a1e85207', woff2: { file: 'nunito.woff2', bytes: 108072, sha256: 'e2b6d8eaa7f14db0239d84a92f3bc01665825cb5e73dba51e28752b69afcb68b' } }
    ],
    weights: { min: 200, max: 1000 },
    coverage: ['latin', 'latin-ext', 'vietnamese', 'cyrillic'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/googlefonts/nunito', commit: '8c6a9bb9732545b9ed53f29ec5e1ab0ff53c4e6f' },
    copyright: 'Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito)'
  },
  {
    id: 'outfit',
    family: 'Outfit',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/outfit/Outfit[wght].ttf', bytes: 110884, sha256: 'fc7287273e66929776e2ba54f144fe699080bec29f61bf649d70d871468aeade', woff2: { file: 'outfit.woff2', bytes: 47800, sha256: 'f9e1469c9b71d4b79d87215d4f2c4705b5eb4a307e8120d5db426ccb707af831' } }
    ],
    weights: { min: 100, max: 900 },
    coverage: ['latin', 'latin-ext'],
    licence: 'OFL-1.1',
    partner: 'montserrat',
    bundled: true,
    upstream: { repository: 'https://github.com/Outfitio/Outfit-Fonts', commit: '902773808eb372f70fb34e8946dd1ffe604efc79' },
    copyright: 'Copyright 2021 The Outfit Project Authors (https://github.com/Outfitio/Outfit-Fonts)'
  },
  {
    id: 'bangers',
    family: 'Bangers',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/bangers/Bangers-Regular.ttf', bytes: 93148, sha256: '4160a7311de9342674cce9160cde9fcbb30f48190397d86ff1b70b455af65824', woff2: { file: 'bangers.woff2', bytes: 40492, sha256: '9cdcb43e5f096f7f6455009a0d507f43fcc98901931c42819605e58fffd2feb2' } }
    ],
    weights: [400],
    coverage: ['latin', 'latin-ext', 'vietnamese'],
    licence: 'OFL-1.1',
    partner: 'montserrat',
    bundled: true,
    upstream: { repository: 'https://github.com/googlefonts/bangers', commit: 'ca6d2f15db343ee373e9c62a127f3a48cd251228' },
    copyright: 'Copyright 2010 The Bangers Project Authors (https://github.com/googlefonts/bangers)'
  },
  {
    id: 'luckiest-guy',
    family: 'Luckiest Guy',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'apache/luckiestguy/LuckiestGuy-Regular.ttf', bytes: 73320, sha256: 'cfbdd68a039f92df51cf3721506af6242e64594c6325fe0bedbeff3fe385d980', woff2: { file: 'luckiest-guy.woff2', bytes: 29516, sha256: '5d4389032c6502a5bb8883dbcfc0409fcdf5a52042211135718a032738bb152f' } }
    ],
    weights: [400],
    coverage: ['latin', 'latin-ext'],
    licence: 'Apache-2.0',
    partner: 'montserrat',
    bundled: true,
    upstream: { repository: 'https://github.com/googlefonts/googlefontdirectory-hg', commit: '52f780bc9d197280a9f430574e179a5f233c56b6' },
    copyright: 'Copyright (c) 2010 by Brian J. Bonislawsky DBA Astigmatic (AOETI). All rights reserved. Available under the Apache 2.0 licence. http://www.apache.org/licenses/LICENSE-2.0.html'
  },
  {
    id: 'permanent-marker',
    family: 'Permanent Marker',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'apache/permanentmarker/PermanentMarker-Regular.ttf', bytes: 74632, sha256: '28f82c8a7943cb8e9d599f8554da1d4fc75dbcf69b9885ad6c0611d20c6946c5', woff2: { file: 'permanent-marker.woff2', bytes: 33296, sha256: '9f3f4a6f917d3fb9685b2578bdf4a16e368d3c3ebb46e0ad0bc22171be239575' } }
    ],
    weights: [400],
    coverage: ['latin'],
    licence: 'Apache-2.0',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/googlefonts/permanentmarker', commit: 'b0786e381d1475883fef04d2f3c7541fe51efe93' },
    copyright: 'Copyright (c) 2010 by Font Diner, Inc. All rights reserved.'
  },
  {
    id: 'caveat',
    family: 'Caveat',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/caveat/Caveat[wght].ttf', bytes: 403648, sha256: '0bdb6b660482d31531b3945849fba5916b3ef8695da7024a9e6b9ee3c4157988', woff2: { file: 'caveat.woff2', bytes: 182456, sha256: 'a70c67c3529b81af8cd65811e83f995d15f24a69049bfe3db1f0e4aedad8c4cb' } }
    ],
    weights: { min: 400, max: 700 },
    coverage: ['latin', 'latin-ext', 'cyrillic'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/googlefonts/caveat', commit: '59745e818ef7973e11e70cb1358d0e902b56c5fc' },
    copyright: 'Copyright 2014 The Caveat Project Authors (https://github.com/googlefonts/caveat)'
  },
  {
    id: 'jetbrains-mono',
    family: 'JetBrains Mono',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/jetbrainsmono/JetBrainsMono[wght].ttf', bytes: 187208, sha256: '48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda', woff2: { file: 'jetbrains-mono.woff2', bytes: 78660, sha256: '07e48fc61607b80d33d48d29d1141450149e5aa82ef5ec93ff9869144867017c' } }
    ],
    weights: { min: 100, max: 800 },
    coverage: ['latin', 'latin-ext', 'vietnamese', 'cyrillic', 'greek'],
    licence: 'OFL-1.1',
    bundled: true,
    upstream: { repository: 'https://github.com/JetBrains/JetBrainsMono', commit: '19371302b95d218af43299bce79ddbddd0bc364d' },
    copyright: 'Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)'
  },
  {
    id: 'instrument-serif',
    family: 'Instrument Serif',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/instrumentserif/InstrumentSerif-Regular.ttf', bytes: 70012, sha256: '498efd461f6ddfcb7a111bf9a565709d2085d48201d501ead960d93e84ffbb88', woff2: { file: 'instrument-serif.woff2', bytes: 29932, sha256: 'b34a17cd257069e286adc66279b7a7c408a5caf91c4fb77d34fe0bae33e87eeb' } }
    ],
    weights: [400],
    coverage: ['latin', 'latin-ext'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/Instrument/instrument-serif', commit: '65c0ef225f386a3c7e87570a4aa9cc0262c2fd81' },
    copyright: 'Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif)'
  },
  {
    id: 'instrument-serif-italic',
    family: 'Instrument Serif',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/instrumentserif/InstrumentSerif-Italic.ttf', bytes: 71592, sha256: '08939b8bdf534afec24ae0ef5e03f948940cd9a8fe08e7fecbad040e62327385', woff2: { file: 'instrument-serif-italic.woff2', bytes: 30660, sha256: 'f1d7f87b4da9efbe2d9252b27598d2ce28a74ecf9cd41329cf25fa41cfe9e100' } }
    ],
    weights: [400],
    italic: true,
    coverage: ['latin', 'latin-ext'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/Instrument/instrument-serif', commit: '65c0ef225f386a3c7e87570a4aa9cc0262c2fd81' },
    copyright: 'Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif)'
  },
  {
    id: 'archivo-black',
    family: 'Archivo Black',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/archivoblack/ArchivoBlack-Regular.ttf', bytes: 90988, sha256: 'dd9a89a019b4849f66ab75455fe7bdf931311042cbb0f0f97acc061539703180', woff2: { file: 'archivo-black.woff2', bytes: 36896, sha256: '767bdc286c59bcd92e4e0091eca19667b08dcebd13e80c66ac7bb9208dd38a56' } }
    ],
    weights: [400],
    coverage: ['latin', 'latin-ext'],
    licence: 'OFL-1.1',
    partner: 'montserrat',
    bundled: true,
    upstream: { repository: 'https://github.com/Omnibus-Type/ArchivoBlack', commit: '95df3c54d818473a3e362f30ae3059bd85b80036' },
    copyright: 'Copyright 2017 The Archivo Black Project Authors (https://github.com/Omnibus-Type/ArchivoBlack)'
  },
  {
    id: 'lilita-one',
    family: 'Lilita One',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/lilitaone/LilitaOne-Regular.ttf', bytes: 28092, sha256: 'f5b641c45c69d772ee4eda687bc9fda411d5cad6b0b45371491da4580cbc8d59', woff2: { file: 'lilita-one.woff2', bytes: 14388, sha256: 'bfc5826cd6ecdba76b6e41dcb24ff2ffe059df703b95950ed82cda04f683c533' } }
    ],
    weights: [400],
    coverage: ['latin'],
    licence: 'OFL-1.1',
    partner: 'montserrat',
    bundled: true,
    upstream: { repository: 'https://github.com/googlefonts/googlefontdirectory-hg', commit: '52f780bc9d197280a9f430574e179a5f233c56b6' },
    copyright: 'Copyright (c) 2011 Juan Montoreano (juan@remolacha.biz), with Reserved Font Names "Lilita One"'
  },
  {
    id: 'press-start-2p',
    family: 'Press Start 2P',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/pressstart2p/PressStart2P-Regular.ttf', bytes: 118204, sha256: '034c77f1f05ec89421e4a63f0e3a4ca1ecf852cc6d2bf611f126f275728e017d', woff2: { file: 'press-start-2p.woff2', bytes: 32904, sha256: '4bc4c08bb969541237987ab34f317844ee677adb7a21eef872731fa353f2e7e1' } }
    ],
    weights: [400],
    coverage: ['latin', 'latin-ext', 'cyrillic', 'greek'],
    licence: 'OFL-1.1',
    partner: 'jetbrains-mono',
    bundled: true,
    upstream: { repository: 'https://github.com/googlefonts/googlefontdirectory-hg', commit: '52f780bc9d197280a9f430574e179a5f233c56b6' },
    copyright: 'Copyright 2012 The Press Start 2P Project Authors (cody@zone38.net), with Reserved Font Name "Press Start 2P"'
  },
  {
    id: 'rubik',
    family: 'Rubik',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/rubik/Rubik[wght].ttf', bytes: 359804, sha256: '1b3a7437ba2af80e465e773ed60c5036d1ba6ace492d89046dbcf18fb31e4e88', woff2: { file: 'rubik.woff2', bytes: 121668, sha256: '82b20d629de5bce84dab63f5db6cc99650090778e11886e35eabc2dbc65e22dd' } }
    ],
    weights: { min: 300, max: 900 },
    coverage: ['latin', 'latin-ext', 'cyrillic', 'arabic', 'hebrew'],
    licence: 'OFL-1.1',
    partner: 'montserrat',
    bundled: true,
    upstream: { repository: 'https://github.com/googlefonts/rubik', commit: '9167c98fa8699d75ee51769eba20d81beb16bcb5' },
    copyright: 'Copyright 2015 The Rubik Project Authors (https://github.com/googlefonts/rubik)'
  },
  {
    id: 'playfair-display',
    family: 'Playfair Display',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/playfairdisplay/PlayfairDisplay[wght].ttf', bytes: 300724, sha256: 'c40f2293766a503bc70cce9e512ef844a4ccb7cbcde792fe2ea31d191917d8d6', woff2: { file: 'playfair-display.woff2', bytes: 112000, sha256: '0bd3146791fb36d644df6a7951b60220dfdedd9aaa82aa40339666b78ddc8c0b' } }
    ],
    weights: { min: 400, max: 900 },
    coverage: ['latin', 'latin-ext', 'vietnamese', 'cyrillic'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/clauseggers/Playfair', commit: '80a334101928546b04fa9e709ad4b2f11f8a9e10' },
    copyright: 'Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display".'
  },
  {
    id: 'fredoka',
    family: 'Fredoka',
    group: 'caption',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/fredoka/Fredoka[wdth,wght].ttf', bytes: 159184, sha256: '2ba02e68b152868aef9ba28e24b3648c7d457fe6f25c761f2c2c53fb61a73fc8', woff2: { file: 'fredoka.woff2', bytes: 89040, sha256: '84b1595a9adf76ecb5969e60dd64e403e9719cd0a40c958235c8b52cd00e24c8' } }
    ],
    weights: { min: 300, max: 700 },
    stretch: { min: 75, max: 125 },
    coverage: ['latin', 'hebrew'],
    licence: 'OFL-1.1',
    partner: 'nunito',
    bundled: true,
    upstream: { repository: 'https://github.com/hafontia-zz/Fredoka-One', commit: '35c584ff23450c9bcdf8819706e12fcdeefe1712' },
    copyright: 'Copyright 2016 The Fredoka Project Authors (https://github.com/hafontia/Fredoka-One)'
  },
  {
    id: 'noto-sans-bengali',
    family: 'Noto Sans Bengali',
    group: 'script',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/notosansbengali/NotoSansBengali[wdth,wght].ttf', bytes: 463668, sha256: 'dcd42978094e584a849c84a51450eeac40c8826057d566ea6d4b9627a403a05a', woff2: { file: 'noto-sans-bengali.woff2', bytes: 249868, sha256: 'be817be97b29a360dd29b6bcd8bd1474912560d71f3893d45ccad5cfbdad3374' } }
    ],
    weights: { min: 100, max: 900 },
    stretch: { min: 62.5, max: 100 },
    coverage: ['latin', 'latin-ext', 'bengali'],
    licence: 'OFL-1.1',
    bundled: true,
    upstream: { repository: 'https://github.com/notofonts/bengali', commit: '85d80394cbbbb798ca0a41c983902e6cf77be3a3' },
    copyright: 'Copyright 2025 The Noto Project Authors (https://github.com/notofonts/bengali)'
  },
  {
    id: 'noto-sans-devanagari',
    family: 'Noto Sans Devanagari',
    group: 'script',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/notosansdevanagari/NotoSansDevanagari[wdth,wght].ttf', bytes: 641944, sha256: '14ec4af41f27482216d1c2229f417ff9b1425e1babb014e57d1d40d03229853e', woff2: { file: 'noto-sans-devanagari.woff2', bytes: 272320, sha256: '1c48d371affe4dac62dff273f1d782e92d1cc6bcff704e6213ee05c2fbe5414c' } }
    ],
    weights: { min: 100, max: 900 },
    stretch: { min: 62.5, max: 100 },
    coverage: ['latin', 'latin-ext', 'devanagari'],
    licence: 'OFL-1.1',
    bundled: true,
    upstream: { repository: 'https://github.com/notofonts/devanagari', commit: 'e123d230c160ebe949d731cc19017cdb354180d1' },
    copyright: 'Copyright 2022 The Noto Project Authors (https://github.com/notofonts/devanagari)'
  },
  {
    id: 'noto-sans-arabic',
    family: 'Noto Sans Arabic',
    group: 'script',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/notosansarabic/NotoSansArabic[wdth,wght].ttf', bytes: 844676, sha256: '63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e', woff2: { file: 'noto-sans-arabic.woff2', bytes: 368624, sha256: '7e9213629de08923a72f49b68edd3e43d5c559c08bf4847af3f4e10d87feef7e' } }
    ],
    weights: { min: 100, max: 900 },
    stretch: { min: 62.5, max: 100 },
    coverage: ['latin', 'latin-ext', 'arabic'],
    licence: 'OFL-1.1',
    bundled: true,
    upstream: { repository: 'https://github.com/notofonts/arabic', commit: '6c8320740db19efbb3127c3697b0ee5d0fa62319' },
    copyright: 'Copyright 2022 The Noto Project Authors (https://github.com/notofonts/arabic)'
  },
  {
    id: 'noto-sans-hebrew',
    family: 'Noto Sans Hebrew',
    group: 'script',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/notosanshebrew/NotoSansHebrew[wdth,wght].ttf', bytes: 112640, sha256: '7ef36a2c3593758cdb622e1bdef4f84523e92fbc3ccc667438dd80ff54c2de88', woff2: { file: 'noto-sans-hebrew.woff2', bytes: 61856, sha256: '93fb468336d9d45b5b3a21ba0b050bf5f29fea717d8163c8e9cf15148b3d0a06' } }
    ],
    weights: { min: 100, max: 900 },
    stretch: { min: 62.5, max: 100 },
    coverage: ['latin', 'latin-ext', 'hebrew'],
    licence: 'OFL-1.1',
    bundled: true,
    upstream: { repository: 'https://github.com/notofonts/hebrew', commit: 'd2ce986faa9c149e8961c7bceddb8e376760541a' },
    copyright: 'Copyright 2024 The Noto Project Authors (https://github.com/notofonts/hebrew)'
  },
  {
    id: 'noto-sans-thai',
    family: 'Noto Sans Thai',
    group: 'script',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/notosansthai/NotoSansThai[wdth,wght].ttf', bytes: 218652, sha256: '5a1c559bb539583c8a1fd99d1c5b9491e5e14478c9cd2bd0970d5c3096cc9ef8', woff2: { file: 'noto-sans-thai.woff2', bytes: 111372, sha256: '3376327da7cadff68d574b7db9ac9c9b64a57363229e63ec0822e963488b818e' } }
    ],
    weights: { min: 100, max: 900 },
    stretch: { min: 62.5, max: 100 },
    coverage: ['latin', 'latin-ext', 'thai'],
    licence: 'OFL-1.1',
    bundled: true,
    upstream: { repository: 'https://github.com/notofonts/thai', commit: 'f8f3f024703f9d939d02f4e2fe16f1d5a39ca963' },
    copyright: 'Copyright 2022 The Noto Project Authors (https://github.com/notofonts/thai)'
  },
  {
    id: 'baloo-da-2',
    family: 'Baloo Da 2',
    group: 'script',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/balooda2/BalooDa2[wght].ttf', bytes: 451504, sha256: '8b62a8c4dbe659be5e4d40c19b7b3012120335b333205c5aa101b45cdb449cff', woff2: { file: 'baloo-da-2.woff2', bytes: 162392, sha256: '14607e857013ba9f99166450656a48be1d76fa78627d18b6683a3b07ff7b3a90' } }
    ],
    weights: { min: 400, max: 800 },
    coverage: ['latin', 'latin-ext', 'vietnamese', 'bengali'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/yanone/Baloo2-Variable', commit: 'ffd6308743a5829fe6980ce86f5629ba0250df98' },
    copyright: 'Copyright 2019 The Baloo 2 Project Authors (https://github.com/EkType/Baloo2)'
  },
  {
    id: 'hind-siliguri',
    family: 'Hind Siliguri',
    group: 'bangla',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/hindsiliguri/HindSiliguri-Regular.ttf', bytes: 250052, sha256: '45071a7da902a74877f432722f525d00502d61aef71fca4cab3da8a23156c33d', weight: 400, woff2: { file: 'hind-siliguri-400.woff2', bytes: 104024, sha256: '56328bf8412702565ee846bcdbbb66a433bcf1dc837ff9f33eaa770dbbf66f15' } },
      { path: 'ofl/hindsiliguri/HindSiliguri-SemiBold.ttf', bytes: 272740, sha256: '92a9a68240883467830b87b2568242a59e68d4535e9e15f087650e12c4aaca83', weight: 600, woff2: { file: 'hind-siliguri-600.woff2', bytes: 107824, sha256: '6f6c353e9b593ba1858628697775242f222275323ef0d55e83f00232709857c8' } },
      { path: 'ofl/hindsiliguri/HindSiliguri-Bold.ttf', bytes: 287660, sha256: 'd135765781d1a4aebc7dd4a2af221427ec8689060121d8a48b19bca3eeb3977e', weight: 700, woff2: { file: 'hind-siliguri-700.woff2', bytes: 105016, sha256: 'c9871f4847c5e3d7ef828d7a332696e828adcfbe1bbaf3b42e886bfbeaff92d0' } }
    ],
    weights: [400, 600, 700],
    coverage: ['latin', 'latin-ext', 'bengali'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/itfoundry/hind-siliguri', commit: 'affb7dbd00dc554c33ecafc92cbfef5323ae5235' },
    copyright: 'Copyright (c) 2015 Indian Type Foundry (info@indiantypefoundry.com)'
  },
  {
    id: 'anek-bangla',
    family: 'Anek Bangla',
    group: 'bangla',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/anekbangla/AnekBangla[wdth,wght].ttf', bytes: 1344456, sha256: '8b4ec2eaf7400ea9903718a4addf3135475292e6e0b04db7735d0f999289d919', woff2: { file: 'anek-bangla.woff2', bytes: 589644, sha256: '0c200671adc718ea7bdf4d13e67723ed9b17f5c31ee1b68f80babb8640e56bab' } }
    ],
    weights: { min: 100, max: 800 },
    stretch: { min: 75, max: 125 },
    coverage: ['latin', 'bengali'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/EkType/Anek', commit: '34074c6b406f4112e20c7ad10254a6e954d0324b' },
    copyright: 'Copyright 2021 The Anek Project Authors (https://github.com/EkType/Anek)'
  },
  {
    id: 'noto-serif-bengali',
    family: 'Noto Serif Bengali',
    group: 'bangla',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/notoserifbengali/NotoSerifBengali[wdth,wght].ttf', bytes: 981812, sha256: '083180a7b47cf3b101ed55a8724aa1b38869daa9baf23b7cf198f9d225365aba', woff2: { file: 'noto-serif-bengali.woff2', bytes: 426772, sha256: '6ce3fcbb6046074f0004d2521bf850580d0c08d5b45891a983e9800e9781f194' } }
    ],
    weights: { min: 100, max: 900 },
    stretch: { min: 62.5, max: 100 },
    coverage: ['latin', 'latin-ext', 'bengali'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/notofonts/bengali', commit: '7ab89a047313e4a2c7ca5d670b28ced031c86542' },
    copyright: 'Copyright 2025 The Noto Project Authors (https://github.com/notofonts/bengali)'
  },
  {
    id: 'tiro-bangla',
    family: 'Tiro Bangla',
    group: 'bangla',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/tirobangla/TiroBangla-Regular.ttf', bytes: 323776, sha256: 'a763523dc3f90a71962cb8d9400b8f0a86b40b2cb01676f165101a2967127ae4', woff2: { file: 'tiro-bangla.woff2', bytes: 137704, sha256: 'f276279663a3142efe88cc553bd0524449f0b72657898048d0b106133ded1f8d' } }
    ],
    weights: [400],
    coverage: ['latin', 'bengali'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/TiroTypeworks/Indigo', commit: '98b5d3a01c534b7029af04a59d31e0d7d90be15a' },
    copyright: 'Copyright 2020 The Indigo Project Authors (https://github.com/TiroTypeworks/Indigo)'
  },
  {
    id: 'tiro-bangla-italic',
    family: 'Tiro Bangla',
    group: 'bangla',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/tirobangla/TiroBangla-Italic.ttf', bytes: 329576, sha256: 'deb8330a56697cfabef8ff393c6d36af60531229b138bf9a3ffe834330cb03e1', woff2: { file: 'tiro-bangla-italic.woff2', bytes: 143972, sha256: '41bb22f502c125bb5fb78e9294649c690eebad8d63dca827ea7e657cb119d58e' } }
    ],
    weights: [400],
    italic: true,
    coverage: ['latin', 'bengali'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/TiroTypeworks/Indigo', commit: '98b5d3a01c534b7029af04a59d31e0d7d90be15a' },
    copyright: 'Copyright 2020 The Indigo Project Authors (https://github.com/TiroTypeworks/Indigo)'
  },
  {
    id: 'galada',
    family: 'Galada',
    group: 'bangla',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/galada/Galada-Regular.ttf', bytes: 187776, sha256: 'acc22b41ee470dc542e15b5f8907c7fbebef1b9c01eb20e4127bdbf052b006ee', woff2: { file: 'galada.woff2', bytes: 79652, sha256: 'a2ea661d15cd7708eab2a18bddd6dbe10c366a01528a99ef09451e8f6afbf363' } }
    ],
    weights: [400],
    coverage: ['latin', 'bengali'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/BlackFoundryCom/Galada', commit: 'ee2fe5b461b2af0ade8952a7d4150958689433b4' },
    copyright: 'Copyright (c) 2010 by Pablo Impallari (www.impallari.com). Copyright (c) 2015 by black foundry (www.black-foundry.com)'
  },
  {
    id: 'atma',
    family: 'Atma',
    group: 'bangla',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/atma/Atma-Medium.ttf', bytes: 220636, sha256: '369d9788c926ea6f3650999617beb348238f370d65b3d5d180d638c82ea3d82a', weight: 500, woff2: { file: 'atma-500.woff2', bytes: 93948, sha256: '79f13844b0e3103bac23c898df65ae31c03a7b5d9ebc734cf6af907dd79dc7e8' } },
      { path: 'ofl/atma/Atma-Bold.ttf', bytes: 216512, sha256: 'd55399f5bcdb78f60da7dbd6c5abfdc92510154361586ad1b07bca7ee739dba6', weight: 700, woff2: { file: 'atma-700.woff2', bytes: 86364, sha256: '61f4ce47ad6bb6e3c27ba23c0ad38ee08f9e68b8913ead148b83dfd9bb4ad3c1' } }
    ],
    weights: [500, 700],
    coverage: ['latin', 'latin-ext', 'bengali'],
    licence: 'OFL-1.1',
    partner: 'nunito',
    bundled: true,
    upstream: { repository: 'https://github.com/BlackFoundryCom/Atma', commit: 'f805a3068057f9422e57427b4538c7d168684c7a' },
    copyright: 'Copyright 2015 The Atma Project Authors (www.black-foundry.com)'
  },
  {
    id: 'mina',
    family: 'Mina',
    group: 'bangla',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/mina/Mina-Regular.ttf', bytes: 151240, sha256: '1ca8f5fb637e21fd6ce7cd4cc230b7284a90524ce93a696b838bbe3edd25ab7c', weight: 400, woff2: { file: 'mina-400.woff2', bytes: 69296, sha256: '0442ccaed21f9d3a6f6eba3c5dd9281e35176876817c88cae4127d8e4a463645' } },
      { path: 'ofl/mina/Mina-Bold.ttf', bytes: 152604, sha256: 'eb125869e00d5e2fa33baa03344923141f31a5f10e1ae3fa65143cb2739fc318', weight: 700, woff2: { file: 'mina-700.woff2', bytes: 69400, sha256: 'ab862941ae0354c03158621a9afd449350ea0d243fb3f14befa60f3fe8acffa9' } }
    ],
    weights: [400, 700],
    coverage: ['latin', 'latin-ext', 'bengali'],
    licence: 'OFL-1.1',
    partner: 'inter-tight',
    bundled: true,
    upstream: { repository: 'https://github.com/suman51284/Mina', commit: '20350840b9a0b08d7855d22e2890c3ed93237edd' },
    copyright: 'Copyright 2015 The Mina Project Authors, with Reserved Font Name \'Exo\''
  },
  {
    id: 'noto-color-emoji',
    family: 'Noto Color Emoji',
    group: 'emoji',
    repo: 'googlefonts/noto-emoji',
    files: [
      { path: '2D/fonts/Noto-COLRv1.ttf', bytes: 5038236, sha256: 'b8e25ea68db82f9e4d0aee921f4420be2be39887bd5c893a2ad98710531f9d0c', woff2: { file: 'noto-color-emoji.woff2', bytes: 2406012, sha256: 'dee5919e30dd8079518dae0fff3ecadadd60ad77fb5986da2c973ad57a5b1d17' } }
    ],
    weights: [400],
    coverage: ['emoji'],
    licence: 'OFL-1.1',
    bundled: true,
    upstream: { repository: 'https://github.com/googlefonts/noto-emoji', commit: 'e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e' },
    copyright: 'Copyright 2022 Google Inc.'
  },
  {
    id: 'noto-sans-sc',
    family: 'Noto Sans SC',
    group: 'download',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/notosanssc/NotoSansSC[wght].ttf', bytes: 17772300, sha256: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da' }
    ],
    weights: { min: 100, max: 900 },
    coverage: ['latin', 'cyrillic', 'greek', 'han-sc'],
    licence: 'OFL-1.1',
    bundled: false,
    upstream: { repository: 'https://github.com/notofonts/noto-cjk', commit: '523d033d6cb47f4a80c58a35753646f5c3608a78' },
    copyright: '(c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name \'Source\'.',
    download: { languages: ['zh', 'zh-Hans'], until: 'Microsoft YaHei UI' }
  },
  {
    id: 'noto-sans-tc',
    family: 'Noto Sans TC',
    group: 'download',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/notosanstc/NotoSansTC[wght].ttf', bytes: 11941968, sha256: '864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f' }
    ],
    weights: { min: 100, max: 900 },
    coverage: ['latin', 'cyrillic', 'greek', 'han-tc'],
    licence: 'OFL-1.1',
    bundled: false,
    upstream: { repository: 'https://github.com/notofonts/noto-cjk', commit: '523d033d6cb47f4a80c58a35753646f5c3608a78' },
    copyright: '(c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name \'Source\'.',
    download: { languages: ['zh-Hant', 'zh-TW', 'zh-HK'], until: 'Microsoft JhengHei UI' }
  },
  {
    id: 'noto-sans-jp',
    family: 'Noto Sans JP',
    group: 'download',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/notosansjp/NotoSansJP[wght].ttf', bytes: 9589900, sha256: 'c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f' }
    ],
    weights: { min: 100, max: 900 },
    coverage: ['latin', 'cyrillic', 'greek', 'japanese'],
    licence: 'OFL-1.1',
    bundled: false,
    upstream: { repository: 'https://github.com/notofonts/noto-cjk', commit: '523d033d6cb47f4a80c58a35753646f5c3608a78' },
    copyright: '(c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name \'Source\'.',
    download: { languages: ['ja'], until: 'Yu Gothic UI' }
  },
  {
    id: 'noto-sans-kr',
    family: 'Noto Sans KR',
    group: 'download',
    repo: 'google/fonts',
    files: [
      { path: 'ofl/notosanskr/NotoSansKR[wght].ttf', bytes: 10414588, sha256: '194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252' }
    ],
    weights: { min: 100, max: 900 },
    coverage: ['latin', 'cyrillic', 'greek', 'korean'],
    licence: 'OFL-1.1',
    bundled: false,
    upstream: { repository: 'https://github.com/notofonts/noto-cjk', commit: '523d033d6cb47f4a80c58a35753646f5c3608a78' },
    copyright: '(c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name \'Source\'.',
    download: { languages: ['ko'], until: 'Malgun Gothic' }
  }
]

const BY_ID: ReadonlyMap<string, CatalogFont> = new Map(CATALOG_FONTS.map((f) => [f.id, f]))

/** The catalogue font `id` ('montserrat', without the prefix), or undefined. */
export function catalogFont(id: string): CatalogFont | undefined {
  return BY_ID.get(id)
}

/** The catalogue id of a font reference ('cat:montserrat' gives 'montserrat'), or null when it is not one of the catalogue. */
export function catalogId(font: unknown): string | null {
  if (typeof font !== 'string' || !font.startsWith(CATALOG_PREFIX)) return null
  const id = font.slice(CATALOG_PREFIX.length)
  return BY_ID.has(id) ? id : null
}

/** The FontFace family a catalogue font is registered under (§6.5): a system font of that name never takes its place. */
export const catalogFamily = (id: string): string => `FlownCat-${id}`

/** The commit-pinned raw URL of `path` in the font's repository ('[' and ']' written %5B and %5D). */
function upstreamUrl(font: CatalogFont, path: string): string {
  const commit = font.repo === 'google/fonts' ? GOOGLE_FONTS_COMMIT : NOTO_EMOJI_COMMIT
  const encoded = path.split('/').map((p) => encodeURIComponent(p)).join('/')
  return `https://raw.githubusercontent.com/${font.repo}/${commit}/${encoded}`
}

/**
 * Where `file` of `font` is downloaded from, in order (§12): the Qbexel mirror when it exists,
 * then the upstream repository at its pinned commit. Every source is checked against the same pin.
 */
export function fontSources(font: CatalogFont, file: CatalogFile = font.files[0]): string[] {
  const out: string[] = []
  if (CAPTION_MIRROR) out.push(`https://huggingface.co/${CAPTION_MIRROR.repository}/resolve/${CAPTION_MIRROR.commit}/${font.repo}/${file.path.split('/').map((p) => encodeURIComponent(p)).join('/')}`)
  out.push(upstreamUrl(font, file.path))
  return out
}
