export interface DiagnosticsApi {
  /** Makes the diagnostics report (redacted); `id` names it for copyDiagnostics. */
  collectDiagnostics(): Promise<{ id: string; text: string }>
  /** Copies the report `id` (the one shown) to the clipboard; false when it is not the latest. */
  copyDiagnostics(id: string): Promise<boolean>
  /** Opens the folder of the app's log. */
  openLogFolder(): Promise<void>
}
