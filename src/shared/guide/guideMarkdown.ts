/**
 * The guide as Markdown (docs/design/smart-tools.md §5.6): `guide.md` beside an `images` folder
 * with `step-01.png` … and `actual.png`. Every CommonMark punctuation character of the user's text
 * is escaped, so no raw HTML, link or emphasis passes; image paths are fixed names. Bangla and every
 * other script stay as they are (UTF-8). Pure.
 */
import { fill } from './guideWords'
import type { GuideDoc } from './guideDoc'

/** The characters CommonMark gives a meaning to (§5.6), each escaped with a backslash. */
const PUNCTUATION = /[\\`*_{}[\]<>()#+\-.!|]/g

/** `text` on one line with every CommonMark punctuation character escaped. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(PUNCTUATION, (c) => `\\${c}`)
}

/** A note's paragraphs (its line breaks kept as paragraph breaks), each escaped. */
function paragraphs(text: string): string[] {
  return text
    .split(/\r\n?|\n|\u2028|\u2029/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(escapeMarkdown)
}

/** `step-01.png` … (three digits from 100 images). */
const imageName = (i: number, count: number): string => `step-${String(i).padStart(count >= 100 ? 3 : 2, '0')}.png`

/**
 * The Markdown of `doc` and the names of its images in the order their bytes go with it (the
 * steps' images, then the bug report's Actual screenshot). A guide: `# title`, the intro, a
 * `## n. title` per step (`###` under `## section` headings), its *Type* line, image and note. A
 * bug report: Steps to reproduce as a numbered list, then Expected, Actual (with its screenshot)
 * and Details.
 */
export function guideMarkdown(doc: GuideDoc): { markdown: string; images: string[] } {
  const w = doc.words
  const images: string[] = []
  const lines: string[] = [`# ${escapeMarkdown(doc.title)}`, '']
  if (doc.intro) for (const p of paragraphs(doc.intro)) lines.push(p, '')
  const withImages = doc.steps.filter((s) => s.image).length
  const image = (alt: string): string => {
    const name = imageName(images.length + 1, withImages)
    images.push(name)
    return `![${escapeMarkdown(alt)}](images/${name})`
  }
  if (doc.bug) {
    lines.push(`## ${escapeMarkdown(w.stepsToReproduce)}`, '')
    doc.steps.forEach((s, i) => {
      lines.push(`${i + 1}. ${escapeMarkdown(s.title)}`)
      if (s.type) lines.push(`   ${escapeMarkdown(fill(w.typeLine, { text: s.type }))}`)
      if (s.image) lines.push(`   ${image(s.alt)}`)
      if (s.text) for (const p of paragraphs(s.text)) lines.push(`   ${p}`)
    })
    lines.push('', `## ${escapeMarkdown(w.expected)}`, '')
    for (const p of paragraphs(doc.bug.expected)) lines.push(p, '')
    lines.push(`## ${escapeMarkdown(w.actual)}`, '')
    for (const p of paragraphs(doc.bug.actual)) lines.push(p, '')
    if (doc.bug.actualImage) {
      images.push('actual.png')
      lines.push(`![${escapeMarkdown(w.actual)}](images/actual.png)`, '')
    }
    if (doc.bug.details.length) {
      lines.push(`## ${escapeMarkdown(w.details)}`, '')
      for (const d of doc.bug.details) lines.push(`- ${escapeMarkdown(d)}`)
      lines.push('')
    }
  } else {
    const sections = doc.steps.some((s) => s.section)
    for (const s of doc.steps) {
      if (s.section) lines.push(`## ${escapeMarkdown(s.section)}`, '')
      lines.push(`${sections ? '###' : '##'} ${s.n}. ${escapeMarkdown(s.title)}`, '')
      if (s.type) lines.push(escapeMarkdown(fill(w.typeLine, { text: s.type })), '')
      if (s.image) lines.push(image(s.alt), '')
      if (s.text) for (const p of paragraphs(s.text)) lines.push(p, '')
    }
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return { markdown: `${lines.join('\n')}\n`, images }
}
