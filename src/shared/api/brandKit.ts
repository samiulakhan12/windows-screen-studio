import type { BrandFiles, BrandKit } from '../editor/brandKit'
import type { ProjectFont } from '../types'

/** The saved brand kit and where its files went when copied into a project. */
export interface BrandKitFiles {
  kit: BrandKit
  files: BrandFiles
}

/** Settings › Brand kit, and applying it in the editor (docs/design/brand-kit.md). */
export interface BrandKitApi {
  /** The saved kit (an empty one when none is saved). */
  getBrandKit(): Promise<BrandKit>
  /** Saves the kit and returns what was stored (sanitised; files it no longer names are removed). */
  saveBrandKit(kit: BrandKit): Promise<BrandKit>
  /**
   * Lets the user pick a logo or font file and copies it into the kit's folder; null when
   * cancelled. Rejects with a readable message for an unsupported or oversized file. The kit is
   * not changed until it is saved naming the file.
   */
  pickBrandFile(kind: 'logo' | 'font'): Promise<{ file: string; font?: ProjectFont } | null>
  /** The bytes of a file of the kit's folder, for the previews in Settings; null when missing. */
  brandFile(file: string): Promise<Uint8Array | null>
  /** Copies the kit's logo and fonts into the project and returns the kit with where they went. */
  copyBrandKitInto(projectId: string): Promise<BrandKitFiles>
}
