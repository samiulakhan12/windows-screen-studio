/**
 * The price list in main (docs/design/smart-tools.md §11.4): the bundled list and the last one
 * downloaded, refreshed at most daily while automatic updates are on. Part P5 writes the refresh;
 * the contracts' stub uses the bundled list, and gives the list's address with its test hook (§22
 * test 104): SSW_PRICE_LIST_URL is read only when the app is not packaged.
 */
import { app } from 'electron'
import { BUNDLED_PRICE_LIST, PRICE_LIST_URL, type PriceList } from '../../shared/ai/prices'

/** What the line shows (the newer list) and what a confirm uses (the higher prices). */
export function priceList(): { shown: PriceList; confirm: PriceList } {
  return { shown: BUNDLED_PRICE_LIST, confirm: BUNDLED_PRICE_LIST }
}

export async function refreshPriceList(opts: { fetch?: typeof fetch; now?: number; updatesOn: boolean }): Promise<PriceList> {
  void opts
  return BUNDLED_PRICE_LIST
}

/** Where the list is refreshed from: GitHub; SSW_PRICE_LIST_URL instead only when the app is not packaged. */
export function priceListUrl(): string {
  return !app.isPackaged && process.env.SSW_PRICE_LIST_URL ? process.env.SSW_PRICE_LIST_URL : PRICE_LIST_URL
}
