/**
 * Canonical file documents for the native-ui windows.
 *
 * `webContents.loadFile(path, { query })` builds its URL from the raw
 * pathname, and in packaged Windows builds that non-canonical file URL
 * (native separators, unencoded spaces such as `DSH Desktop`) plus the query
 * is rejected by the main-frame loader — the #73 recovery-window DOA
 * (`ERR_FAILED (-2) loading 'file:///C:\...\DSH Desktop\...recovery.html?state=…'`,
 * electron/electron#39831 for the same class). Building the URL through
 * `pathToFileURL` percent-encodes the path and keeps the query on a valid
 * file URL, which loads identically on every platform and packaging shape.
 *
 * @module dsh-plugin-desktop/native-ui-document
 */

import { pathToFileURL } from 'node:url'

/**
 * Build the canonical loadURL target for one native-ui document.
 * @param documentPath - physical document path (unpacked mirror in packages).
 * @param query - optional query parameters, encoded in order of entry.
 * @returns the percent-encoded file URL with its query.
 */
export function nativeUiDocumentUrl(documentPath: string, query?: Readonly<Record<string, string>>): string {
  const url = pathToFileURL(documentPath)
  if (query !== undefined) {
    const search = new URLSearchParams()
    for (const [name, value] of Object.entries(query)) search.set(name, value)
    url.search = search.toString()
  }
  return url.href
}
