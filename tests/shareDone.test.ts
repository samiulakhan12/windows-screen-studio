import { describe, expect, it } from 'vitest'
import type { ShareRunView } from '../src/shared/api/share'
import { retryTargets, stepText } from '../src/shared/share/steps'

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

  it('says each step plainly', () => {
    expect(stepText({ ...run.steps[0], state: 'running', fraction: 0.425 })).toBe('Copying to OneDrive… 42%')
    expect(stepText({ ...run.steps[0], state: 'done', message: undefined })).toBe('Saved to OneDrive › Flown')
    expect(stepText(run.steps[0])).toBe('Could not copy to OneDrive: The drive of OneDrive is full.')
    expect(stepText({ ...run.steps[1], state: 'done' })).toBe('Posted to #demos')
  })
})
