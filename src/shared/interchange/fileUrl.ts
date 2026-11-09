/**
 * Paths and text inside timeline files (docs/design/output-and-languages.md §8.6, §18.3): file URLs
 * percent-encoded with the drive letter kept, XML text and attributes escaped with the characters
 * XML 1.0 forbids dropped, ASCII names for EDL. Pure. Part P4 writes it.
 */

/** A Windows path as a file URL: 'file:///C:/…' for FCPXML, 'file://localhost/C:/…' for Premiere XML. Part P4. */
export function fileUrl(windowsPath: string, form: 'fcpxml' | 'xmeml'): string {
  void windowsPath
  void form
  return ''
}

/** Text for an XML element. Part P4. */
export function xmlText(s: string): string {
  void s
  return ''
}

/** Text for an XML attribute (newlines as &#10;). Part P4. */
export function xmlAttr(s: string): string {
  void s
  return ''
}

/** A name in printable ASCII, else `fallback`. Part P4. */
export function asciiName(s: string, fallback: string): string {
  void s
  return fallback
}
