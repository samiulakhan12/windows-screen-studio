/**
 * The guide as a document (docs/design/smart-tools.md §5.6), built once and written as PDF, HTML,
 * a demo or Markdown. Part P1 writes it; the contracts' stub gives its types and exported names.
 */
import type { GuideWords } from './guideWords'
import type { GuideStep } from './steps'
import type { GuideEnd, Project } from '../types'

export interface GuideImage {
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  width: number
  height: number
}

export interface GuideDoc {
  title: string
  intro?: string
  lang: string
  words: GuideWords
  digits: 'native' | 'western'
  brand?: { logo: GuideImage | null; colour: string | null }
  steps: { n: string; label: string; section?: string; title: string; type?: string; text?: string; image: GuideImage | null; alt: string; hotspot?: { x: number; y: number } }[]
  bug?: { expected: string; actual: string; actualImage: GuideImage | null; details: string[] }
  end?: GuideEnd
}

export function buildGuideDoc(project: Project, steps: readonly GuideStep[], images: ReadonlyMap<string, GuideImage>, brand: GuideDoc['brand'] | null): GuideDoc {
  void steps
  void images
  void brand
  throw new Error(`Guides are not part of this build (${project.name}).`)
}
