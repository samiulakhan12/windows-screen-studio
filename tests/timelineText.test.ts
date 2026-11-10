/**
 * Test 40 (docs/design/output-and-languages.md §23.1, §8.6, §18.3): paths as file URLs and text
 * inside timeline files. Every name a timeline writes goes through xmlText or xmlAttr, so a pasted
 * or AI-made chapter title can neither break out of its place nor make the file unreadable.
 */
import { describe, expect, it } from 'vitest'
import { asciiName, fileUrl, xmlAttr, xmlText } from '../src/shared/interchange/fileUrl'
import { parseXml, textOf } from './strictXml'

const HOSTILE = `a<b>&c"d'e\u0001f\u000Bg\uFFFEh\uD800i\uDC00j\u0000k\u001Fl\uFFFF\u000Cm`

describe('test 40: fileUrl', () => {
  it('percent-encodes a Bangla name, spaces and # and keeps the drive letter', () => {
    const path = 'C:\\Users\\রহিম\\My Videos\\a#b.mp4'
    expect(fileUrl(path, 'fcpxml')).toBe('file:///C:/Users/%E0%A6%B0%E0%A6%B9%E0%A6%BF%E0%A6%AE/My%20Videos/a%23b.mp4')
    expect(fileUrl(path, 'xmeml')).toBe('file://localhost/C:/Users/%E0%A6%B0%E0%A6%B9%E0%A6%BF%E0%A6%AE/My%20Videos/a%23b.mp4')
  })

  it('encodes % and ? and keeps parentheses, an upper-case drive and forward slashes', () => {
    expect(fileUrl('d:/Videos/Demo (Flown)/100% done?.mov', 'fcpxml')).toBe('file:///D:/Videos/Demo%20(Flown)/100%25%20done%3F.mov')
  })

  it('names the server of a network path and writes a POSIX path from the root', () => {
    expect(fileUrl('\\\\nas\\Shared Videos\\a.mp4', 'fcpxml')).toBe('file://nas/Shared%20Videos/a.mp4')
    expect(fileUrl('\\\\nas\\Shared Videos\\a.mp4', 'xmeml')).toBe('file://nas/Shared%20Videos/a.mp4')
    expect(fileUrl('/tmp/out dir/a.mp4', 'fcpxml')).toBe('file:///tmp/out%20dir/a.mp4')
    expect(fileUrl('/tmp/out dir/a.mp4', 'xmeml')).toBe('file://localhost/tmp/out%20dir/a.mp4')
  })

  it('never throws on a lone surrogate in a path', () => {
    expect(fileUrl('C:\\a\uD800b.mp4', 'fcpxml')).toBe('file:///C:/a%EF%BF%BDb.mp4')
  })
})

describe('test 40: xmlText and xmlAttr', () => {
  it('escape <, &, ", \' and > and drop the characters XML 1.0 forbids', () => {
    expect(xmlText(HOSTILE)).toBe('a&lt;b&gt;&amp;c&quot;d&apos;efghijklm')
    expect(xmlAttr(HOSTILE)).toBe('a&lt;b&gt;&amp;c&quot;d&apos;efghijklm')
  })

  it('keep a surrogate pair and Bangla text whole', () => {
    expect(xmlText('রহিম 😀')).toBe('রহিম 😀')
    expect(xmlAttr('রহিম 😀')).toBe('রহিম 😀')
  })

  it('write a newline in an attribute as &#10; and keep it in text', () => {
    expect(xmlAttr('one\ntwo\r\tthree')).toBe('one&#10;two&#13;&#9;three')
    expect(xmlText('one\ntwo')).toBe('one\ntwo')
  })

  it('give a document an XML 1.0 parser reads back to the same text', () => {
    const name = `${HOSTILE}\nline two ]]> & রহিম`
    const doc = `<?xml version="1.0" encoding="UTF-8"?>\n<root title="${xmlAttr(name)}" other='${xmlAttr(name)}'><t>${xmlText(name)}</t></root>\n`
    const root = parseXml(doc)
    const kept = name.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDFFF]/g, '')
    expect(root.attrs.title).toBe(kept)
    expect(root.attrs.other).toBe(kept)
    expect(textOf(root, 't')).toBe(kept)
    // The reader itself refuses what the escaping prevents.
    expect(() => parseXml(`<root title="${name}"/>`)).toThrow()
    expect(() => parseXml(`<root>${name}</root>`)).toThrow()
  })
})

describe('asciiName (EDL names, §8.5)', () => {
  it('takes accents off, drops other letters and falls back when no ASCII letter is left', () => {
    expect(asciiName('Café résumé', 'Chapter 1')).toBe('Cafe resume')
    expect(asciiName('Intro রহিম  part', 'Chapter 1')).toBe('Intro part')
    expect(asciiName('ভূমিকা', 'Chapter 2')).toBe('Chapter 2')
    expect(asciiName('২০২৬ 42', 'Chapter 3')).toBe('Chapter 3')
    expect(asciiName('tab\there\u0001', 'x')).toBe('tab here')
  })
})
