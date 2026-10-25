/** What the About section shows, from the main process. */
export interface AppInfo {
  name: string
  version: string
}

export interface BrandApi {
  /** The app's name and version (app.getVersion()). */
  getAppInfo(): Promise<AppInfo>
  /** Opens qbexel.com in the default browser. It takes no address: the main process opens only that one. */
  openCompanyWebsite(): Promise<void>
}
