/**
 * Stable three-part version ordering for the market UI (cross-review P2-2).
 *
 * This mirrors the desktop boot side's advisory compare
 * (dsh-plugin-desktop/src/boot-update-prompt.ts): numeric `x.y.z`
 * comparison with a plain string-order fallback for anything that does not
 * parse, so the market update banner and the boot pending-update
 * notification can never disagree about whether pinned beats installed.
 * The market must not import desktop implementation modules (the
 * dependency-direction gate), so the compare lives here; the shared
 * principle is the boot side's "pinned lower than installed is an
 * alignment, not an update" — a roster machine leaving the beta overlay
 * (installed 0.4.184, stable re-pinned 0.4.183) must not be advertised a
 * downgrade as a "new" version.
 */

/**
 * Compare two version strings as stable `major.minor.patch` triples:
 * a positive number when `a > b`, negative when `a < b`, 0 on equality.
 * A pair that does not parse as a triple falls back to string order
 * rather than throwing — every consumer of this compare is advisory UI
 * gating (which rows deserve an update banner), never an enforcement
 * point, exactly like the boot side's classifier.
 */
export function compareStableVersions(a: string, b: string): number {
  const parse = (value: string): number[] | undefined => {
    const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
    return parts === null ? undefined : parts.slice(1).map(Number)
  }
  const va = parse(a)
  const vb = parse(b)
  if (va === undefined || vb === undefined) return a.localeCompare(b)
  for (let index = 0; index < 3; index += 1) {
    const da = va[index]
    const db = vb[index]
    if (da === undefined || db === undefined) return a.localeCompare(b)
    if (da !== db) return da - db
  }
  return 0
}
