/**
 * The music and sound-effects library (docs/design/editing-polish.md §10): twelve CC0 music beds in
 * five moods and sixteen CC0 sound effects. Ids never change; a changed file gets a new id.
 *
 * Every file is pinned twice. The upstream file (bytes and SHA-256, and for an effect taken from an
 * archive, the archive member too) is what scripts/build-sound-library.mjs downloads and checks
 * before preparing anything; the prepared file (bytes and SHA-256) is what the installer ships in
 * resources/sound-library/ or what a download is checked against. The prepared pins are written by
 * the build's first run into the PREPARED block below and never change afterwards (Opus output
 * differs between encoder builds, so a file is encoded once).
 *
 * Licences (§10.1): music only from artists whose own pages agree with CC0, with the evidence kept
 * in scripts/sound-library/evidence/ and its SHA-256 pinned in ARTISTS; effects only CC0.
 *
 * This module has no runtime imports, so scripts/build-sound-library.mjs can load it with Node's
 * type stripping.
 */
import type { Project, SfxRef } from '../types'

export type Mood = 'calm' | 'upbeat' | 'corporate' | 'lofi' | 'cinematic'

/** Moods in the order of the Library's filter chips, with their words in the UI. */
export const MOODS: readonly { id: Mood; label: string }[] = [
  { id: 'calm', label: 'Calm' },
  { id: 'upbeat', label: 'Upbeat' },
  { id: 'corporate', label: 'Corporate' },
  { id: 'lofi', label: 'Lo-fi' },
  { id: 'cinematic', label: 'Cinematic' }
]

/** A file fetched from upstream: what the build downloads and checks before using it. */
export interface Upstream {
  url: string
  bytes: number
  sha256: string
}

/** Samples per second of every prepared file. */
export const LIBRARY_RATE = 48000
/** Samples after a bed's loop end (0.25 s of the loop's continuation, never played: it absorbs the codec's end-of-stream noise). */
export const BED_PAD = 12000

/** A bed's prepared file (Ogg Opus 64 kb/s stereo, 48 kHz): E = loopEnd, so one pass is E / 48000 s. */
export interface BedPrepared {
  file: string
  bytes: number
  sha256: string
  /** Samples in the file: loopEnd + pad. */
  samples: number
  /** The loop repeats from loopStart to loopEnd (samples at 48 kHz). */
  loopStart: number
  loopEnd: number
  pad: number
}

/** An effect's prepared file (Ogg Opus 48 kb/s mono, 48 kHz). */
export interface EffectPrepared {
  file: string
  bytes: number
  sha256: string
  /** Its length and the time of its loudest moment (used to line it up with the picture), seconds. */
  seconds: number
  peakAt: number
}

export interface MusicBedSource {
  id: string
  mood: Mood
  title: string
  artist: string
  album: string
  licence: 'CC0-1.0'
  /** The track's Free Music Archive page ("… is licensed under a CC0 1.0 Universal License"). */
  page: string
  upstream: Upstream
  /** The analysed loop in samples at 48 kHz of the decoded upstream file: the file is cut at `end` (E) and repeats from `start` (S). */
  loop: { start: number; end: number }
  /** In the installer (four beds: per mood, the smallest that passed the speech screen; none of Cinematic's did); else downloaded on request. */
  bundled: boolean
  /** Its preparation adds a gentle true-peak limiter (it reached only −18.4 LUFS under the peak cap). */
  limiter?: boolean
}

export interface MusicBed extends MusicBedSource {
  prepared: BedPrepared
}

export type SfxGroup = 'whoosh' | 'pop' | 'click' | 'chime'
/** What an effect is offered for first (§10.1 "Offered for"). */
export type SfxUse = 'zoom-in' | 'zoom-out' | 'titles' | 'slides' | 'callouts' | 'badges' | 'bubbles' | 'pop-ups'

export interface SoundEffectSource {
  id: string
  /** Its name in the UI. */
  title: string
  group: SfxGroup
  /** Author, pack and file, as the pack names them. */
  source: string
  page: string
  licence: 'CC0-1.0'
  /** The upstream file (a key of SFX_UPSTREAM): an archive, or the sound itself. */
  upstream: string
  /** The member taken from an archive, pinned; null when the upstream file is the sound itself. */
  member: {
    archive: string
    path: string
    bytes: number
    sha256: string
  } | null
  uses: readonly SfxUse[]
}

export interface SoundEffect extends SoundEffectSource {
  prepared: EffectPrepared
}

/** The upstream files of the effects, all from https://opengameart.org/sites/default/files/. */
export const SFX_UPSTREAM: Readonly<Record<string, Upstream & { page: string; terms: string }>> = {
  'kenney_interfaceSounds.zip': {
    url: 'https://opengameart.org/sites/default/files/kenney_interfaceSounds.zip',
    bytes: 834536,
    sha256: 'f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232',
    page: 'https://opengameart.org/content/interface-sounds',
    terms: 'CC0; kenney.nl/assets/interface-sounds: "public domain licensed (CC0)… Attribution is not required"; the zip\'s License.txt says CC0'
  },
  'swoshes.7z': {
    url: 'https://opengameart.org/sites/default/files/swoshes.7z',
    bytes: 4858146,
    sha256: '2d55b26f918a4d8042e2c97a4db81392757195f5aaac9039f5ec2c557b6f11f2',
    page: 'https://opengameart.org/content/swish-bamboo-stick-weapon-swhoshes',
    terms: 'CC0, attribution "[optional]"'
  },
  'dingclicks.7z': {
    url: 'https://opengameart.org/sites/default/files/dingclicks.7z',
    bytes: 43474,
    sha256: 'd73c088f6c2950db351c894ec74a6a0c9d02a497d8747e5409f8f3af64fc7a6c',
    page: 'https://opengameart.org/content/6-user-interface-ding-clicks',
    terms: 'CC0; info.txt "Public Domain Dedication or CC0"'
  },
  'swishes.zip': {
    url: 'https://opengameart.org/sites/default/files/swishes.zip',
    bytes: 385150,
    sha256: '7980215241b739a787dcf26f660ce510bb237900968789395a86911619795693',
    page: 'https://opengameart.org/content/swishes-sound-pack',
    terms: 'CC0'
  },
  'pop1.ogg': {
    url: 'https://opengameart.org/sites/default/files/pop1.ogg',
    bytes: 6607,
    sha256: 'a00ec6f278e2237d1b95dd0a53dfd2398ea44a7497794b38ab4b28602573d763',
    page: 'https://opengameart.org/content/pop-sounds',
    terms: 'CC0'
  },
  'pop3.ogg': {
    url: 'https://opengameart.org/sites/default/files/pop3.ogg',
    bytes: 5638,
    sha256: '3b9a801da20f92d720ff2c0076914228086107ec6792411494bf25ee6f8eb3ed',
    page: 'https://opengameart.org/content/pop-sounds',
    terms: 'CC0'
  },
  '3pops.zip': {
    url: 'https://opengameart.org/sites/default/files/3pops.zip',
    bytes: 90641,
    sha256: 'b54c299913b6502e5d07ba62bcc6726f13498ee848d49f25fc4390e0b6103a82',
    page: 'https://opengameart.org/content/3-pop-sounds',
    terms: 'CC0, "No Attribution Required"'
  },
  'bell_ding2.wav': {
    url: 'https://opengameart.org/sites/default/files/bell_ding2.wav',
    bytes: 254020,
    sha256: 'e4a764a1e0a6284f5a5ec80caf3d44c76d3ff8db17ddab8b42abb6b143e83529',
    page: 'https://opengameart.org/content/bell-dingschimes',
    terms: 'CC0, "Releasing as public domain"'
  }
}

const FMA_FILES = 'https://files.freemusicarchive.org/storage-freemusicarchive-org/'
const FMA_PAGES = 'https://freemusicarchive.org/music/'

/** The twelve beds (§10.1), by mood; the bundled one of each mood is the smallest that passed the speech screen. */
export const BED_SOURCES: readonly MusicBedSource[] = [
  {
    id: 'calm-spring-on-the-horizon',
    mood: 'calm',
    title: 'Spring On The Horizon',
    artist: 'HoliznaCC0',
    album: 'Background Music',
    licence: 'CC0-1.0',
    page: `${FMA_PAGES}holiznacc0/background-music/spring-on-the-horizon/`,
    upstream: {
      url: `${FMA_FILES}tracks/XaPEssVQ1Ks8r4GzowzzHsP5xfIi2FcDxVmEM3Bn.mp3`,
      bytes: 3673165,
      sha256: '3776c85ecae4f6052c4fe4645bef02f51de35ba7257380bca3e0707853d1aa6e'
    },
    loop: { start: 1174744, end: 3558192 },
    bundled: true
  },
  {
    id: 'calm-drifting-piano',
    mood: 'calm',
    title: 'Drifting Piano',
    artist: 'HoliznaCC0',
    album: 'Background Music',
    licence: 'CC0-1.0',
    page: `${FMA_PAGES}holiznacc0/background-music/drifting-piano/`,
    upstream: {
      url: `${FMA_FILES}tracks/uGFgbWaUKc0LLRnbLShVKZ7yhiK5nsxczsKgpcvW.mp3`,
      bytes: 4420963,
      sha256: '5d1d80af901c244bcedb618b5350b83874167258ba4fa17da83a2a005a26f95e'
    },
    loop: { start: 1237159, end: 3989960 },
    bundled: false
  },
  {
    id: 'calm-old-key',
    mood: 'calm',
    title: 'Old Key',
    artist: 'Loyalty Freak Music',
    album: 'MINIMAL AMBIENT BOUNCE',
    licence: 'CC0-1.0',
    page: `${FMA_PAGES}Loyalty_Freak_Music/MINIMAL_AMBIENT_BOUNCE/Loyalty_Freak_Music_-_MINIMAL_AMBIENT_BOUNCE_-_03_Old_Key/`,
    upstream: {
      url: `${FMA_FILES}music/Music_for_Video/Loyalty_Freak_Music/MINIMAL_AMBIENT_BOUNCE/Loyalty_Freak_Music_-_03_-_Old_Key.mp3`,
      bytes: 6393217,
      sha256: '5b11999f705881ce23ea39577c4af38aa404b1f38cf89cdd47eb6e4a2109406b'
    },
    loop: { start: 833689, end: 3906068 },
    bundled: false,
    limiter: true
  },
  {
    id: 'upbeat-sweet-sun',
    mood: 'upbeat',
    title: 'Sweet Sun',
    artist: 'Loyalty Freak Music',
    album: 'POSITIVE ATTITUDE !',
    licence: 'CC0-1.0',
    page: `${FMA_PAGES}Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_POSITIVE_ATTITUDE__-_04_Sweet_Sun/`,
    upstream: {
      url: `${FMA_FILES}music/no_curator/Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_04_-_Sweet_Sun.mp3`,
      bytes: 4843926,
      sha256: '0e78c97159d005e5727fb8c406c1613047f17bfe74450d37e941dafbfe0975fa'
    },
    loop: { start: 1622796, end: 4962069 },
    bundled: true
  },
  {
    id: 'upbeat-go-to-the-picnic',
    mood: 'upbeat',
    title: 'Go to the Picnic',
    artist: 'Loyalty Freak Music',
    album: 'POSITIVE ATTITUDE !',
    licence: 'CC0-1.0',
    page: `${FMA_PAGES}Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_POSITIVE_ATTITUDE__-_01_Go_to_the_Picnic/`,
    upstream: {
      url: `${FMA_FILES}music/no_curator/Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_01_-_Go_to_the_Picnic.mp3`,
      bytes: 7544987,
      sha256: 'dbeaad7bb137f39f5d3e7ee5c83b2ac53f4963cc92f3d3fe6321c490e1760cf1'
    },
    loop: { start: 615236, end: 6044344 },
    bundled: false
  },
  {
    id: 'corporate-one-cool-minute',
    mood: 'corporate',
    title: 'One Cool Minute',
    artist: 'Loyalty Freak Music',
    album: 'MINIMAL AMBIENT BOUNCE',
    licence: 'CC0-1.0',
    page: `${FMA_PAGES}Loyalty_Freak_Music/MINIMAL_AMBIENT_BOUNCE/Loyalty_Freak_Music_-_MINIMAL_AMBIENT_BOUNCE_-_02_One_Cool_Minute/`,
    upstream: {
      url: `${FMA_FILES}music/Music_for_Video/Loyalty_Freak_Music/MINIMAL_AMBIENT_BOUNCE/Loyalty_Freak_Music_-_02_-_One_Cool_Minute.mp3`,
      bytes: 7799650,
      sha256: '8778d1e095ab7c6793d10ce9bbe1d9783c9ec6d558f11302ced2202b2c039a0c'
    },
    loop: { start: 285327, end: 3165403 },
    bundled: true
  },
  {
    id: 'corporate-work',
    mood: 'corporate',
    title: 'Work',
    artist: 'Loyalty Freak Music',
    album: 'MELODIES WITH A BEAT',
    licence: 'CC0-1.0',
    page: `${FMA_PAGES}Loyalty_Freak_Music/MELODIES_WITH_A_BEAT/Loyalty_Freak_Music_-_MELODIES_WITH_A_BEAT_-_13_Work/`,
    upstream: {
      url: `${FMA_FILES}music/Music_for_Video/Loyalty_Freak_Music/MELODIES_WITH_A_BEAT/Loyalty_Freak_Music_-_13_-_Work.mp3`,
      bytes: 5862743,
      sha256: 'b54cd1808040093efb07b59a81f706fe8f8b0f10dce99b67d7aa9ba95287c7bd'
    },
    loop: { start: 3122991, end: 6194991 },
    bundled: false
  },
  {
    id: 'lofi-coexistenz',
    mood: 'lofi',
    title: 'Coexistenz',
    artist: 'Loyalty Freak Music',
    album: 'TO CHILL AND STAY AWAKE',
    licence: 'CC0-1.0',
    page: `${FMA_PAGES}Loyalty_Freak_Music/TO_CHILL_AND_STAY_AWAKE/Loyalty_Freak_Music_-_TO_CHILL_AND_STAY_AWAKE_-_01_Coexistenz/`,
    upstream: {
      url: `${FMA_FILES}music/Music_for_Video/Loyalty_Freak_Music/TO_CHILL_AND_STAY_AWAKE/Loyalty_Freak_Music_-_01_-_Coexistenz.mp3`,
      bytes: 6307619,
      sha256: 'a30737e60dd04961b645312d9a33683b8cc7b2d591ed22892ef552dd1750c9f0'
    },
    loop: { start: 1660691, end: 4413491 },
    bundled: true
  },
  {
    id: 'lofi-find-your-peace',
    mood: 'lofi',
    title: 'Find Your Peace',
    artist: 'HoliznaCC0',
    album: 'Be Happy With Who You Are',
    licence: 'CC0-1.0',
    page: `${FMA_PAGES}holiznacc0/be-happy-with-who-you-are/find-your-peace/`,
    upstream: {
      url: `${FMA_FILES}tracks/XfRQmzUkddJ0aYUKbbbssERfuqtZ4kFD4f7tDbpm.mp3`,
      bytes: 5574925,
      sha256: 'd204810823d2910111e8eb9a5dce7fd4c659701cc3b9c350ff44a0f9c9a58e99'
    },
    loop: { start: 1486820, end: 4955208 },
    bundled: false
  },
  {
    id: 'lofi-walking-away',
    mood: 'lofi',
    title: 'Walking Away',
    artist: 'HoliznaCC0',
    album: 'Public Domain Lofi',
    licence: 'CC0-1.0',
    page: `${FMA_PAGES}holiznacc0/public-domain-lofi/walking-away-lofi-peaceful-motivating/`,
    upstream: {
      url: `${FMA_FILES}tracks/WOtcP3GhbgTD8CuC6sEgpQOEXMyNeXYbTNmHjgN6.mp3`,
      bytes: 6243043,
      sha256: 'fd8a618a4076b76f02f69414d6beb4ad7ddf3b8c26164085bd6dc1a9fd2f7610'
    },
    loop: { start: 3484108, end: 6864501 },
    bundled: false
  },
  {
    id: 'cinematic-lullabies-5',
    mood: 'cinematic',
    title: 'Lullabies For The End Of The World #5',
    artist: 'HoliznaCC0',
    album: 'Lullabies For The End Of The World',
    licence: 'CC0-1.0',
    page: `${FMA_PAGES}holiznacc0/lullabies-for-the-end-of-the-world/lullabies-for-the-end-of-the-world-5/`,
    upstream: {
      url: `${FMA_FILES}tracks/QQ7qGFBa7XvQ4zoITcak0W3PPq4CIDuJpXDtb8BB.mp3`,
      bytes: 5799523,
      sha256: 'd92076e65945f9703f99c45741cf09118c1a5d8bec54e1a1245f513f9f3134ed'
    },
    loop: { start: 2467631, end: 4661901 },
    bundled: false
  },
  {
    id: 'cinematic-dangerous-voyage',
    mood: 'cinematic',
    title: 'Dangerous Voyage',
    artist: 'HoliznaCC0',
    album: 'Background Music',
    licence: 'CC0-1.0',
    page: `${FMA_PAGES}holiznacc0/background-music/dangerous-voyage/`,
    upstream: {
      url: `${FMA_FILES}tracks/Tvb0DDm30Pc0zqEJB3UAJscCXysMFzWj5iZn81Um.mp3`,
      bytes: 7193485,
      sha256: '858da24c505574b60694f05ef70564555a18a05307cc7671c0efc642bf6036ff'
    },
    loop: { start: 425761, end: 5340961 },
    bundled: false
  }
]

const KENNEY = 'kenney_interfaceSounds.zip'
const kenney = (title: string, file: string, bytes: number, sha256: string): Pick<SoundEffectSource, 'source' | 'page' | 'upstream' | 'member'> => ({
  source: `Kenney, Interface Sounds, ${title}`,
  page: SFX_UPSTREAM[KENNEY].page,
  upstream: KENNEY,
  member: { archive: KENNEY, path: `Audio/${file}`, bytes, sha256 }
})

/** The sixteen effects (§10.1), all in the installer. */
export const EFFECT_SOURCES: readonly SoundEffectSource[] = [
  {
    id: 'whoosh-in',
    title: 'Whoosh',
    group: 'whoosh',
    source: 'qubodup, "Swish - bamboo stick weapon swhoshes", swosh-03',
    page: SFX_UPSTREAM['swoshes.7z'].page,
    licence: 'CC0-1.0',
    upstream: 'swoshes.7z',
    member: {
      archive: 'swoshes.7z',
      path: 'swosh-03.flac',
      bytes: 96738,
      sha256: '2111003e4c61b8f3589f926f549ffc36094319da7b99238624c7d64e91bddc09'
    },
    uses: ['zoom-in', 'titles']
  },
  {
    id: 'whoosh-out',
    title: 'Whoosh out',
    group: 'whoosh',
    source: 'qubodup, "Swish - bamboo stick weapon swhoshes", swosh-13',
    page: SFX_UPSTREAM['swoshes.7z'].page,
    licence: 'CC0-1.0',
    upstream: 'swoshes.7z',
    member: {
      archive: 'swoshes.7z',
      path: 'swosh-13.flac',
      bytes: 94634,
      sha256: 'a22c0da4eff26f4b6171721c830f291a0ad9fe5383f23d5f4530020e995dc4de'
    },
    uses: ['zoom-out']
  },
  {
    id: 'whoosh-soft',
    title: 'Soft whoosh',
    group: 'whoosh',
    source: 'qubodup, "Swish - bamboo stick weapon swhoshes", swosh-16',
    page: SFX_UPSTREAM['swoshes.7z'].page,
    licence: 'CC0-1.0',
    upstream: 'swoshes.7z',
    member: {
      archive: 'swoshes.7z',
      path: 'swosh-16.flac',
      bytes: 72696,
      sha256: '0e882f9cef2ca536fae1efa9fadcfc5f8f1fc6a1dafc55d8c2ee62a95cd71b16'
    },
    uses: ['zoom-in', 'zoom-out', 'titles', 'slides']
  },
  {
    id: 'swish-quick',
    title: 'Quick swish',
    group: 'whoosh',
    source: 'artisticdude, "Swishes Sound Pack", swish-9',
    page: SFX_UPSTREAM['swishes.zip'].page,
    licence: 'CC0-1.0',
    upstream: 'swishes.zip',
    member: {
      archive: 'swishes.zip',
      path: 'swishes/swish-9.wav',
      bytes: 52906,
      sha256: '123883f006ce55feecbff11eea5f87c4493df4399989983037144570a23723c1'
    },
    uses: ['callouts']
  },
  {
    id: 'pop',
    title: 'Pop',
    group: 'pop',
    source: 'cogitollc, "Pop sounds", pop1',
    page: SFX_UPSTREAM['pop1.ogg'].page,
    licence: 'CC0-1.0',
    upstream: 'pop1.ogg',
    member: null,
    uses: ['callouts', 'badges', 'pop-ups']
  },
  {
    id: 'pop-soft',
    title: 'Soft pop',
    group: 'pop',
    source: 'cogitollc, "Pop sounds", pop3',
    page: SFX_UPSTREAM['pop3.ogg'].page,
    licence: 'CC0-1.0',
    upstream: 'pop3.ogg',
    member: null,
    uses: ['callouts', 'pop-ups']
  },
  {
    id: 'pop-bubble',
    title: 'Bubble pop',
    group: 'pop',
    source: 'wubitog, "3 Pop Sounds", pop1',
    page: SFX_UPSTREAM['3pops.zip'].page,
    licence: 'CC0-1.0',
    upstream: '3pops.zip',
    member: {
      archive: '3pops.zip',
      path: '3pops/pop1.ogg',
      bytes: 11616,
      sha256: 'e8ef22564c704a6f6217e03885cba51ebd7761360e59fc8e247b2f4f97bc4e0e'
    },
    uses: ['bubbles', 'pop-ups']
  },
  {
    id: 'click',
    title: 'Click',
    group: 'click',
    licence: 'CC0-1.0',
    ...kenney('click_001', 'click_001.ogg', 4876, 'ccfb7fa0cccdd9faec0eb16033c732b1e308d139d80f799161495d58f7adcdb9'),
    uses: ['callouts']
  },
  {
    id: 'tick',
    title: 'Tick',
    group: 'click',
    licence: 'CC0-1.0',
    ...kenney('tick_002', 'tick_002.ogg', 4514, '869442f54214be902ec7437f79e400dc91c1bfd90d18a6dd2d5b7e41ffbf457b'),
    uses: ['badges']
  },
  {
    id: 'bell',
    title: 'Bell',
    group: 'chime',
    source: 'PWL, "Bell dings/chimes", bell_ding2',
    page: SFX_UPSTREAM['bell_ding2.wav'].page,
    licence: 'CC0-1.0',
    upstream: 'bell_ding2.wav',
    member: null,
    uses: ['titles']
  },
  {
    id: 'chime',
    title: 'Chime',
    group: 'chime',
    licence: 'CC0-1.0',
    ...kenney('confirmation_001', 'confirmation_001.ogg', 8968, '063564703b6094d70718a3e787a55cc9141611e4ecd6b6637f8828f79b4a8c3a'),
    uses: ['titles', 'callouts']
  },
  {
    id: 'success',
    title: 'Success',
    group: 'chime',
    source: 'qubodup, "6 user interface ding clicks", dingCling-positive',
    page: SFX_UPSTREAM['dingclicks.7z'].page,
    licence: 'CC0-1.0',
    upstream: 'dingclicks.7z',
    member: {
      archive: 'dingclicks.7z',
      path: 'dingClicks/dingCling-positive.ogg',
      bytes: 10666,
      sha256: '63387ecb70bbf54c79cab26b69a590776c0fd1663b5a562eae836121dafc1e14'
    },
    uses: ['callouts']
  },
  {
    id: 'rise',
    title: 'Rise',
    group: 'chime',
    licence: 'CC0-1.0',
    ...kenney('maximize_004', 'maximize_004.ogg', 17723, '59c7a24b204be24d2a44a86d1e4d18c2cf51fa0446967a14b2590e8fb3afaf34'),
    uses: ['callouts']
  },
  {
    id: 'fall',
    title: 'Fall',
    group: 'chime',
    licence: 'CC0-1.0',
    ...kenney('minimize_004', 'minimize_004.ogg', 17099, 'fcfe6fbb03a728e90b907f34d2ec7bf3ea1857397c3e47ee01990c1be059e4f6'),
    uses: ['callouts']
  },
  {
    id: 'bubble-in',
    title: 'Bubble',
    group: 'pop',
    licence: 'CC0-1.0',
    ...kenney('question_001', 'question_001.ogg', 11700, 'abb8f9e4eb2071491b0b15f84ee302386b1847609310c1b000ae174639a6cc5a'),
    uses: ['bubbles']
  },
  {
    id: 'drop',
    title: 'Drop',
    group: 'click',
    licence: 'CC0-1.0',
    ...kenney('drop_002', 'drop_002.ogg', 6411, '4ac4d1cef7e936965cbf795852ca2020300b9e2ba7daa59f2bf4f1f7bf416218'),
    uses: ['badges']
  }
]

/**
 * What an artist's own page says about the licence (§10.1 rule 3): the page, the day it was
 * fetched, the sentence, and the saved page text (scripts/sound-library/evidence/<file>, pinned by
 * its SHA-256). Test 6 checks every bed's artist has it.
 */
export interface ArtistEvidence {
  name: string
  url: string
  fetched: string
  quote: string
  /** File name in scripts/sound-library/evidence/. */
  evidence: string
  sha256: string
}

export const ARTISTS: readonly ArtistEvidence[] = [
  {
    name: 'HoliznaCC0',
    url: 'https://freemusicarchive.org/music/holiznacc0/',
    fetched: '2026-11-06',
    quote: 'which is giving out truly unique and creative music for free as public domain',
    evidence: 'holiznacc0.txt',
    sha256: '895a58e133235e9bac6b7a5467a7acc8a21fc850a00acbc760fcd275dbaeb2ca'
  },
  {
    name: 'Loyalty Freak Music',
    url: 'https://loyaltyfreakmusic.com/faq/',
    fetched: '2026-11-06',
    quote: '98 % of my work is under Creative Commons 0, so you can remix, use it in a commercial way and don’t even need to credit me to use it.',
    evidence: 'loyalty-freak-music.txt',
    sha256: '707d011a5cf3ebcd6fafac83eec81566b3cce9adab36944451733b7dc14bfdd6'
  }
]

/**
 * Artists whose music is never used (§3.2 row 22): John Bartmann's own FAQ (johnbartmann.com/faq,
 * 2026-11-06) says "Creative Commons CC-BY 4.0 or public domain. Do credit me", that uncredited
 * videos "will get flagged by We Are Era Music", and "Can I resell your music? No".
 */
export const REJECTED_ARTISTS: readonly string[] = ['John Bartmann']

/** The evidence of each rejection, kept like ARTISTS'. */
export const REJECTED_EVIDENCE: readonly ArtistEvidence[] = [
  {
    name: 'John Bartmann',
    url: 'https://www.johnbartmann.com/faq',
    fetched: '2026-11-06',
    quote: 'Creative Commons CC-BY 4.0 or public domain. Do credit me',
    evidence: 'john-bartmann.txt',
    sha256: '5a79f91b8ee8203823e7cefef8c1aa75440924230f85d13e92cd28a4fd22bd95'
  }
]

/** Where the downloadable beds come from: a release of the app's sound library (§0 decision 1, §10.3). */
export interface SoundLibrarySource {
  /** Every first request is under this exact prefix (https, port 443, no query or fragment). */
  prefix: string
  /** Hosts a redirect may go to (the release's signed CDN), https on port 443, any query. */
  cdnHosts: readonly string[]
}

/**
 * The source the owner chose (§0 decision 1 (a)): a release with the tag sound-library-1, never
 * reused, in a repository of its own with immutable releases on, so the app's update feed is never
 * touched. The repository does not exist yet.
 */
export const SOUND_LIBRARY_RELEASE: SoundLibrarySource & {
  repository: string
  tag: string
} = {
  repository: 'samiulakhan12/flown-sound-library',
  tag: 'sound-library-1',
  prefix: 'https://github.com/samiulakhan12/flown-sound-library/releases/download/sound-library-1/',
  cdnHosts: ['release-assets.githubusercontent.com', 'objects.githubusercontent.com']
}

/**
 * The source downloads use: null until the release exists and one real asset passed the release
 * check of docs/RELEASING.md (§10.3). While it is null the download rows are not shown and the four
 * bundled beds work alone.
 */
export const SOUND_LIBRARY_SOURCE: SoundLibrarySource | null = null

/*
 * The prepared files' pins, by id, written by the first run of scripts/build-sound-library.mjs and
 * never changed afterwards (§10.2 "Pinned once"). Beds: file, bytes, sha256, samples, loopStart,
 * loopEnd, pad; effects: file, bytes, sha256, seconds, peakAt. The block is JSON so the script can
 * add an id without touching the rest of the file.
 */
// prettier-ignore
const PREPARED: Readonly<Record<string, BedPrepared | EffectPrepared>> = /* prepared:begin */ {
  "bell": {"file":"sfx-bell.ogg","bytes":8079,"sha256":"d5ff17af12ccfb5b2f430f5a901cb9f97c3290d1cb468a7820025003ef0ac92a","seconds":1.352,"peakAt":0.03},
  "bubble-in": {"file":"sfx-bubble-in.ogg","bytes":3279,"sha256":"0344d7ae95ca0933fa82016c7765676a023e9904daca805155c8db51f6a8c9ee","seconds":0.487,"peakAt":0.166},
  "calm-drifting-piano": {"file":"bed-calm-drifting-piano.ogg","bytes":678125,"sha256":"5150ecbc1a55cce6f9124c2f8c2a3b9a3bebd91a35a3f16195ad18dc2668e962","samples":4001960,"loopStart":1237159,"loopEnd":3989960,"pad":12000},
  "calm-old-key": {"file":"bed-calm-old-key.ogg","bytes":663765,"sha256":"4bc4d1856008300296201df97108875e0783cac98eff8dbc1b499111b3c2a938","samples":3918068,"loopStart":833689,"loopEnd":3906068,"pad":12000},
  "calm-spring-on-the-horizon": {"file":"bed-calm-spring-on-the-horizon.ogg","bytes":604864,"sha256":"92bc8ad1815b32a077a4bb46de28ed1a9028b79ebef920ccb2a232dba81aebba","samples":3570192,"loopStart":1174744,"loopEnd":3558192,"pad":12000},
  "chime": {"file":"sfx-chime.ogg","bytes":2760,"sha256":"63b071e3416ab3b468f60c99c694204ccfbd6407a82cd1a0d155021bcee7cf45","seconds":0.29,"peakAt":0.006},
  "cinematic-dangerous-voyage": {"file":"bed-cinematic-dangerous-voyage.ogg","bytes":906703,"sha256":"a51813d01700ecfd30cfc6bfa59a15d1b32ead4777a402ee9149dbc4591af39b","samples":5352961,"loopStart":425761,"loopEnd":5340961,"pad":12000},
  "cinematic-lullabies-5": {"file":"bed-cinematic-lullabies-5.ogg","bytes":791655,"sha256":"1e043912806930f3bb8199bb56f189370e9029f2e87a44379215e1746e365de4","samples":4673901,"loopStart":2467631,"loopEnd":4661901,"pad":12000},
  "click": {"file":"sfx-click.ogg","bytes":677,"sha256":"35e9534ae74230cf8429b247a71d076b569b4fa534de5194040b53b761345034","seconds":0.097,"peakAt":0.006},
  "corporate-one-cool-minute": {"file":"bed-corporate-one-cool-minute.ogg","bytes":538449,"sha256":"e17cf5beef335ab85fb267078d73545d3ed7d58d458ccdaafa905f3e8035cec9","samples":3177403,"loopStart":285327,"loopEnd":3165403,"pad":12000},
  "corporate-work": {"file":"bed-corporate-work.ogg","bytes":1051173,"sha256":"a1ace35b290ca9e5146d3788e899525a6785599fdfa819b5a79931c792784cb0","samples":6206991,"loopStart":3122991,"loopEnd":6194991,"pad":12000},
  "drop": {"file":"sfx-drop.ogg","bytes":1864,"sha256":"f8ee6eaaa4db24f2e4c9b0d0e4aa2911d053b79d7f402c13283e99e0e03a8450","seconds":0.188,"peakAt":0.006},
  "fall": {"file":"sfx-fall.ogg","bytes":2938,"sha256":"c3f95cdb4742b9ed66d940adc41159a1d9aad606ca79da7f5f72346d24e1e579","seconds":0.401,"peakAt":0.048},
  "lofi-coexistenz": {"file":"bed-lofi-coexistenz.ogg","bytes":749669,"sha256":"82dbfd329915e916efea0bb411f957c3fbc900d8e8475df7bd597208f083ab6a","samples":4425491,"loopStart":1660691,"loopEnd":4413491,"pad":12000},
  "lofi-find-your-peace": {"file":"bed-lofi-find-your-peace.ogg","bytes":841483,"sha256":"e0d7850414988b1a3c57b143197a72867ed905c2aa267c4984bcefcfc212b359","samples":4967208,"loopStart":1486820,"loopEnd":4955208,"pad":12000},
  "lofi-walking-away": {"file":"bed-lofi-walking-away.ogg","bytes":1164869,"sha256":"a5dc3ce6edce13b0a9d83147860af91046112cbd368a745952c744fd45e7d0a4","samples":6876501,"loopStart":3484108,"loopEnd":6864501,"pad":12000},
  "pop": {"file":"sfx-pop.ogg","bytes":1529,"sha256":"ee9a0cf65eadaec808893b0298300d81c361fc93719574a4a211822512501989","seconds":0.207,"peakAt":0.036},
  "pop-bubble": {"file":"sfx-pop-bubble.ogg","bytes":1674,"sha256":"35d1d3a5cd0cbe77f944046a08d7dcd714d95c5f13779f812246175e5f5b9e2a","seconds":0.236,"peakAt":0.01},
  "pop-soft": {"file":"sfx-pop-soft.ogg","bytes":1029,"sha256":"87ac42d5cec619a1c64aae190ff1a661758d7cba599f1fb6ec7709fa191b369d","seconds":0.125,"peakAt":0.045},
  "rise": {"file":"sfx-rise.ogg","bytes":3351,"sha256":"10e6dfcdbcfa43bc7768abd8f8641df99c8fbe14001cd305b16337a3585f5bd2","seconds":0.402,"peakAt":0.354},
  "success": {"file":"sfx-success.ogg","bytes":3149,"sha256":"bca70e74bbb0c4cef50d7245561dadfff4b92d3879eda045b96b2dc25503937f","seconds":0.294,"peakAt":0.103},
  "swish-quick": {"file":"sfx-swish-quick.ogg","bytes":1225,"sha256":"e7db3980af2cc7ae0bb825308d2e6b24cfa6688deb270743ec51ed6bc926bad8","seconds":0.154,"peakAt":0.059},
  "tick": {"file":"sfx-tick.ogg","bytes":419,"sha256":"8cd79049b0d67b6e2618437187167d7df8066f5f0394749a3be524c35db756d1","seconds":0.02,"peakAt":0.005},
  "upbeat-go-to-the-picnic": {"file":"bed-upbeat-go-to-the-picnic.ogg","bytes":1025969,"sha256":"68983dbc9fb83848832a065411ebb381f32bffd4deeaae9edff54cb311b318dc","samples":6056344,"loopStart":615236,"loopEnd":6044344,"pad":12000},
  "upbeat-sweet-sun": {"file":"bed-upbeat-sweet-sun.ogg","bytes":842458,"sha256":"ca09ecdc3fe485ec5661ac9ab3c370803c40d65ec55b7ef75e586ed585701c2b","samples":4974069,"loopStart":1622796,"loopEnd":4962069,"pad":12000},
  "whoosh-in": {"file":"sfx-whoosh-in.ogg","bytes":3458,"sha256":"bde6d61de9201969f3561c616429ed7aa057e6c8613e75097b45c39d64f972d3","seconds":0.576,"peakAt":0.075},
  "whoosh-out": {"file":"sfx-whoosh-out.ogg","bytes":3097,"sha256":"c3da0bb1903022d67b3b30576bf37642d88f56349d524b3e9f9015807a53f2e5","seconds":0.508,"peakAt":0.116},
  "whoosh-soft": {"file":"sfx-whoosh-soft.ogg","bytes":2660,"sha256":"aabe29faa2d7b97bba18ef996cc6277c21bbab1caa6a9e59adc7cfc4b6115b37","seconds":0.437,"peakAt":0.073}
} /* prepared:end */

const isBedPrepared = (p: BedPrepared | EffectPrepared | undefined): p is BedPrepared => !!p && 'loopEnd' in p
const isEffectPrepared = (p: BedPrepared | EffectPrepared | undefined): p is EffectPrepared => !!p && 'peakAt' in p

/** The beds whose files are prepared and pinned, in catalogue order. */
export const MUSIC_BEDS: readonly MusicBed[] = BED_SOURCES.flatMap((b) => {
  const prepared = PREPARED[b.id]
  return isBedPrepared(prepared) ? [{ ...b, prepared }] : []
})

/** The effects whose files are prepared and pinned, in catalogue order. */
export const SOUND_EFFECTS: readonly SoundEffect[] = EFFECT_SOURCES.flatMap((e) => {
  const prepared = PREPARED[e.id]
  return isEffectPrepared(prepared) ? [{ ...e, prepared }] : []
})

/** The prepared pins as stored (scripts/build-sound-library.mjs and test 6). */
export const PREPARED_PINS: Readonly<Record<string, BedPrepared | EffectPrepared>> = PREPARED

export function soundBed(id: string): MusicBed | null {
  return MUSIC_BEDS.find((b) => b.id === id) ?? null
}

export function soundEffect(id: string): SoundEffect | null {
  return SOUND_EFFECTS.find((e) => e.id === id) ?? null
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Exactly the library's file names (no path parts): what the `sounds` host of the media protocol serves. */
export function soundFileRe(): RegExp {
  const names = [...MUSIC_BEDS.map((b) => b.prepared.file), ...SOUND_EFFECTS.map((e) => e.prepared.file)]
  return new RegExp(`^(?:${names.map(escapeRe).join('|')})$`)
}

/** The name of a sound in the UI and in Review titles: 'Original pop', 'Original ding', or the effect's title ('Soft pop'). */
export function sfxTitle(ref: SfxRef | 'pop' | 'ding'): string {
  if (ref === 'pop') return 'Original pop'
  if (ref === 'ding') return 'Original ding'
  return soundEffect(ref.slice(4))?.title ?? 'Sound effect'
}

/* ---------- a bed's timing (§10.4) ---------- */

/** The loop of a bed's prepared file in samples at 48 kHz: it repeats from `start` (S) to `end` (E). */
export function bedLoop(bed: MusicBed): { start: number; end: number } {
  return { start: bed.prepared.loopStart, end: bed.prepared.loopEnd }
}

/** One pass of a bed, in seconds: E / 48000 (the pad after E is never played). */
export function bedSeconds(bed: MusicBed): number {
  return bed.prepared.loopEnd / LIBRARY_RATE
}

/**
 * Where in the bed's file output second `out` plays: `out` itself during the first pass; after E,
 * from S again (S / 48000 + (out − S / 48000) mod ((E − S) / 48000)) with Loop on, or E / 48000
 * (it has stopped) with Loop off. Continuous at E, since the file's end runs straight on at S.
 */
export function bedTime(bed: MusicBed, out: number, loop: boolean): number {
  const { start, end } = bedLoop(bed)
  const t = Number.isFinite(out) ? Math.max(0, out) : 0
  const e = end / LIBRARY_RATE
  if (t < e) return t
  if (!loop || end <= start) return e
  // In samples, so a long video lands on the loop where the export's aloop does.
  const body = end - start
  const past = t * LIBRARY_RATE - start
  return (start + (((past % body) + body) % body)) / LIBRARY_RATE
}

/** "Music: <title> by <artist> (CC0)" for a library bed in use (§10.10), else null. */
export function musicCredit(project: Project): string | null {
  const music = project.audio.music
  const id = music?.library?.id
  const bed = typeof id === 'string' ? soundBed(id) : null
  return bed ? `Music: ${bed.title} by ${bed.artist} (CC0)` : null
}
