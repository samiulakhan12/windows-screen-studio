/**
 * Make a shorter version's dialog (docs/design/smart-tools.md §2.4, §8.6; §22.1 test 125): the
 * lengths at or above the video's own disabled with their reason, the line saying what it keeps,
 * the copy made with smooth cuts and its cuts for Review, and the dialog without captions.
 * window.api and the editor are fakes (clipsUi.ts); nothing leaves the test.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '../src/shared/types'
import { clipProject, steadyTalk } from './clipFixtures'
import { closes, editing, el, fake, modal, narrated, opened, press, reset, ShortVersionDialog } from './clipsUi'
import { button, byTestId, settle, textOf, type El } from './studioHarness'

beforeEach(reset)

describe('the shorter version dialog (test 125)', () => {
  it('the dialog: lengths at or above the video’s are disabled with “This video is already 52 s”; 30 s is taken', async () => {
    const p = clipProject({ said: steadyTalk(10, { every: 5 }), duration: 52 })
    editing(p)
    const out = await settle(el(ShortVersionDialog, p))
    const radio = (s: number): El => out.find((e) => e.type === 'input' && e.props.type === 'radio' && e.props.value === s)!
    expect(radio(60).props.disabled).toBe(true)
    expect(radio(90).props.disabled).toBe(true)
    expect(radio(30).props.disabled).toBe(false)
    expect(radio(30).props.checked).toBe(true)
    expect(out.filter((e) => textOf(e) === '(This video is already 52 s)')).toHaveLength(2)
    expect(byTestId(out, 'short-version')!.props).toMatchObject({ role: 'dialog', 'aria-modal': 'true' })
    expect(textOf(byTestId(out, 'short-line'))).toMatch(/^Keeps \d+ sentences?, \d+\.\d s, smooth cuts/)
  })
  it('the dialog makes the copy: smooth cuts, its cuts for Review, captions as asked; then Open the copy', async () => {
    const p = narrated()
    editing(p)
    let out = await settle(el(ShortVersionDialog, p))
    expect(out.find((e) => e.type === 'input' && e.props.value === 60)!.props.checked).toBe(true)
    press(byTestId(out, 'short-make'))
    out = await settle(el(ShortVersionDialog, p))
    expect(fake.copies).toHaveLength(1)
    const copy = fake.copies[0].copy as unknown as Project
    expect(copy.name).toBe('Billing tour (60 s)')
    expect(copy.joins).toEqual({ all: { kind: 'smooth' }, auto: { by: 'short', was: null } })
    expect(copy.autoCuts!.every((c) => c.by === 'short')).toBe(true)
    expect(copy.captions!.show).toBe(true)
    expect(textOf(byTestId(out, 'short-made'))).toContain('Made “Billing tour (60 s)”.')
    press(button(out, 'Open the copy'))
    expect(opened).toEqual(['made-1'])
  })
  it('the dialog without captions says so and offers Make captions', async () => {
    const p = clipProject({ duration: 100 })
    editing(p)
    const out = await settle(el(ShortVersionDialog, p))
    expect(textOf(byTestId(out, 'short-line'))).toBe('Make captions first: a shorter version keeps the sentences you say.')
    expect(byTestId(out, 'short-make')!.props.disabled).toBe(true)
    press(button(out, 'Make captions'))
    expect(fake.commands).toEqual(['generateCaptions'])
    // Esc closes it, as Cancel does.
    modal.onClose!()
    expect(closes.length).toBe(2)
  })
})
