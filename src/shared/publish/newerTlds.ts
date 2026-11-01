/**
 * Top-level domains IANA has delegated that twitter-text 3.1.0's lists (tlds.ts) do not have:
 * the names in IANA's list (https://data.iana.org/TLD/tlds-alpha-by-domain.txt, version
 * 2026103100), written as Unicode, less those of tlds.ts. X does not link a name on them, but sites
 * with a newer list do ("paypal-secure.web/login"), so the copy pack's cleaning reads them as links
 * too (twitterText.ts, `findUrls` with `lenient`; docs/design/publish-pack.md §4.4). Data only.
 */

/** Generic top-level domains, separated by "|". */
export const NEWER_GENERIC_TLDS = 'amazon|kids|merck|music|spa|web|アマゾン|亚马逊'

/** Country top-level domains, separated by "|". */
export const NEWER_COUNTRY_TLDS = 'ישראל'
