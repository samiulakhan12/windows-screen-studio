export interface GradientPreset {
  id: string
  name: string
  angle: number
  stops: string[]
}

export const GRADIENTS: GradientPreset[] = [
  { id: 'aurora', name: 'Aurora', angle: 135, stops: ['#5b21b6', '#db2777', '#f59e0b'] },
  { id: 'ocean', name: 'Ocean', angle: 135, stops: ['#0ea5e9', '#2563eb', '#1e1b4b'] },
  { id: 'mint', name: 'Mint', angle: 120, stops: ['#34d399', '#06b6d4', '#3b82f6'] },
  { id: 'sunset', name: 'Sunset', angle: 160, stops: ['#f97316', '#ef4444', '#7c3aed'] },
  { id: 'peach', name: 'Peach', angle: 135, stops: ['#fde68a', '#fca5a5', '#f472b6'] },
  { id: 'midnight', name: 'Midnight', angle: 145, stops: ['#0f172a', '#1e293b', '#334155'] },
  { id: 'forest', name: 'Forest', angle: 135, stops: ['#14532d', '#15803d', '#a3e635'] },
  { id: 'candy', name: 'Candy', angle: 120, stops: ['#a855f7', '#ec4899', '#fb7185'] },
  { id: 'steel', name: 'Steel', angle: 135, stops: ['#e2e8f0', '#94a3b8', '#475569'] },
  { id: 'lava', name: 'Lava', angle: 135, stops: ['#450a0a', '#b91c1c', '#fb923c'] }
]

export const gradientById = (id: string): GradientPreset => GRADIENTS.find((g) => g.id === id) ?? GRADIENTS[0]

export const gradientCss = (g: GradientPreset): string => `linear-gradient(${g.angle}deg, ${g.stops.join(', ')})`
