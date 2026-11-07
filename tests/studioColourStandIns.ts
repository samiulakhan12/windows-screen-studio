/*
 * Stand-ins for Captions Studio part P1's colors.ts (docs/design/captions-studio.md §14.1), kept
 * apart from studioStandIns.ts so a test can mock colors.ts with them without importing the caption
 * settings: those reach colors.ts again through the safe zones, the progress bar, title cards and
 * callouts (editing polish §8, §7.1), and a mock that imported them would wait on itself.
 */
import type { CaptionStudio, StudioTheme } from '../src/shared/types'

export const withTheme = (s: CaptionStudio, theme: StudioTheme): CaptionStudio => ({ ...s, theme: { ...s.theme, ...theme } })
export const brandTheme = (colors: readonly string[], s: CaptionStudio): { theme: StudioTheme; lightened: string[] } | null => (colors.length >= 2 ? { theme: { ...s.theme, spoken: colors[0], emphasis: colors[1] }, lightened: [] } : null)
// None on Chat, as colors.ts gives none where no two palette colours read on the look.
export const speakerColors = (s: CaptionStudio, n: number): string[] => (s.box.kind === 'chat' ? [] : ['#ffffff', '#5ce1e6', '#8be28b'].slice(0, n))
export const staticContrast = (s: CaptionStudio): { worst: number; colour: string; against: string } => ({ worst: s.edge.outline >= 0.04 ? 13.6 : 1.2, colour: s.theme.text, against: s.theme.outline })
export const contrastFix = (s: CaptionStudio): CaptionStudio => ({ ...s, edge: { ...s.edge, outline: Math.max(0.06, s.edge.outline), outlineAlpha: 1 } })
export const textOn = (): '#111111' => '#111111'
export const contrastRatio = (): number => 4.5
export const over = (c: string): string => c
export const measuredContrast = (): number => 4.5
