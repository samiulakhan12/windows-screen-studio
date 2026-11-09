/**
 * Every phrase of guides and demos in English and Bangla (docs/design/smart-tools.md §15): step
 * titles, the document's headings, the demo's buttons and the bug report's details. Templates name
 * their parts in braces ("Click “{x}”"), filled by `fill`. The Bangla words need a native speaker's
 * check before release (§0 decision 9). Other languages use the English words with their own
 * narration until the app is translated. Pure.
 */
import { transcriptLanguage } from '../captions/captionTracks'
import { withDigits } from '../captions/words'
import type { Project } from '../types'

/** A place on the screen, in thirds (review/copy.ts placeOf). */
export type GuidePlace = 'top left' | 'top' | 'top right' | 'left' | 'middle' | 'right' | 'bottom left' | 'bottom' | 'bottom right'

export interface GuideWords {
  /** Actions on a named control: {x} the control. */
  click: string
  double: string
  right: string
  middle: string
  drag: string
  /** Actions at a place: {near} a `near` phrase, {place} a `places` word. */
  clickNear: string
  doubleNear: string
  rightNear: string
  middleNear: string
  clickText: string
  clickLink: string
  /** {side} a `sides` phrase. */
  taskbar: string
  /** {a} and {b}: `places` words. */
  dragFromTo: string
  typeText: string
  /** {text}: what to type. */
  typeLine: string
  /** {title} the title so far. */
  andType: string
  andPress: string
  times: string
  /** {way} a `ways` word, {title} the title it leads into. */
  scrollThen: string
  /** {keys} a shortcut as recorded. */
  press: string
  /** {n} the step's number. */
  step: string
  stepAlt: string
  /** The demo's hotspot: {title}. */
  hotspot: string
  back: string
  next: string
  more: string
  startAgain: string
  /** {n} of {m}. */
  stepOf: string
  stepsToReproduce: string
  expected: string
  actual: string
  details: string
  recordedOn: string
  screen: string
  length: string
  part: string
  intro: string
  /** Before the PDF's page numbers ("" in English: "3 / 12"). */
  page: string
  places: Readonly<Record<GuidePlace, string>>
  near: Readonly<Record<GuidePlace, string>>
  sides: Readonly<Record<'left' | 'middle' | 'right', string>>
  ways: Readonly<Record<'up' | 'down' | 'left' | 'right', string>>
}

export const GUIDE_WORDS: Record<'en' | 'bn', GuideWords> = {
  en: {
    click: 'Click “{x}”',
    double: 'Double-click “{x}”',
    right: 'Right-click “{x}”',
    middle: 'Middle-click “{x}”',
    drag: 'Drag “{x}”',
    clickNear: 'Click {near}',
    doubleNear: 'Double-click {near}',
    rightNear: 'Right-click {near}',
    middleNear: 'Middle-click {near}',
    clickText: 'Click in the text field near the {place}',
    clickLink: 'Click the link or button near the {place}',
    taskbar: 'Click on the taskbar, {side}',
    dragFromTo: 'Drag from the {a} to the {b}',
    typeText: 'Type your text',
    typeLine: 'Type: {text}',
    andType: '{title} and type',
    andPress: '{title} and press {key}',
    times: '{title} {n} times',
    scrollThen: 'Scroll {way}, then {title}',
    press: 'Press {keys}',
    step: 'Step {n}',
    stepAlt: 'Step {n}: {title}',
    hotspot: '{title}. Next step',
    back: 'Back',
    next: 'Next',
    more: 'More',
    startAgain: 'Start again',
    stepOf: 'Step {n} of {m}',
    stepsToReproduce: 'Steps to reproduce',
    expected: 'Expected',
    actual: 'Actual',
    details: 'Details',
    recordedOn: 'Recorded on {date}',
    screen: 'Screen {w} × {h} at {scale}',
    length: 'Length {time}',
    part: 'Part {n}',
    intro: 'Intro',
    page: '',
    places: {
      'top left': 'top left',
      top: 'top',
      'top right': 'top right',
      left: 'left',
      middle: 'middle',
      right: 'right',
      'bottom left': 'bottom left',
      bottom: 'bottom',
      'bottom right': 'bottom right'
    },
    near: {
      'top left': 'near the top left',
      top: 'near the top',
      'top right': 'near the top right',
      left: 'near the left',
      middle: 'in the middle',
      right: 'near the right',
      'bottom left': 'near the bottom left',
      bottom: 'near the bottom',
      'bottom right': 'near the bottom right'
    },
    sides: { left: 'on the left', middle: 'in the middle', right: 'on the right' },
    ways: { up: 'up', down: 'down', left: 'left', right: 'right' }
  },
  bn: {
    click: '“{x}”-এ ক্লিক করুন',
    double: '“{x}”-এ ডাবল-ক্লিক করুন',
    right: '“{x}”-এ রাইট-ক্লিক করুন',
    middle: '“{x}”-এ মিডল-ক্লিক করুন',
    drag: '“{x}” টেনে আনুন',
    clickNear: '{near} ক্লিক করুন',
    doubleNear: '{near} ডাবল-ক্লিক করুন',
    rightNear: '{near} রাইট-ক্লিক করুন',
    middleNear: '{near} মিডল-ক্লিক করুন',
    clickText: '{place} লেখার ঘরে ক্লিক করুন',
    clickLink: '{place} লিংক বা বোতামে ক্লিক করুন',
    taskbar: 'টাস্কবারে {side} ক্লিক করুন',
    dragFromTo: '{a} থেকে {b} পর্যন্ত টেনে আনুন',
    typeText: 'আপনার লেখা টাইপ করুন',
    typeLine: 'টাইপ করুন: {text}',
    andType: '{title} এবং টাইপ করুন',
    andPress: '{title} এবং {key} চাপুন',
    times: '{title} {n} বার',
    scrollThen: '{way} স্ক্রোল করে {title}',
    press: '{keys} চাপুন',
    step: 'ধাপ {n}',
    stepAlt: 'ধাপ {n}: {title}',
    hotspot: '{title}. পরের ধাপ',
    back: 'আগের ধাপ',
    next: 'পরের ধাপ',
    more: 'আরও',
    startAgain: 'আবার শুরু',
    stepOf: 'ধাপ {n} / {m}',
    stepsToReproduce: 'সমস্যাটি ঘটানোর ধাপ',
    expected: 'যা হওয়ার কথা',
    actual: 'যা হচ্ছে',
    details: 'বিস্তারিত',
    recordedOn: 'রেকর্ড করা হয়েছে {date}',
    screen: 'স্ক্রিন {w} × {h}, {scale}',
    length: 'দৈর্ঘ্য {time}',
    part: 'অংশ {n}',
    intro: 'শুরু',
    page: 'পৃষ্ঠা ',
    places: {
      'top left': 'উপরে বাঁদিকে',
      top: 'উপরে',
      'top right': 'উপরে ডানদিকে',
      left: 'বাঁদিকে',
      middle: 'মাঝখানে',
      right: 'ডানদিকে',
      'bottom left': 'নিচে বাঁদিকে',
      bottom: 'নিচে',
      'bottom right': 'নিচে ডানদিকে'
    },
    near: {
      'top left': 'উপরে বাঁদিকে',
      top: 'উপরে',
      'top right': 'উপরে ডানদিকে',
      left: 'বাঁদিকে',
      middle: 'মাঝখানে',
      right: 'ডানদিকে',
      'bottom left': 'নিচে বাঁদিকে',
      bottom: 'নিচে',
      'bottom right': 'নিচে ডানদিকে'
    },
    sides: { left: 'বাঁদিকে', middle: 'মাঝখানে', right: 'ডানদিকে' },
    ways: { up: 'উপরে', down: 'নিচে', left: 'বাঁদিকে', right: 'ডানদিকে' }
  }
}

/** `template` with each {name} replaced by its value (an unknown name is left as written). */
export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : all))
}

/** The guide's language: the one chosen, else Bangla for Bangla captions, else English. */
export function guideLanguage(project: Project): 'en' | 'bn' {
  if (project.guide?.language) return project.guide.language
  return transcriptLanguage(project.transcript)?.toLowerCase().split('-')[0] === 'bn' ? 'bn' : 'en'
}

/** The guide's digits (§15): the captions' Digits choice, else Bangla digits for a Bangla guide. */
export function guideDigits(project: Pick<Project, 'captions'>, language: 'en' | 'bn'): 'native' | 'western' {
  return project.captions?.digits ?? (language === 'bn' ? 'native' : 'western')
}

/** A number ("3", "3.1") in the guide's digits. */
export function guideNumber(n: number | string, language: 'en' | 'bn', digits: 'native' | 'western'): string {
  return withDigits(String(n), digits, language)
}

/** The place of a normalised point, in thirds of the frame. */
export function placeIn(x: number, y: number): GuidePlace {
  const col = x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : ''
  const row = y < 1 / 3 ? 'top' : y > 2 / 3 ? 'bottom' : ''
  if (row && col) return `${row} ${col}` as GuidePlace
  return (row || col || 'middle') as GuidePlace
}
