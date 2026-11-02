import { describe, expect, it } from 'vitest'
import type { ShareRunView } from '../src/shared/api/share'
import { cancelName, retryTargets, stepButtonName, stepText, type StepButton } from '../src/shared/share/steps'

describe('the done view', () => {
  const run: ShareRunView = {
    id: 'r',
    file: 'C:\\x.mp4',
    finished: true,
    steps: [
      { target: 'cf0000000001', kind: 'copy', service: 'onedrive', label: 'OneDrive', state: 'failed', message: 'The drive of OneDrive is full.' },
      { target: 'whkchat', kind: 'post', service: 'slack', label: '#demos', state: 'failed', message: 'Not posted: the copy failed.' }
    ]
  }

  it('tries a post held back by a failed copy again together with that copy', () => {
    expect(retryTargets(run, run.steps[1])).toEqual(['cf0000000001', 'whkchat'])
    expect(retryTargets(run, run.steps[0])).toEqual(['cf0000000001'])
    expect(retryTargets(run, { ...run.steps[1], message: 'Slack is busy.' })).toEqual(['whkchat'])
  })

  it('does not copy again when the held copy has been saved since', () => {
    const saved = { ...run.steps[0], state: 'done' as const, message: undefined, dest: 'C:\\OneDrive\\Flown\\x.mp4' }
    expect(retryTargets(run, run.steps[1], [saved, run.steps[1]])).toEqual(['whkchat'])
    // Still not saved (failed again, or cancelled): it goes with the post.
    expect(retryTargets(run, run.steps[1], [{ ...saved, state: 'cancelled' }, run.steps[1]])).toEqual(['cf0000000001', 'whkchat'])
  })

  it('names each button with its visible words first, then where it acts', () => {
    // WCAG 2.5.3: "click Show in folder" must find the copy's button, not only the export's.
    const saved = { ...run.steps[0], state: 'done' as const, dest: 'C:\\OneDrive\\Flown\\x.mp4', link: 'https://example.com/x' }
    for (const button of ['Try again', 'Show in folder', 'Copy link'] as StepButton[]) {
      const name = stepButtonName(button, saved)
      expect(name.startsWith(`${button}:`)).toBe(true)
      expect(name).toContain('OneDrive')
    }
    expect(stepButtonName('Try again', run.steps[1])).toBe('Try again: post to #demos')
    const going: ShareRunView = { ...run, finished: false, steps: [{ ...run.steps[0], state: 'running' }, { ...run.steps[1], state: 'waiting' }] }
    expect(cancelName(going)).toBe('Cancel share: OneDrive and #demos')
    expect(cancelName({ ...going, steps: [{ ...run.steps[0], state: 'done' }] })).toBe('Cancel share')
  })

  it('says each step plainly', () => {
    expect(stepText({ ...run.steps[0], state: 'running', fraction: 0.425 })).toBe('Copying to OneDrive… 42%')
    expect(stepText({ ...run.steps[0], state: 'done', message: undefined })).toBe('Saved to OneDrive › Flown')
    expect(stepText(run.steps[0])).toBe('Could not copy to OneDrive: The drive of OneDrive is full.')
    expect(stepText({ ...run.steps[1], state: 'done' })).toBe('Posted to #demos')
  })
})
