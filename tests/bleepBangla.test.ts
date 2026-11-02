/**
 * Bangla bleeping (docs/design/captions-studio.md §11.7, Clean up › Bleeping): stems matched at a
 * word's start, compounds anywhere, everyday nouns in every generated form, and everyday words never.
 * The forms are generated here, apart from cleanup.ts, so a form the matcher misses fails a test.
 */
import { describe, expect, it } from 'vitest'
import { bleepKey, isSwearWord, tidyCaptions, type CleanupChoices } from '../src/shared/captions/cleanup'
import type { CaptionSegment, Project } from '../src/shared/types'

const OFF: CleanupChoices = { caps: false, punct: false, digits: 'off', bleep: 'off', bleepSound: 'tone', ai: false }
const MODES = [
  ['standard', 'bn'],
  ['strict', 'bn'],
  ['standard', 'bn-BD'],
  ['strict', 'bn-BD']
] as const

/* ---------- the forms, generated ---------- */

/** A noun's classifiers and plurals (each then takes a case ending), and the plurals that are a case already. */
const CLASSIFIERS = ['', 'টা', 'টি', 'ডা', 'গুলো', 'গুলা', 'গুলি', 'গো']
const PLURAL_CASES = ['রা', 'দের', 'দেরকে']
const CASES = ['', 'র', 'রে', 'কে', 'তে', 'য়']
const PARTICLES = ['', 'ও', 'ই']
/** Every form of a noun Bangla allows: classifier or plural, case ending, particle (খানকিরাও, হারামিগুলোরে, মাগিটারেও). */
function nounForms(noun: string): string[] {
  const consonant = /[ক-হ]$/u.test(noun)
  const out: string[] = []
  for (const c of CLASSIFIERS) {
    for (const k of CASES) {
      const base = noun + c
      if (k === 'য়' && !/[াো]$/u.test(base)) continue
      // After a consonant the bare noun takes ের and ে (বালের, বালে).
      out.push(base + (!c && consonant ? ({ র: 'ের', তে: 'ে' } as Record<string, string>)[k] ?? k : k))
    }
  }
  for (const p of PLURAL_CASES) out.push(noun + (consonant && p === 'রা' ? 'েরা' : p))
  return out.flatMap((f) => PARTICLES.map((p) => f + p))
}

/** A verb's endings after a consonant (চোদ, চুদ): every person of every tense, standard and Dhaka. */
const PERSONS = ['', 'ি', 'িস', 'স', 'ো', 'োস', 'েন', 'ে']
const VERB_ENDINGS = [
  // Present, negative, imperative, participle.
  ...['', 'ি', 'িস', 'ে', 'ো', 'েন', 'স', 'োস', 'িনা', 'িনি', 'েনা', 'োনা', 'সনা', 'িসনা', 'ুক', 'ুন', 'িয়ে', 'িয়া', 'েই'],
  // Continuous, past continuous.
  ...['ছ', 'ছি', 'ছিস', 'ছে', 'ছো', 'ছেন', 'ছস', 'ছোস', 'ছিল', 'ছিলো', 'ছিলাম', 'ছিলি', 'ছিলে', 'ছিলেন'],
  // Perfect, past perfect, the Dhaka perfect.
  ...['েছ', 'েছি', 'েছিস', 'েছে', 'েছো', 'েছেন', 'েছিল', 'েছিলো', 'েছিলাম', 'েছিলি', 'েছিলে', 'েছিলেন', 'সে', 'সি', 'সস'],
  // The causative perfect.
  ...['িয়েছ', 'িয়েছি', 'িয়েছিস', 'িয়েছে', 'িয়েছো', 'িয়েছেন', 'িয়েছিল', 'িয়েছিলো', 'িয়েছিলাম', 'িয়েছিলি', 'িয়েছিলে', 'িয়েছিলেন'],
  // Past, conditional, habitual, infinitive.
  ...['ল', 'লো', 'লাম', 'লি', 'লে', 'লেন', 'লা', 'লেও', 'ত', 'তো', 'তাম', 'তিস', 'তি', 'তে', 'তেন', 'তা', 'তেই'],
  // The Dhaka continuous in every person.
  ...['তেছ', 'তাছ'].flatMap((t) => PERSONS.map((p) => t + p)),
  // Future, the Dhaka future.
  ...['ব', 'বো', 'বি', 'বে', 'বেন', 'বা', 'মু', 'ুম'],
  // Nouns made from the verb.
  ...['ন', 'নের', 'না', 'নার', 'নি', 'ির', 'িরে', 'িরভাই', 'া', 'াচুদি']
]
/** After the causative's আ (চোদা, চুদা): standard and the Dhaka -ই- forms. */
const VOWEL_ENDINGS = [
  ...['', 'ই', 'স', 'য়', 'ও', 'ন', 'ক', 'ইনি', 'সনা', 'নো', 'নোর', 'নি', 'র', 'রে'],
  ...['চ্ছ', 'চ্ছি', 'চ্ছিস', 'চ্ছে', 'চ্ছো', 'চ্ছেন', 'চ্ছিল', 'চ্ছিলো', 'চ্ছিলাম', 'চ্ছিলি', 'চ্ছিলে', 'চ্ছিলেন'],
  ...['ল', 'লো', 'লাম', 'লি', 'লে', 'লেন', 'লা', 'ত', 'তো', 'তাম', 'তিস', 'তে', 'তেন', 'ব', 'বো', 'বি', 'বে', 'বেন', 'বা'],
  ...['ইছ', 'ইছি', 'ইছিস', 'ইছে', 'ইছস', 'ইছো', 'ইছেন', 'ইস', 'ইত', 'ইতো', 'ইতে', 'ইতাম', 'ইল', 'ইলো', 'ইলাম', 'ইলি', 'ইলা', 'ইলেন'],
  ...['ইয়া', 'ইয়ে', 'ইবি', 'ইবো', 'ইবা', 'ইবে', 'ইমু'],
  ...['ইতেছ', 'ইতাছ'].flatMap((t) => PERSONS.map((p) => t + p))
]
/** The Dhaka participle, with ই after the vowel as in কইরা and মাইরা (তোরে চুইদা দিমু), its দ doubled or with য-ফলা, and a particle. */
const DHAKA_PARTICIPLES = ['চুইদ', 'চুইদ্দ', 'চুইদ্য'].flatMap((s) => ['া', 'াও', 'াই'].map((e) => s + e))
/** খানকি written with ং, a conjunct or a hasanta (খাংকির পোলা, খাঙ্কি, খান্কি). */
const KHANKI = ['খানকি', 'খাংকি', 'খাঙ্কি', 'খান্কি']
/** Words offensive in every form: verb stems, and the nouns (with their ী spellings and words made from them). */
const VERB_STEMS = ['চোদ', 'চুদ']
const CAUSATIVES = ['চোদা', 'চুদা']
const STEM_NOUNS = [...KHANKI, 'খানকী', 'মাগি', 'মাগী', 'হারামি', 'হারামী', 'হারামজাদা', 'হারামজাদি', 'হারামজাদী', 'চোদনা', 'চুদনা', 'চোদন', 'চুদন', 'চোদাচুদি', 'চুদাচুদি']
STEM_NOUNS.push('খানকিপনা', 'খানকীপনা', 'মাগিবাজ', 'মাগীবাজ', 'হারামিপনা', 'হারামীপনা')
// বাল's compounds, Bangladesh slang for a know-it-all child (বালপাকনা পোলাপান).
STEM_NOUNS.push('বালপাকনা', 'বালপাকা', 'বালপাকনামি')
/**
 * Compounds written as one word, also after another word written together with them: চোদ, চুদ,
 * চোত and চোৎ after each first part (বানচোদ, বাইনচোদ and বাইঞ্চোদ in Bangladesh, বানচোত and
 * বাঞ্চোৎ in West Bengal, মাদারচোদ), চুদমারানি written with দ, ত, ৎ or ত্, খানকিরপোলা as খানকি is written.
 */
const CHOD = ['চোদ', 'চুদ', 'চোত', 'চোৎ']
const COMPOUNDS = [
  ...['বোকা', 'বান', 'বাইন', 'বাইঞ্', 'বাঞ্', 'বেন', 'মাদার'].flatMap((w) => CHOD.map((c) => w + c)),
  ...['বোকাচোদা', 'বোকাচুদা'],
  ...['চুদ', 'চুত', 'চুৎ', 'চুত্'].map((c) => c + 'মারানি'),
  ...KHANKI.map((k) => k + 'রপোলা')
]
const COMPOUND_FORMS = [...COMPOUNDS.flatMap(nounForms), ...COMPOUNDS.map((c) => 'শালা' + c), 'চুত্\u200Dমারানি', 'চুত্\u200Dমারানির']
/** Nouns that begin everyday words too (বালক, বালিশ): matched whole, in every form. */
const WHOLE_NOUNS = ['বাল', 'বালছাল']
/**
 * শুয়োরের, "pig's", as it is spelled (শুওরের in West Bengal, শুয়ারের in Bangladesh), with ও or ই:
 * rude only before বাচ্চা (শুয়োরের বাচ্চা), never in শুয়োরের মাংস (pork) or শুয়োরের খামার (a pig farm).
 * Written together with বাচ্চা, it is rude anywhere.
 */
const PIG = ['শুয়োরের', 'শুওরের', 'শুয়রের', 'শুয়ারের']
const PIG_GENITIVES = PIG.flatMap((w) => PARTICLES.map((p) => w + p))
const KIDS = ['বাচ্চা', 'বাচ্ছা'].flatMap(nounForms)
const PIG_JOINED = [...PIG.flatMap((w) => KIDS.map((k) => w + k)), ...PIG.map((w) => 'শালা' + w + 'বাচ্চা')]
/** বাল in names and set phrases, never rude before these: বাল গঙ্গাধর তিলক, বাল ঠাকরে, লাল বাল পাল, বাল গোপাল, বাল বাচ্চা (the kids), বাল বিধবা. */
const BAL_NAMES = ['গঙ্গাধর', 'ঠাকরে', 'গোপাল', 'কৃষ্ণ', 'পাল', 'বাচ্চা', 'বাচ্ছা', 'বিধবা', 'বিবাহ'].flatMap(nounForms)

/** The latest review's list (input.json "bleep"), in full: its regressions, misses and Tidy captions scenario. */
const REVIEW_NOUN_ENDS = ['রাও', 'রাই', 'কেও', 'কেই', 'টাও', 'টাই', 'রেও']
const REVIEW = [
  ...['খানকি', 'মাগি', 'হারামি', 'হারামজাদা'].flatMap((n) => REVIEW_NOUN_ENDS.map((e) => n + e)),
  ...['চোদাইলি', 'চোদাইলা', 'চোদাইবো'],
  ...['চুদতেছস', 'চুদতেছেন', 'চুদতাছো', 'চুদতাছেন', 'চোদতেছস'],
  ...['চুদিয়েছ', 'চুদিয়েছো', 'চুদিয়েছেন', 'চুদিয়েছিল', 'চুদিয়েছিলাম'],
  ...['চুদাইতেছে', 'চুদাইতেছি', 'চোদাইতেছিস', 'চুদাইছিস', 'চুদাইলি', 'চুদাইতাম'],
  ...['চুদুক', 'চুদাচুদি', 'চুদনা', 'চুদন', 'মাগীবাজ', 'খানকীপনা', 'হারামীপনা'],
  ...['খানকিটারে', 'মাগিটারে', 'হারামজাদাটারে', 'মাগিগুলারে', 'খানকিগুলার', 'হারামিগুলোরে', 'মাগিদেরকে', 'হারামজাদাদেরকে'],
  // Its probe's nouns and endings, and its verbs.
  ...['খানকি', 'মাগি', 'হারামি', 'হারামজাদা', 'চোদনা'].flatMap((n) =>
    ['রাও', 'রাই', 'কেও', 'কেই', 'টাও', 'টাই', 'রেও', 'টারে', 'টারেও', 'দেরকে', 'দেরও', 'গুলার', 'গুলারে', 'গুলোরে', 'গুলাও', 'গুলোও', 'দেরই'].map((e) => n + e)
  ),
  ...['চোদাইতেছে', 'চোদাইছিস', 'চোদাইতাম', 'চুদাইলি', 'খানকিরাও', 'মাগিটারে', 'চুদতেছস', 'চুদাচুদি', 'চুদনা', 'চুদিয়েছিল', 'চোদাইলি', 'চুদাইতেছে']
]
const REVIEW_LINES = ['কি চুদতেছস তুই', 'ওই হারামজাদাটারে ধর', 'সব খানকিরাও আসছে', 'চুদাচুদি বন্ধ কর', 'কে চোদাইলি এটা', 'ওরা চুদিয়েছিল আমাকে', 'মাগিটাও চলে গেল', 'তুই একটা চুদনা']

const RUDE = [
  ...new Set([
    ...VERB_STEMS.flatMap((s) => VERB_ENDINGS.map((e) => s + e)),
    ...CAUSATIVES.flatMap((s) => VOWEL_ENDINGS.map((e) => s + e)),
    ...STEM_NOUNS.flatMap(nounForms),
    ...COMPOUND_FORMS,
    ...WHOLE_NOUNS.flatMap(nounForms),
    ...DHAKA_PARTICIPLES,
    ...PIG_JOINED,
    ...REVIEW
  ])
]

/* ---------- everyday words ---------- */

/**
 * মাগা, "to ask, to beg" (songs, poems, the old written style): every form that puts ি after মাগ
 * (every person of each tense, the imperative and the participles), with ও or ই, but those the
 * slur মাগি takes too (মাগি "I ask", মাগিতে "to ask"; the imperative মাগিও is left out for it).
 */
const MAGA_ENDS = [
  ...['ি', 'িস', 'িনা'],
  ...['িতেছ', 'িয়াছ'].flatMap((t) => ['ি', '', 'িস', 'ে', 'েন'].map((p) => t + p)),
  ...['িল', 'িতেছিল', 'িয়াছিল'].flatMap((t) => ['াম', 'েম', 'ে', 'ি', '', 'েন', 'া'].map((p) => t + p)),
  'িনু',
  ...['াম', 'েম', 'ে', 'িস', '', 'েন'].map((p) => 'িত' + p),
  ...['', 'ো', 'ে', 'ি', 'েন', 'া'].map((p) => 'িব' + p),
  ...['িয়ো', 'িয়া', 'িবার']
]
const SLUR = new Set(nounForms('মাগি').map(bleepKey))
const MAGA = [...new Set(MAGA_ENDS.flatMap((e) => PARTICLES.map((p) => 'মাগ' + e + p)))].filter((w) => !SLUR.has(bleepKey(w)))
/** চুদুরবুদুর, "stalling" (টালবাহানা; the Bangla Academy's dictionary of regional words; চুদুরবুদুর চলবে না). */
const DITHER = [...new Set(['চুদুরবুদুর', 'চুদুরবুদুরি'].flatMap(nounForms))]

/** Everyday words that share letters with a rude word, each never bleeped. */
const LOOK_ALIKES = [
  // চোদ্দ and চৌদ্দ, "fourteen" (the stem's দ takes a virama), and other words starting চো, চু.
  ...['চোদ্দ', 'চোদ্দো', 'চোদ্দটা', 'চোদ্দটি', 'চোদ্দই', 'চোদ্দতম', 'চোদ্দশো', 'চোদ্দবার', 'চোদ্দপুরুষ', 'চোদ্দগুষ্টি', 'চোদ্\u200Cদ'],
  ...['চৌদ্দ', 'চৌদ্দটা', 'চৌদ্দতম', 'চৌদ্দগুষ্টি', 'চোখ', 'চোখের', 'চোর', 'চোরের', 'চোট', 'চোয়াল', 'চাদর', 'চাঁদ', 'চাঁদা', 'চোতা'],
  ...['চুপ', 'চুল', 'চুলের', 'চুলা', 'চুমু', 'চুক্তি', 'চুরি', 'চুন', 'চুড়ি', 'চূড়া', 'চূড়ান্ত', 'চুম্বক', 'চুইঝাল', 'চুইয়ে'],
  ...DITHER,
  // বান-, বাঞ্-, মাদার-: to wreck, wish, wished, a district, mother.
  ...['বানচাল', 'বাঞ্ছা', 'বাঞ্ছিত', 'মাদারীপুর', 'মাদার'],
  // মাগ-: free, catfish, a district, "oh mother", evening prayer, forgiveness, a month; মাগা "to ask" (poetic).
  ...['মাগনা', 'মাগুর', 'মাগুরা', 'মাগো', 'মাগরিব', 'মাগফিরাত', 'মাঘ', 'মাঘের'],
  ...MAGA,
  // খান-: a Sufi lodge, a name, "a little", lineage, food.
  ...['খানকা', 'খানকাহ', 'খান', 'খানা', 'খানিক', 'খানিকটা', 'খানদান', 'খানসামা', 'খানাপিনা', 'খানাখন্দ'],
  // হারাম "forbidden", হারানো "to lose", হালাল.
  ...['হারাম', 'হারামের', 'হারানো', 'হারিয়ে', 'হার', 'হারা', 'হারমোনিয়াম', 'হালাল'],
  // বাল-: boy, girl, pillow, bucket, sand, bangle, trouble, childhood, and places.
  ...['বালক', 'বালকটি', 'বালকের', 'বালকেরা', 'বালকদের', 'বালিকা', 'বালিকাদের', 'বালিকারা', 'বালিশ', 'বালিশের', 'বালতি', 'বালতিতে'],
  ...['বালি', 'বালির', 'বালিতে', 'বালু', 'বালুর', 'বালুচর', 'বালুকা', 'বালুকাবেলা', 'বালা', 'বালাই', 'বালাম'],
  ...['বাল্য', 'বাল্যকাল', 'বাল্যবিবাহ', 'বাল্যবন্ধু', 'বালিগঞ্জ', 'বালিয়াডাঙ্গী'],
  // শুয়োর "pig" (য় written either way), শুয়ে "lying down".
  ...['শুয়োর', 'শু\u09DFোর', 'শুয়ে', 'শুয়েছিল', 'শুকনো', 'শুক্রবার', 'শুভ', 'শুরু']
]
const EVERYDAY = [
  ...LOOK_ALIKES,
  // School.
  ...['স্কুল', 'বিদ্যালয়', 'কলেজ', 'বিশ্ববিদ্যালয়', 'শিক্ষক', 'শিক্ষিকা', 'ছাত্র', 'ছাত্রী', 'শিক্ষার্থী', 'পরীক্ষা', 'ফলাফল', 'বই', 'খাতা', 'কলম'],
  ...['পেন্সিল', 'অঙ্ক', 'গণিত', 'বিজ্ঞান', 'ইতিহাস', 'ভূগোল', 'ব্যাকরণ', 'বাংলা', 'ইংরেজি', 'শ্রেণি', 'ক্লাস', 'পাঠ', 'পড়া', 'লেখা'],
  ...['প্রশ্ন', 'উত্তর', 'শিক্ষা', 'বৃত্তি', 'গ্রন্থাগার', 'ছুটি', 'খেলা', 'মাঠ', 'বেঞ্চ', 'চক'],
  // Family.
  ...['মা', 'বাবা', 'আব্বা', 'আম্মা', 'ভাই', 'বোন', 'দাদা', 'দিদি', 'দাদি', 'দাদু', 'ঠাকুমা', 'নানা', 'নানি', 'চাচা', 'চাচি', 'মামা'],
  ...['মামি', 'খালা', 'খালু', 'ফুফু', 'কাকা', 'কাকি', 'পিসি', 'মাসি', 'ছেলে', 'মেয়ে', 'স্বামী', 'স্ত্রী', 'পরিবার', 'সন্তান', 'নাতি'],
  ...['নাতনি', 'শ্বশুর', 'শাশুড়ি', 'ভাবি', 'দুলাভাই', 'আত্মীয়', 'বিয়ে', 'জন্মদিন', 'বাড়ি', 'ঘর'],
  // Food.
  ...['ভাত', 'ডাল', 'মাছ', 'মাংস', 'রুটি', 'পরোটা', 'ডিম', 'দুধ', 'চা', 'চিনি', 'লবণ', 'তেল', 'পেঁয়াজ', 'রসুন', 'আদা', 'হলুদ', 'মরিচ'],
  ...['আলু', 'বেগুন', 'টমেটো', 'শাক', 'সবজি', 'ফল', 'আম', 'কলা', 'কাঁঠাল', 'লিচু', 'পেয়ারা', 'নারকেল', 'মিষ্টি', 'রসগোল্লা', 'সন্দেশ'],
  ...['দই', 'খিচুড়ি', 'বিরিয়ানি', 'পোলাও', 'ইলিশ', 'রুই', 'চিংড়ি', 'মুরগি', 'গরু', 'খাসি', 'পিঠা', 'মুড়ি', 'চিড়া', 'ভর্তা', 'তরকারি'],
  ...['পানি', 'জল', 'নাস্তা', 'খাবার'],
  // Numbers.
  ...['এক', 'দুই', 'তিন', 'চার', 'পাঁচ', 'ছয়', 'সাত', 'আট', 'নয়', 'দশ', 'এগারো', 'বারো', 'তেরো', 'পনেরো', 'ষোলো', 'সতেরো', 'আঠারো'],
  ...['উনিশ', 'বিশ', 'একুশ', 'বাইশ', 'পঁচিশ', 'ত্রিশ', 'চল্লিশ', 'পঞ্চাশ', 'ষাট', 'সত্তর', 'আশি', 'নব্বই', 'একশো', 'হাজার', 'লাখ'],
  ...['কোটি', 'প্রথম', 'দ্বিতীয়', 'তৃতীয়', 'অর্ধেক', 'দেড়', 'আড়াই'],
  // Places.
  ...['ঢাকা', 'চট্টগ্রাম', 'খুলনা', 'রাজশাহী', 'সিলেট', 'বরিশাল', 'রংপুর', 'ময়মনসিংহ', 'কুমিল্লা', 'নোয়াখালী', 'যশোর', 'বগুড়া'],
  ...['দিনাজপুর', 'কলকাতা', 'পশ্চিমবঙ্গ', 'বাংলাদেশ', 'ভারত', 'গাজীপুর', 'নারায়ণগঞ্জ', 'টাঙ্গাইল', 'ফরিদপুর', 'চাঁদপুর', 'কক্সবাজার'],
  ...['সুন্দরবন', 'পদ্মা', 'মেঘনা', 'যমুনা', 'গঙ্গা', 'হাওড়া', 'শিলিগুড়ি', 'আসাম', 'ত্রিপুরা', 'মিরপুর', 'ধানমন্ডি', 'গুলশান'],
  ...['মোহাম্মদপুর', 'উত্তরা', 'রাস্তা', 'গ্রাম', 'শহর', 'নদী', 'জেলা', 'উপজেলা'],
  // News.
  ...['সরকার', 'প্রধানমন্ত্রী', 'রাষ্ট্রপতি', 'মন্ত্রী', 'নির্বাচন', 'সংসদ', 'আদালত', 'মামলা', 'রায়', 'পুলিশ', 'সংবাদ', 'খবর'],
  ...['প্রতিবেদন', 'সাংবাদিক', 'অর্থনীতি', 'বাজেট', 'বন্যা', 'ঘূর্ণিঝড়', 'দুর্ঘটনা', 'হাসপাতাল', 'চিকিৎসা', 'রোগী', 'ডাক্তার'],
  ...['আবহাওয়া', 'বৃষ্টি', 'তাপমাত্রা', 'বাজার', 'দাম', 'টাকা', 'ব্যাংক', 'শেয়ার', 'রপ্তানি', 'আমদানি', 'উন্নয়ন', 'প্রকল্প', 'সেতু'],
  ...['সড়ক', 'রেল', 'বিমান', 'খেলাধুলা', 'ক্রিকেট', 'ফুটবল', 'বিশ্বকাপ', 'দল', 'জয়', 'পরাজয়', 'আন্দোলন', 'সমাবেশ', 'ঘোষণা'],
  ...['সিদ্ধান্ত', 'আইন'],
  // Every day.
  ...['আমি', 'তুমি', 'আপনি', 'সে', 'তারা', 'আমরা', 'তোমরা', 'কেন', 'কোথায়', 'কখন', 'কীভাবে', 'ভালো', 'খারাপ', 'সুন্দর', 'আজ'],
  ...['কাল', 'এখন', 'সকাল', 'দুপুর', 'বিকেল', 'সন্ধ্যা', 'রাত', 'দিন', 'সপ্তাহ', 'মাস', 'বছর', 'কাজ', 'অফিস', 'বন্ধু', 'ভালোবাসা'],
  ...['ধন্যবাদ', 'দয়া', 'সাহায্য', 'গান', 'ছবি', 'সিনেমা', 'নাটক', 'মোবাইল', 'কম্পিউটার', 'ইন্টারনেট', 'ভিডিও']
]

/** The prefix rule of 840bc42: a word starting with one of these, at most 3 more letters. */
const OLD = ['চোদ', 'চুদি', 'চোদা', 'খানকি', 'মাগি', 'বাল', 'হারামি', 'হারামজাদা', 'শুয়োরের']
const oldRule = (w: string): boolean => {
  const key = bleepKey(w)
  return OLD.some((t) => bleepKey(t) === key || (key.startsWith(bleepKey(t)) && key.length - bleepKey(t).length <= 3))
}

/* ---------- helpers ---------- */

const project = (segments: CaptionSegment[], language?: string): Project =>
  ({ duration: 100000, clips: [{ start: 0, end: 100000, speed: 1 }], transcript: { ...(language ? { language } : {}), provider: 'local', model: 'm', createdAt: '', segments } }) as unknown as Project
const timed = (id: string, start: number, text: string): CaptionSegment => {
  const words = text.split(' ').map((w, i) => ({ text: w, start: start + i * 0.5, end: start + i * 0.5 + 0.4 }))
  return { id, start, end: words[words.length - 1].end, text, words }
}
/** The words Tidy captions bleeps in a transcript that names no language, one caption per word between Bangla words. */
function bleptUnnamed(words: readonly string[], bleep: 'standard' | 'strict'): string[] {
  const out: string[] = []
  // At most 1,000 captions a run: Tidy captions keeps at most 2,000 bleeps.
  for (let at = 0; at < words.length; at += 1000) {
    const segs = words.slice(at, at + 1000).map((w, i) => timed(`c${i}`, i * 4, `আমরা আজ ${w} দেখলাম`))
    const p = project(segs)
    out.push(...(tidyCaptions(p, { ...OFF, bleep, words: [] }).project.bleeps ?? []).map((b) => b.word))
  }
  return out
}

describe('Bangla bleeping: stems, compounds and every generated form', () => {
  it('bleeps every form of every stem, compound and whole noun, in Standard and Strict, bn and bn-BD', () => {
    expect(RUDE.length).toBeGreaterThan(3000)
    for (const [mode, lang] of MODES) {
      const missed = RUDE.filter((w) => !isSwearWord(w, mode, lang))
      expect(missed, `${mode} ${lang}`).toEqual([])
    }
  })

  it('bleeps them written another way: য় as one code point, ো in two parts (a joiner between or not), ী for ি, ূ for ু, decomposed', () => {
    const variants = RUDE.flatMap((w) => [
      w.replaceAll('\u09AF\u09BC', '\u09DF'),
      w.replaceAll('\u09CB', '\u09C7\u09BE'),
      w.replaceAll('\u09CB', '\u09C7\u200D\u09BE'),
      w.replaceAll('ি', 'ী'),
      w.replaceAll('ু', 'ূ'),
      w.normalize('NFD')
    ])
    for (const [mode, lang] of MODES) expect(variants.filter((w) => !isSwearWord(w, mode, lang)), `${mode} ${lang}`).toEqual([])
  })

  it('bleeps every word the 840bc42 prefix rule caught, but for the everyday words it bleeped', () => {
    // Its catches among the forms and the everyday words.
    const caught = [...RUDE, ...EVERYDAY].filter(oldRule)
    expect(caught.filter((w) => !EVERYDAY.includes(w) && !isSwearWord(w, 'standard', 'bn'))).toEqual([])
    // The everyday words it bleeped: no longer.
    const wrong = EVERYDAY.filter(oldRule)
    expect(wrong).toEqual(expect.arrayContaining(['চোদ্দ', 'বালক', 'বালিশ', 'বালতি', 'বালি', 'বালু', 'বালা', 'বালাই', 'বালিকা', 'মাগিনা']))
    for (const [mode, lang] of MODES) expect(wrong.filter((w) => isSwearWord(w, mode, lang)), `${mode} ${lang}`).toEqual([])
    // Every word it caught after a stem rude in every form (its letter or two after the stem, any of
    // them), but a virama after the stem (চোদ্দ) and the everyday words that start with one.
    const letters = Array.from({ length: 0x09fb - 0x0981 + 1 }, (_, i) => String.fromCharCode(0x0981 + i)).filter((c) => /\p{L}|\p{M}/u.test(c))
    const tails = [...letters, ...letters.flatMap((a) => letters.map((b) => a + b))]
    // An everyday word written with ী for ি or ূ for ু (মাগিলী, মাগিনূ) is that word still.
    const spelled = (w: string): string => bleepKey(w).replaceAll('ী', 'ি').replaceAll('ূ', 'ু')
    const everyday = new Set(EVERYDAY.map(spelled))
    const virama = (w: string): boolean => /^(চোদ|চুদ)\u09CD/u.test(bleepKey(w))
    for (const stem of ['চোদ', 'চুদি', 'চোদা', 'খানকি', 'মাগি', 'হারামি', 'হারামজাদা']) {
      const words = tails.map((t) => stem + t).filter((w) => oldRule(w) && !virama(w) && !everyday.has(spelled(w)))
      expect(words.length, stem).toBeGreaterThan(5000)
      expect(words.filter((w) => !isSwearWord(w, 'standard', 'bn')), stem).toEqual([])
    }
  })

  it('bleeps them in a transcript that names no language but is mostly Bangla, one bleep a word', () => {
    for (const bleep of ['standard', 'strict'] as const) expect(bleptUnnamed(RUDE, bleep), bleep).toEqual(RUDE.map((w) => bleepKey(w).slice(0, 40)))
  })

  it('Tidy captions bleeps one word in each of the review’s captions, named Bangla or not', () => {
    const segs = REVIEW_LINES.map((text, i) => timed(String(i), i * 5, text))
    const rude = ['চুদতেছস', 'হারামজাদাটারে', 'খানকিরাও', 'চুদাচুদি', 'চোদাইলি', 'চুদিয়েছিল', 'মাগিটাও', 'চুদনা'].map(bleepKey)
    for (const language of ['bn', 'bn-BD', undefined]) {
      for (const bleep of ['standard', 'strict'] as const) {
        expect(tidyCaptions(project(segs, language), { ...OFF, bleep, words: [] }).project.bleeps?.map((b) => b.word), `${language} ${bleep}`).toEqual(rude)
      }
    }
  })

  it('bleeps শুয়োরের, however it is spelled, only before বাচ্চা: never in শুয়োরের মাংস (pork) or শুয়োরের খামার (a pig farm)', () => {
    const spellings = PIG_GENITIVES.flatMap((g) => [g, g.replaceAll('\u09AF\u09BC', '\u09DF'), g.replaceAll('ু', 'ূ'), g.normalize('NFD')])
    for (const [mode, lang] of MODES) {
      for (const g of spellings) {
        expect(KIDS.filter((k) => !isSwearWord(g, mode, lang, k)), `${mode} ${lang} ${g}`).toEqual([])
        for (const next of ['মাংস', 'খামারে', 'আক্রমণে', 'চাষ', '']) expect(isSwearWord(g, mode, lang, next), `${mode} ${lang} ${g} ${next}`).toBe(false)
        // A lone word, the word after it unknown: as it may be used.
        expect(isSwearWord(g, mode, lang), `${mode} ${lang} ${g}`).toBe(true)
      }
    }
    const lines = (g: string): string[] => [
      `তুই একটা ${g} বাচ্চা`,
      `${g} বাচ্চারা পালাল`,
      `${g} মাংস খাওয়া ইসলামে হারাম।`,
      `বুনো ${g} আক্রমণে দুজন আহত`,
      `${g} খামারে আফ্রিকান সোয়াইন ফিভার ছড়িয়েছে।`,
      // বাচ্চা at the start of the next caption.
      `ওই ${g}`,
      'বাচ্চাটা পালাল'
    ]
    for (const g of PIG_GENITIVES) {
      const segs = lines(g).map((text, i) => timed(String(i), i * 5, text))
      for (const language of ['bn', 'bn-BD', undefined]) {
        for (const bleep of ['standard', 'strict'] as const) {
          const out = tidyCaptions(project(segs, language), { ...OFF, bleep, words: [] }).project.bleeps ?? []
          expect(out.map((b) => [b.word, Math.floor((b.start + 0.1) / 5)]), `${g} ${language} ${bleep}`).toEqual([0, 1, 5].map((i) => [bleepKey(g), i]))
        }
      }
    }
  })

  it('bleeps বাল but before a name or a set phrase: বাল গঙ্গাধর তিলক, বাল ঠাকরে, লাল বাল পাল, বাল গোপাল, বাল বাচ্চা (the kids)', () => {
    for (const [mode, lang] of MODES) {
      expect(BAL_NAMES.filter((n) => isSwearWord('বাল', mode, lang, n)), `${mode} ${lang}`).toEqual([])
      for (const next of ['বলিস', 'ছিঁড়বি', 'কথা', '', undefined]) expect(isSwearWord('বাল', mode, lang, next), `${mode} ${lang} ${next}`).toBe(true)
    }
    const named = [
      'বাল গঙ্গাধর তিলক স্বাধীনতা আন্দোলনের নেতা ছিলেন।',
      'শিবসেনার প্রতিষ্ঠাতা বাল ঠাকরে',
      'লাল বাল পাল',
      'বাল গোপালের পূজা হয় জন্মাষ্টমীতে।',
      'বাল বাচ্চা নিয়ে আমরা গ্রামে বেড়াতে গেলাম।',
      'বাল-গোপাল'
    ]
    const rude = ['কি বাল বলিস', 'বাল!', 'বাল ছিঁড়বি তুই']
    const segs = [...named, ...rude].map((text, i) => timed(String(i), i * 5, text))
    for (const language of ['bn', 'bn-BD', undefined]) {
      for (const bleep of ['standard', 'strict'] as const) {
        const out = tidyCaptions(project(segs, language), { ...OFF, bleep, words: [] }).project.bleeps ?? []
        expect(out.map((b) => [b.word, Math.floor((b.start + 0.1) / 5)]), `${language} ${bleep}`).toEqual([6, 7, 8].map((i) => [bleepKey('বাল'), i]))
      }
    }
  })

  it('bleeps a rude word joined to the word before or after it by a dash or a । with no space, and never an everyday word joined so', () => {
    const JOINERS = ['-', '—', '–', '।']
    const rude = RUDE.flatMap((w) => JOINERS.flatMap((j) => [`ধুর${j}${w}`, `${w}${j}এটা`]))
    const everyday = [...EVERYDAY.flatMap((w) => JOINERS.flatMap((j) => [`ধুর${j}${w}`, `${w}${j}এটা`])), 'well-known', 'চোদ্দ-চোদ্দ', 'চুদুর-বুদুর', 'চুদুর-বুদুরের', 'বাল-গোপাল', 'শুয়োরের-মাংস']
    // The team's list is the same in both modes: the rude words in Standard, the everyday ones in Strict, which has more lists.
    expect(rude.filter((w) => !isSwearWord(w, 'standard', 'bn'))).toEqual([])
    expect(everyday.filter((w) => isSwearWord(w, 'strict', 'bn-BD'))).toEqual([])
    // The pig's child joined to বাচ্চা by a dash, or written in two parts, the second at the start of the next word.
    for (const [mode, lang] of MODES) {
      expect(PIG_GENITIVES.filter((g) => !isSwearWord(`${g}-বাচ্চা`, mode, lang) || !isSwearWord(`ধুর—${g}`, mode, lang, 'বাচ্চা-টা')), `${mode} ${lang}`).toEqual([])
      expect(PIG_GENITIVES.filter((g) => isSwearWord(`${g}-মাংস`, mode, lang, 'খাওয়া') || isSwearWord(`ধুর—${g}`, mode, lang, 'মাংস')), `${mode} ${lang}`).toEqual([])
    }
  })

  it('Tidy captions bleeps the spellings, compounds and Dhaka forms the checkers found, named Bangla or not', () => {
    const lines = [
      ['শুওরের বাচ্চা কোথাকার', 'শুওরের'],
      ['শুয়ারের বাচ্চা', 'শুয়ারের'],
      ['শালা বাইনচোদ একটা', 'বাইনচোদ'],
      ['ওই বানচোত টা', 'বানচোত'],
      ['বাঞ্চোৎ কোথাকার', 'বাঞ্চোৎ'],
      ['মাদারচোত সব', 'মাদারচোত'],
      ['তোরে চুইদা দিমু', 'চুইদা'],
      ['তোরে চুইদ্দা দিমু', 'চুইদ্দা'],
      ['খাংকির পোলা', 'খাংকির'],
      ['এই চুৎমারানি', 'চুৎমারানি'],
      ['বালপাকনা পোলাপান', 'বালপাকনা'],
      ['ধুর—বাল', 'ধুর—বাল'],
      ['শুয়োরের-বাচ্চা', 'শুয়োরের-বাচ্চা'],
      ['বাল।এটা কী', 'বাল।এটা'],
      ['শালা-খানকি', 'শালা-খানকি'],
      // Everyday: none.
      ['ওসব চুদুরবুদুর চলবে না, সোজা কথা বলুন।', ''],
      ['ওসব চুদুর বুদুর চলবে না', ''],
      ['চুদুর-বুদুর চলবে না', ''],
      ['তোমার কাছে ক্ষমা মাগিতেছেন তিনি', ''],
      ['সে মাগিবার আগে মাগিয়াছিলাম আমি', ''],
      ['জাহাজটা বানচাল হয়ে গেল', ''],
      ['চোদ্দ-চোদ্দ টাকা', '']
    ]
    const segs = lines.map(([text], i) => timed(String(i), i * 5, text))
    const want = lines.flatMap(([, w], i) => (w ? [[bleepKey(w), i]] : []))
    for (const language of ['bn', 'bn-BD', undefined]) {
      for (const bleep of ['standard', 'strict'] as const) {
        const out = tidyCaptions(project(segs, language), { ...OFF, bleep, words: [] }).project.bleeps ?? []
        expect(out.map((b) => [b.word, Math.floor((b.start + 0.1) / 5)]), `${language} ${bleep}`).toEqual(want)
      }
    }
  })

  it('never bleeps an everyday word, in Standard and Strict, bn and bn-BD, or in a transcript that names no language', () => {
    expect(EVERYDAY.length).toBeGreaterThanOrEqual(300)
    expect(new Set(EVERYDAY).size).toBe(EVERYDAY.length)
    // None of them is a form of a rude word.
    const rude = new Set(RUDE.map(bleepKey))
    expect(EVERYDAY.filter((w) => rude.has(bleepKey(w)))).toEqual([])
    for (const [mode, lang] of MODES) expect(EVERYDAY.filter((w) => isSwearWord(w, mode, lang)), `${mode} ${lang}`).toEqual([])
    // Written another way too.
    const variants = LOOK_ALIKES.flatMap((w) => [w.replaceAll('\u09AF\u09BC', '\u09DF'), w.replaceAll('\u09CB', '\u09C7\u09BE'), w.normalize('NFD')])
    for (const [mode, lang] of MODES) expect(variants.filter((w) => isSwearWord(w, mode, lang)), `${mode} ${lang}`).toEqual([])
    for (const bleep of ['standard', 'strict'] as const) expect(bleptUnnamed(EVERYDAY, bleep), bleep).toEqual([])
  })

  it('folds spellings for matching only: the captions keep their text and the bleep its word as written', () => {
    const p = project([timed('a', 0, 'ওই মাগীটারে ধর'), timed('b', 5, 'এই চ\u09C7\u09BEদা\u09DF কেন')], 'bn')
    const out = tidyCaptions(p, { ...OFF, bleep: 'standard', words: [] })
    expect(out.project.transcript).toBe(p.transcript)
    expect(out.project.bleeps?.map((b) => b.word)).toEqual([bleepKey('মাগীটারে'), bleepKey('চ\u09C7\u09BEদা\u09DF')])
  })
})
