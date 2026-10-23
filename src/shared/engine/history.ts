/**
 * Undo/redo stack for immutable values. Consecutive pushes with the same
 * `mergeKey` within `mergeWindowMs` (e.g. one slider drag) collapse into a
 * single undo step.
 */
export class History<T> {
  private past: T[] = []
  private future: T[] = []
  private lastKey: string | null = null
  private lastAt = 0

  constructor(
    private current: T,
    private readonly limit = 200,
    private readonly mergeWindowMs = 800
  ) {}

  get present(): T {
    return this.current
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  /** Records `next` as a new state. */
  push(next: T, mergeKey?: string, now = Date.now()): void {
    if (Object.is(next, this.current)) return
    const merge = mergeKey !== undefined && mergeKey === this.lastKey && now - this.lastAt <= this.mergeWindowMs
    if (!merge) {
      this.past.push(this.current)
      if (this.past.length > this.limit) this.past.shift()
    }
    this.current = next
    this.future = []
    this.lastKey = mergeKey ?? null
    this.lastAt = now
  }

  /** Replaces the present without creating an undo step (e.g. automatic corrections). */
  replace(next: T): void {
    this.current = next
  }

  /** Ends any merge run so the next push starts a new undo step. */
  seal(): void {
    this.lastKey = null
  }

  undo(): T | null {
    const prev = this.past.pop()
    if (prev === undefined) return null
    this.future.push(this.current)
    this.current = prev
    this.lastKey = null
    return prev
  }

  redo(): T | null {
    const next = this.future.pop()
    if (next === undefined) return null
    this.past.push(this.current)
    this.current = next
    this.lastKey = null
    return next
  }

  reset(value: T): void {
    this.past = []
    this.future = []
    this.current = value
    this.lastKey = null
  }
}
