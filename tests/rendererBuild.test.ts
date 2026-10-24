import { describe, expect, it } from 'vitest'
import config from '../electron.vite.config'

describe('renderer build (F8)', () => {
  it('minifies the renderer bundle (electron-vite leaves it unminified by default)', () => {
    const renderer = (config as { renderer?: { build?: { minify?: unknown } } }).renderer
    expect(renderer?.build?.minify).toBe(true)
  })
})
