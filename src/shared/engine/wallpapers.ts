import { fillLinear, rgba, softBlob, type Draw2D } from './draw2d'

/**
 * Built-in wallpapers, generated with canvas drawing calls (no image files). Every position
 * and size is a fraction of the frame, and nothing is random at draw time (stars use a fixed
 * seed), so the preview and the export draw the same picture at any size.
 */
export interface Wallpaper {
  id: string
  name: string
  /** Mostly dark (light text and chrome read well on it). */
  dark: boolean
  draw(ctx: Draw2D, w: number, h: number): void
}

type BlobSpec = [x: number, y: number, r: number, color: string, alpha: number]

const blobs = (ctx: Draw2D, w: number, h: number, list: BlobSpec[]): void => {
  for (const [x, y, r, color, alpha] of list) softBlob(ctx, w, h, x, y, r, color, alpha)
}

/** Small deterministic PRNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Wave {
  /** Mean height of the crest (fraction of the frame). */
  y: number
  amp: number
  /** Waves across the frame. */
  freq: number
  phase: number
  color: string
  alpha?: number
}

/** Filled bands with a wavy top edge, back to front. */
function waves(ctx: Draw2D, w: number, h: number, layers: Wave[], second = 0.35): void {
  const steps = 64
  for (const l of layers) {
    ctx.beginPath()
    ctx.moveTo(0, h)
    for (let i = 0; i <= steps; i++) {
      const x = i / steps
      const y = l.y + l.amp * (Math.sin(2 * Math.PI * (l.freq * x + l.phase)) + second * Math.sin(2 * Math.PI * (l.freq * 2.3 * x + l.phase * 1.7)))
      ctx.lineTo(x * w, y * h)
    }
    ctx.lineTo(w, h)
    ctx.closePath()
    const g = ctx.createLinearGradient(0, (l.y - l.amp) * h, 0, h)
    g.addColorStop(0, rgba(l.color, l.alpha ?? 1))
    g.addColorStop(1, rgba(l.color, (l.alpha ?? 1) * 0.75))
    ctx.fillStyle = g
    ctx.fill()
  }
}

/** A soft elongated glow, rotated by `angle` radians (for aurora ribbons). */
function ribbonGlow(ctx: Draw2D, w: number, h: number, x: number, y: number, len: number, thick: number, angle: number, color: string, alpha: number): void {
  const s = Math.max(w, h)
  ctx.save()
  ctx.translate(x * w, y * h)
  ctx.rotate(angle)
  ctx.scale(len / thick, 1)
  const r = thick * s
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
  g.addColorStop(0, rgba(color, alpha))
  g.addColorStop(0.45, rgba(color, alpha * 0.45))
  g.addColorStop(1, rgba(color, 0))
  ctx.fillStyle = g
  ctx.fillRect(-r, -r, r * 2, r * 2)
  ctx.restore()
}

export const WALLPAPERS: Wallpaper[] = [
  {
    id: 'violet-mesh',
    name: 'Violet mesh',
    dark: true,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 135, ['#1e1b4b', '#312e81'])
      blobs(ctx, w, h, [
        [0.12, 0.18, 0.55, '#7c3aed', 0.95],
        [0.88, 0.12, 0.48, '#db2777', 0.8],
        [0.78, 0.95, 0.6, '#2563eb', 0.85],
        [0.08, 0.98, 0.4, '#f59e0b', 0.55]
      ])
    }
  },
  {
    id: 'peach-mesh',
    name: 'Peach',
    dark: false,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 135, ['#fff1f2', '#fef3c7'])
      blobs(ctx, w, h, [
        [0.08, 0.1, 0.5, '#fb7185', 0.75],
        [0.92, 0.18, 0.45, '#fbbf24', 0.75],
        [0.82, 0.92, 0.55, '#c084fc', 0.65],
        [0.18, 0.88, 0.42, '#f9a8d4', 0.8]
      ])
    }
  },
  {
    id: 'lagoon',
    name: 'Lagoon',
    dark: true,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 160, ['#083344', '#0c4a6e'])
      blobs(ctx, w, h, [
        [0.15, 0.25, 0.5, '#22d3ee', 0.75],
        [0.85, 0.2, 0.45, '#2dd4bf', 0.6],
        [0.7, 0.95, 0.55, '#1d4ed8', 0.85],
        [0.2, 0.9, 0.38, '#34d399', 0.55]
      ])
    }
  },
  {
    id: 'sunset-blobs',
    name: 'Sunset',
    dark: true,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 160, ['#7c2d12', '#9d174d'])
      blobs(ctx, w, h, [
        [0.2, 0.25, 0.5, '#fb923c', 0.9],
        [0.82, 0.3, 0.45, '#f472b6', 0.8],
        [0.5, 0.98, 0.38, '#fde047', 0.6],
        [0.98, 0.95, 0.42, '#7c3aed', 0.8]
      ])
    }
  },
  {
    id: 'mint',
    name: 'Mint',
    dark: false,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 135, ['#ecfdf5', '#e0f2fe'])
      blobs(ctx, w, h, [
        [0.1, 0.15, 0.48, '#6ee7b7', 0.75],
        [0.9, 0.12, 0.45, '#93c5fd', 0.7],
        [0.85, 0.9, 0.5, '#c4b5fd', 0.7],
        [0.15, 0.92, 0.4, '#a7f3d0', 0.8]
      ])
    }
  },
  {
    id: 'midnight-glow',
    name: 'Midnight glow',
    dark: true,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 180, ['#020617', '#0f172a'])
      blobs(ctx, w, h, [
        [0.5, 1.08, 0.55, '#7c3aed', 0.85],
        [0.92, -0.02, 0.42, '#2563eb', 0.6],
        [0.04, 0.3, 0.28, '#0ea5e9', 0.35]
      ])
    }
  },
  {
    id: 'blue-waves',
    name: 'Blue waves',
    dark: true,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 180, ['#0b1d4d', '#1e3a8a'])
      softBlob(ctx, w, h, 0.8, 0.15, 0.35, '#60a5fa', 0.35)
      waves(ctx, w, h, [
        { y: 0.46, amp: 0.05, freq: 0.9, phase: 0.1, color: '#1d4ed8', alpha: 0.75 },
        { y: 0.58, amp: 0.045, freq: 1.1, phase: 0.45, color: '#2563eb', alpha: 0.8 },
        { y: 0.7, amp: 0.04, freq: 0.8, phase: 0.8, color: '#3b82f6', alpha: 0.85 },
        { y: 0.83, amp: 0.035, freq: 1.3, phase: 0.25, color: '#60a5fa', alpha: 0.9 }
      ])
    }
  },
  {
    id: 'dusk-waves',
    name: 'Dusk',
    dark: true,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 180, ['#1e1b4b', '#831843'])
      softBlob(ctx, w, h, 0.3, 0.32, 0.22, '#fbbf24', 0.55)
      waves(ctx, w, h, [
        { y: 0.5, amp: 0.05, freq: 0.7, phase: 0.6, color: '#4c1d95', alpha: 0.85 },
        { y: 0.62, amp: 0.045, freq: 1, phase: 0.15, color: '#9d174d', alpha: 0.85 },
        { y: 0.74, amp: 0.04, freq: 0.85, phase: 0.4, color: '#ea580c', alpha: 0.85 },
        { y: 0.86, amp: 0.03, freq: 1.2, phase: 0.7, color: '#fbbf24', alpha: 0.9 }
      ])
    }
  },
  {
    id: 'dunes',
    name: 'Dunes',
    dark: false,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 180, ['#fde68a', '#fdba74'])
      softBlob(ctx, w, h, 0.74, 0.3, 0.16, '#fff7ed', 0.95)
      waves(
        ctx,
        w,
        h,
        [
          { y: 0.55, amp: 0.06, freq: 0.45, phase: 0.2, color: '#f59e0b' },
          { y: 0.66, amp: 0.05, freq: 0.6, phase: 0.55, color: '#d97706' },
          { y: 0.77, amp: 0.045, freq: 0.5, phase: 0.05, color: '#b45309' },
          { y: 0.88, amp: 0.035, freq: 0.7, phase: 0.4, color: '#78350f' }
        ],
        0.2
      )
    }
  },
  {
    id: 'northern-lights',
    name: 'Northern lights',
    dark: true,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 180, ['#020617', '#0b1120'])
      // Stars: fixed seed, so every render places them identically.
      const rnd = seeded(7)
      const m = Math.min(w, h)
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      for (let i = 0; i < 70; i++) {
        const x = rnd() * w
        const y = rnd() * h * 0.75
        const r = (0.0008 + rnd() * 0.0016) * m
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ribbonGlow(ctx, w, h, 0.3, 0.42, 0.6, 0.09, -0.35, '#22c55e', 0.7)
      ribbonGlow(ctx, w, h, 0.62, 0.32, 0.55, 0.08, -0.15, '#14b8a6', 0.6)
      ribbonGlow(ctx, w, h, 0.75, 0.5, 0.5, 0.07, -0.45, '#8b5cf6', 0.5)
      softBlob(ctx, w, h, 0.5, 1.1, 0.5, '#0f766e', 0.45)
    }
  },
  {
    id: 'orbit',
    name: 'Orbit',
    dark: true,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 135, ['#0b1020', '#111827'])
      softBlob(ctx, w, h, 0.85, 0.85, 0.5, '#4f46e5', 0.7)
      softBlob(ctx, w, h, 0.1, 0.1, 0.3, '#0ea5e9', 0.3)
      const s = Math.max(w, h)
      ctx.lineWidth = Math.max(1, 0.0016 * Math.min(w, h))
      for (let i = 1; i <= 10; i++) {
        ctx.strokeStyle = `rgba(165,180,252,${(0.32 - i * 0.022).toFixed(3)})`
        ctx.beginPath()
        ctx.arc(0.85 * w, 0.85 * h, i * 0.1 * s, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
  },
  {
    id: 'ribbons',
    name: 'Ribbons',
    dark: false,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 135, ['#f5f3ff', '#fdf2f8'])
      const colors = ['#c4b5fd', '#f9a8d4', '#93c5fd', '#fcd34d', '#a7f3d0']
      const s = Math.max(w, h)
      ctx.save()
      ctx.translate(w / 2, h / 2)
      ctx.rotate(-0.5)
      colors.forEach((c, i) => {
        const y = (i - 2) * 0.17 * s
        const band = 0.09 * s
        const g = ctx.createLinearGradient(-s, 0, s, 0)
        g.addColorStop(0, rgba(c, 0))
        g.addColorStop(0.5, rgba(c, 0.7))
        g.addColorStop(1, rgba(c, 0.15))
        ctx.fillStyle = g
        ctx.fillRect(-s, y - band / 2, s * 2, band)
      })
      ctx.restore()
    }
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    dark: true,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 160, ['#0c1a3a', '#0f2a5a'])
      softBlob(ctx, w, h, 0.5, 0.5, 0.45, '#2563eb', 0.35)
      const m = Math.min(w, h)
      const cell = 0.045 * m
      ctx.lineWidth = Math.max(1, 0.0012 * m)
      const lines = (major: boolean): void => {
        ctx.strokeStyle = major ? 'rgba(147,197,253,0.2)' : 'rgba(147,197,253,0.09)'
        ctx.beginPath()
        // From the centre out, so the grid is symmetric at any size.
        const nx = Math.ceil(w / 2 / cell)
        const ny = Math.ceil(h / 2 / cell)
        for (let i = -nx; i <= nx; i++) {
          if ((i % 4 === 0) !== major) continue
          ctx.moveTo(w / 2 + i * cell, 0)
          ctx.lineTo(w / 2 + i * cell, h)
        }
        for (let j = -ny; j <= ny; j++) {
          if ((j % 4 === 0) !== major) continue
          ctx.moveTo(0, h / 2 + j * cell)
          ctx.lineTo(w, h / 2 + j * cell)
        }
        ctx.stroke()
      }
      lines(false)
      lines(true)
    }
  },
  {
    id: 'graphite',
    name: 'Graphite',
    dark: true,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 135, ['#18181b', '#3f3f46'])
      blobs(ctx, w, h, [
        [0.15, 0.15, 0.5, '#71717a', 0.45],
        [0.85, 0.85, 0.6, '#09090b', 0.7],
        [0.75, 0.2, 0.3, '#a1a1aa', 0.2]
      ])
    }
  },
  {
    id: 'candy-pop',
    name: 'Candy pop',
    dark: false,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 135, ['#f0abfc', '#a5b4fc'])
      blobs(ctx, w, h, [
        [0.15, 0.85, 0.5, '#f472b6', 0.8],
        [0.85, 0.15, 0.45, '#818cf8', 0.8],
        [0.6, 0.55, 0.3, '#fde68a', 0.5]
      ])
    }
  },
  {
    id: 'forest',
    name: 'Forest',
    dark: true,
    draw(ctx, w, h) {
      fillLinear(ctx, w, h, 150, ['#052e16', '#14532d'])
      blobs(ctx, w, h, [
        [0.2, 0.2, 0.5, '#16a34a', 0.6],
        [0.85, 0.3, 0.42, '#65a30d', 0.5],
        [0.6, 0.95, 0.5, '#0d9488', 0.6]
      ])
    }
  }
]

export const wallpaperById = (id: string): Wallpaper | undefined => WALLPAPERS.find((w) => w.id === id)

/** Paints wallpaper `id` over the frame (the first wallpaper when the id is unknown). */
export function drawWallpaper(ctx: Draw2D, w: number, h: number, id: string): void {
  ;(wallpaperById(id) ?? WALLPAPERS[0]).draw(ctx, w, h)
}
