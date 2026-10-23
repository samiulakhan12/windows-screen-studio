import { describe, expect, it } from 'vitest'
import { History } from '../src/shared/engine/history'

describe('History', () => {
  it('undoes and redoes', () => {
    const h = new History(1)
    h.push(2, undefined, 0)
    h.push(3, undefined, 10)
    expect(h.undo()).toBe(2)
    expect(h.undo()).toBe(1)
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBe(2)
    expect(h.present).toBe(2)
  })

  it('merges pushes with the same key inside the window', () => {
    const h = new History(0)
    h.push(1, 'slider', 0)
    h.push(2, 'slider', 100)
    h.push(3, 'slider', 200)
    expect(h.undo()).toBe(0)
    h.push(5, 'slider', 300)
    h.push(6, 'slider', 2000) // outside window -> new step
    expect(h.undo()).toBe(5)
  })

  it('clears redo on a new push, and replace() adds no step', () => {
    const h = new History('a')
    h.push('b', undefined, 0)
    h.undo()
    h.push('c', undefined, 1)
    expect(h.canRedo).toBe(false)
    h.replace('d')
    expect(h.undo()).toBe('a')
  })

  it('caps history length', () => {
    const h = new History(0, 3)
    for (let i = 1; i <= 10; i++) h.push(i, undefined, i * 1000)
    let n = 0
    while (h.undo() !== null) n++
    expect(n).toBe(3)
  })
})
