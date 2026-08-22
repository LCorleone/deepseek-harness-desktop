/**
 * Canonical JSON serialization for signed company manifests.
 *
 * The rules are pinned here and in `docs/schemas/company-manifest.schema.json`:
 *
 * 1. Only JSON-representable values are encodable: objects, arrays, strings,
 *    booleans, and `null`. Anything else (including `undefined`, functions,
 *    symbols, and bigint) throws a `TypeError`.
 * 2. Object members are sorted by key in ascending UTF-16 code-unit order
 *    (the order of `Array.prototype.sort` on the key strings) and emitted as
 *    `"key":value` pairs separated by `,` inside `{` and `}`.
 * 3. There is no insignificant whitespace anywhere; the only separators are
 *    `,` between members/elements and `:` after each key.
 * 4. Strings use the minimal `JSON.stringify` escaping (only `"`, `\`, and
 *    control characters below `0x20` are escaped; non-ASCII characters stay
 *    literal). The resulting text is UTF-8 encoded when signed or verified.
 * 5. Numbers are forbidden except safe integers rendered in plain decimal.
 *    The manifest top-level `sequence` is the only number in the grammar, so
 *    floats, unsafe integers, `NaN`, and `Infinity` all throw a `TypeError`.
 *
 * A JSON document is canonical exactly when
 * `canonicalJsonText(JSON.parse(text)) === text`; verification relies on this
 * byte-for-byte round trip to reject reordered keys, added whitespace,
 * alternate escapes, and non-canonical number spellings.
 */

function writeCanonical(value: unknown, out: string[]): void {
  if (value === null) {
    out.push('null')
    return
  }
  switch (typeof value) {
    case 'string':
      out.push(JSON.stringify(value))
      return
    case 'boolean':
      out.push(value ? 'true' : 'false')
      return
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TypeError('canonical JSON only allows safe integers; the manifest sequence is the only number')
      }
      out.push(value.toString())
      return
    case 'object': {
      if (Array.isArray(value)) {
        out.push('[')
        for (const [index, entry] of value.entries()) {
          if (index > 0) out.push(',')
          writeCanonical(entry, out)
        }
        out.push(']')
        return
      }
      const record = value as Record<string, unknown>
      const keys = Object.keys(record).sort()
      out.push('{')
      for (const [index, key] of keys.entries()) {
        const member = record[key]
        if (member === undefined) {
          throw new TypeError('canonical JSON cannot encode undefined object members')
        }
        if (index > 0) out.push(',')
        out.push(JSON.stringify(key), ':')
        writeCanonical(member, out)
      }
      out.push('}')
      return
    }
    default:
      throw new TypeError(`canonical JSON cannot encode a value of type ${typeof value}`)
  }
}

/** Serialize a JSON value to its canonical text form described in the module docs. */
export function canonicalJsonText(value: unknown): string {
  const out: string[] = []
  writeCanonical(value, out)
  return out.join('')
}
