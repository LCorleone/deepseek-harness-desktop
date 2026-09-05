/**
 * Minimal SemVer range → interval arithmetic (the handoff compat check).
 *
 * The handoff contract needs exactly one question answered mechanically:
 * does the submitter's tested runtime range (`compat.dshRuntimeVersion`)
 * share at least one version with the owner-pinned range (compat.json
 * `dsh.runtimeRange`)? The pinned ranges in play are caret ranges and exact
 * versions, so this module implements that grammar by hand — no dependency,
 * and anything outside the implemented grammar fails loudly instead of being
 * guessed at (a compatibility claim that cannot be parsed must never pass).
 *
 * Semantics: each range is a union (`||` alternatives) of comparator sets;
 * each set folds into one interval over the semver ordering (with exclusive
 * bounds where `<`/`>` demand them); two ranges intersect when some interval
 * of one overlaps some interval of the other. Interval arithmetic is
 * deliberately slightly more permissive than node-semver's prerelease
 * opt-in rule (node-semver excludes prereleases from a range unless a
 * comparator shares their [major,minor,patch] tuple; here `^0.1.1` and
 * `0.1.2-rc.1` intersect). For a compatibility declaration that trade is
 * right: the check exists to catch "tested against a different world", not
 * to re-implement npm resolution.
 */

/** Parse a strict `X.Y.Z` semver (optional `v` prefix, prerelease, build metadata). */
export function parseSemver(text) {
  if (typeof text !== 'string') throw new Error('a version must be a string')
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(text.trim())
  if (match === null) throw new Error(`'${text}' is not a strict X.Y.Z semver (prerelease -rc.1 and build +meta allowed)`)
  const prerelease = match[4] === undefined ? [] : match[4].split('.').map((identifier) => (/^\d+$/u.test(identifier) ? Number.parseInt(identifier, 10) : identifier))
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease,
  }
}

/** Semver precedence comparison (build metadata ignored per spec §10). */
export function compareSemver(a, b) {
  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1
  }
  const ap = a.prerelease
  const bp = b.prerelease
  if (ap.length === 0 && bp.length === 0) return 0
  // A release outranks any of its prereleases.
  if (ap.length === 0) return 1
  if (bp.length === 0) return -1
  for (let index = 0; index < Math.max(ap.length, bp.length); index += 1) {
    const left = ap[index]
    const right = bp[index]
    if (left === undefined) return -1 // shorter identifier list is lower
    if (right === undefined) return 1
    if (left === right) continue
    if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1
    if (typeof left === 'number') return -1 // numeric identifiers rank below alphanumeric
    if (typeof right === 'number') return 1
    return left < right ? -1 : 1
  }
  return 0
}

const plain = (major, minor, patch) => ({ major, minor, patch, prerelease: [] })

/**
 * Parse one (possibly partial or wildcarded) version body: `1`, `1.2`,
 * `1.2.3`, `1.x`, `1.2.x`, `1.2.3-rc.1`. Returns
 * `{major, minor?, patch?, prerelease}` — missing slots are undefined and
 * wildcard slots read as missing.
 */
function parsePartial(text) {
  const match = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(text)
  if (match === null) throw new Error(`'${text}' is not a version the range grammar understands (X, X.Y, X.Y.Z, wildcards x/*, optional prerelease)`)
  const slot = (raw) => (raw === undefined || /^[xX*]$/u.test(raw) ? undefined : Number.parseInt(raw, 10))
  const prerelease = match[4] === undefined ? [] : match[4].split('.').map((identifier) => (/^\d+$/u.test(identifier) ? Number.parseInt(identifier, 10) : identifier))
  return { major: slot(match[1]), minor: slot(match[2]), patch: slot(match[3]), prerelease }
}

const isAnyWildcard = (partial) => partial.major === undefined

/** Fill missing slots with zeros (the lower-bound reading of a partial). */
const filledLower = (partial) => plain(partial.major ?? 0, partial.minor ?? 0, partial.patch ?? 0)

/**
 * Parse a range into OR-alternatives of AND-comparator lists:
 * `[{comparators: [{op: '>=' | '>' | '<' | '<=' | '=', version}]}]`.
 * Supported grammar: `*`/`x`, exact, `^`, `~`, the four comparators with
 * partial versions, whitespace-separated AND sets, `||` alternatives, and
 * `A - B` hyphen ranges. Everything else throws naming the token.
 */
export function parseVersionRange(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('a version range must be a non-empty string')
  const alternatives = text.split(/\s*\|\|\s*/u).map((alternative) => alternative.trim())
  if (alternatives.some((alternative) => alternative === '')) {
    throw new Error(`the range '${text}' carries an empty '||' alternative`)
  }
  return alternatives.map((alternative) => parseAlternative(alternative, text))
}

function parseAlternative(alternative, wholeRange) {
  if (/ - /u.test(alternative)) {
    const sides = alternative.split(' - ')
    if (sides.length !== 2 || sides.some((side) => /\s/u.test(side))) {
      throw new Error(`the hyphen range '${alternative}' (in '${wholeRange}') must be exactly '<version> - <version>'`)
    }
    const lower = parsePartial(sides[0])
    const upper = parsePartial(sides[1])
    const comparators = [{ op: '>=', version: withPrerelease(filledLower(lower), lower.prerelease) }]
    // Hyphen upper ends are inclusive; a partial upper extends to the end of
    // its span (`1.2.3 - 2.3` covers through 2.3.x) so it becomes an
    // exclusive bound at the next slot up.
    if (upper.major === undefined) return comparators
    if (upper.minor === undefined) return [...comparators, { op: '<', version: plain(upper.major + 1, 0, 0) }]
    if (upper.patch === undefined) return [...comparators, { op: '<', version: plain(upper.major, upper.minor + 1, 0) }]
    return [...comparators, { op: '<=', version: withPrerelease(upper, upper.prerelease) }]
  }
  // node-semver tolerates whitespace between an operator and its version
  // (`>= 1.2.3`); collapse it before the whitespace split so submitter
  // spellings do not fail on cosmetics.
  const normalized = alternative.replace(/(\^|~|>=|<=|>|<|=)\s+/gu, '$1')
  const comparators = []
  for (const token of normalized.split(/\s+/u)) {
    if (token === '') continue
    comparators.push(...parseComparator(token, wholeRange))
  }
  if (comparators.length === 0 && !/^(?:\*|x|X)$/u.test(normalized)) {
    throw new Error(`the range alternative '${alternative}' (in '${wholeRange}') carries no comparator`)
  }
  return comparators
}

const withPrerelease = (base, prerelease) => ({ major: base.major, minor: base.minor, patch: base.patch, prerelease })

function parseComparator(token, wholeRange) {
  if (/^(?:\*|x|X)$/.test(token)) return []
  const operator = /^(\^|~|>=|<=|>|<|=)?(.*)$/u.exec(token)
  const op = operator[1] ?? '='
  const body = operator[2]
  if (body === '') throw new Error(`the token '${token}' (in '${wholeRange}') is not a comparator the range grammar understands`)
  const partial = parsePartial(body)
  if (isAnyWildcard(partial)) {
    if (op !== '=') throw new Error(`the token '${token}' (in '${wholeRange}') cannot compare against a bare wildcard`)
    return [] // `= *` — any version
  }
  if (op === '=' ) {
    if (partial.minor === undefined) return [{ op: '>=', version: plain(partial.major, 0, 0) }, { op: '<', version: plain(partial.major + 1, 0, 0) }]
    if (partial.patch === undefined) return [{ op: '>=', version: plain(partial.major, partial.minor, 0) }, { op: '<', version: plain(partial.major, partial.minor + 1, 0) }]
    return [{ op: '=', version: withPrerelease(partial, partial.prerelease) }]
  }
  if (op === '^') return caretComparators(partial)
  if (op === '~') return tildeComparators(partial)
  // >, >=, <, <= with a partial body: missing slots read as zeros.
  return [{ op, version: withPrerelease(filledLower(partial), partial.prerelease) }]
}

/** `^X.Y.Z`: everything within the leftmost nonzero slot (node-semver rules). */
function caretComparators(partial) {
  const lower = withPrerelease(filledLower(partial), partial.prerelease)
  if (partial.minor === undefined) {
    return [{ op: '>=', version: lower }, { op: '<', version: plain(partial.major + 1, 0, 0) }]
  }
  if (partial.patch === undefined) {
    if (partial.major > 0) return [{ op: '>=', version: lower }, { op: '<', version: plain(partial.major + 1, 0, 0) }]
    return [{ op: '>=', version: lower }, { op: '<', version: plain(0, partial.minor + 1, 0) }]
  }
  if (partial.major > 0) return [{ op: '>=', version: lower }, { op: '<', version: plain(partial.major + 1, 0, 0) }]
  if (partial.minor > 0) return [{ op: '>=', version: lower }, { op: '<', version: plain(0, partial.minor + 1, 0) }]
  return [{ op: '>=', version: lower }, { op: '<', version: plain(0, 0, partial.patch + 1) }]
}

/** `~X.Y.Z`: patch-level changes only (`~1` spans minors like `^1`). */
function tildeComparators(partial) {
  const lower = withPrerelease(filledLower(partial), partial.prerelease)
  if (partial.minor === undefined) return [{ op: '>=', version: lower }, { op: '<', version: plain(partial.major + 1, 0, 0) }]
  return [{ op: '>=', version: lower }, { op: '<', version: plain(partial.major, partial.minor + 1, 0) }]
}

/** The tighter of two lower bounds (undefined = unbounded below). */
function tighterLower(a, b) {
  if (a === undefined) return b
  if (b === undefined) return a
  const comparison = compareSemver(a.version, b.version)
  if (comparison > 0) return a
  if (comparison < 0) return b
  return a.exclusive || b.exclusive ? { version: a.version, exclusive: true } : a
}

/** The tighter of two upper bounds (undefined = unbounded above). */
function tighterUpper(a, b) {
  if (a === undefined) return b
  if (b === undefined) return a
  const comparison = compareSemver(a.version, b.version)
  if (comparison < 0) return a
  if (comparison > 0) return b
  return a.exclusive || b.exclusive ? { version: a.version, exclusive: true } : a
}

/**
 * Normalize a range into its non-empty intervals over the semver ordering:
 * `[{lo: {version, exclusive} | undefined, hi: {version, exclusive} | undefined}]`.
 * Comparator sets that fold to nothing (e.g. `>=2 <1`) contribute no
 * interval; an empty result array means the range matches no version.
 */
export function rangeIntervals(text) {
  const intervals = []
  for (const comparators of parseVersionRange(text)) {
    let lo
    let hi
    for (const { op, version } of comparators) {
      if (op === '>=' || op === '>') {
        lo = tighterLower(lo, { version, exclusive: op === '>' })
      } else if (op === '<=' || op === '<') {
        hi = tighterUpper(hi, { version, exclusive: op === '<' })
      } else {
        lo = tighterLower(lo, { version, exclusive: false })
        hi = tighterUpper(hi, { version, exclusive: false })
      }
    }
    if (lo !== undefined && hi !== undefined) {
      const comparison = compareSemver(lo.version, hi.version)
      if (comparison > 0 || (comparison === 0 && (lo.exclusive || hi.exclusive))) continue
    }
    intervals.push({ ...(lo === undefined ? {} : { lo }), ...(hi === undefined ? {} : { hi }) })
  }
  return intervals
}

/**
 * Do the two ranges share at least one version? (The handoff compat
 * question.) Throws on grammar outside the supported set — never guesses.
 */
export function rangesIntersect(left, right) {
  const leftIntervals = rangeIntervals(left)
  const rightIntervals = rangeIntervals(right)
  for (const a of leftIntervals) {
    for (const b of rightIntervals) {
      const lo = tighterLower(a.lo, b.lo)
      const hi = tighterUpper(a.hi, b.hi)
      if (lo === undefined || hi === undefined) return true
      const comparison = compareSemver(lo.version, hi.version)
      if (comparison < 0) return true
      if (comparison === 0 && !lo.exclusive && !hi.exclusive) return true
    }
  }
  return false
}
