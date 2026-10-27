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
  /**
   * The third-party notices shipped with the app (resources/THIRD_PARTY_NOTICES.txt), as text. It
   * takes no path: the main process reads only that one file. Rejects when it is missing.
   */
  getThirdPartyNotices(): Promise<string>
}
