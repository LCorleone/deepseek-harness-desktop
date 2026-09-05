/**
 * Hand-rolled JSON Schema (draft 2020-12 subset) validation for the handoff
 * submission contract (docs/handoff/handoff.schema.json).
 *
 * The catalog pipeline stays plain Node built-ins (zero runtime deps), so
 * instead of pulling a validator package in, this module implements exactly
 * the keyword set the contract schema uses — and REFUSES, loudly, any schema
 * node that uses a keyword it does not implement: a contract that evolves
 * past this validator must fail closed here, at the owner's desk, instead of
 * being silently under-validated against submitter input. `additionalProperties:
 * false` is enforced everywhere the schema says so — an unexpected field in a
 * handoff.json is a violation, never a tolerated extra.
 *
 * Plain, offline, synchronous; no filesystem access beyond loadJsonSchema.
 */

import { readFileSync } from 'node:fs'

/** Schema keywords that carry no validation semantics (ignored on purpose). */
const METADATA_KEYWORDS = new Set([
  '$schema', '$id', '$comment', 'title', 'description', 'default',
  'examples', 'deprecated', '$defs', 'definitions',
])
/** Every applicator/ assertion keyword this validator implements. */
const SUPPORTED_KEYWORDS = new Set([
  'type', 'enum', 'const',
  'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems',
  'pattern', 'minLength', 'maxLength', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
])
/** `format` values with an implemented semantic; anything else is schema-side. */
const SUPPORTED_FORMATS = new Set(['date'])
const SUPPORTED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Structural JSON equality (const/enum comparison; JSON values only). */
function deepEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]))
  }
  return false
}

/** Read and parse a schema document; a broken schema is an owner-side error. */
export function loadJsonSchema(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`the schema document ${path} is not readable (${error.code ?? error.message})`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`the schema document ${path} is not valid JSON (${error.message})`)
  }
  if (!isPlainObject(parsed)) throw new Error(`the schema document ${path} must be a JSON object`)
  return parsed
}

const jsonTypeOf = (value) => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

const matchesType = (value, type) => {
  switch (type) {
    case 'object': return isPlainObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'number': return typeof value === 'number'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    default: return false
  }
}

/** RFC 3339 `date` (YYYY-MM-DD) with a real calendar round-trip check. */
function isValidDateString(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text)
  if (match === null) return false
  const year = Number.parseInt(match[1], 10)
  const month = Number.parseInt(match[2], 10)
  const day = Number.parseInt(match[3], 10)
  const utc = new Date(Date.UTC(year, month - 1, day))
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
}

/**
 * Validate a parsed JSON value against a parsed schema subset. Returns
 * `{ok: true, value}` or `{ok: false, errors: [{at, message}]}` — every
 * violation is reported (the caller decides how much to surface). Throws
 * only for schema-side problems: unknown keywords, malformed regexes, or a
 * non-object schema node.
 */
export function validateJsonSchema(value, schema, at = '') {
  const errors = []
  walk(value, schema, at, errors)
  return errors.length === 0 ? { ok: true, value } : { ok: false, errors }
}

const childAt = (at, key) => (at === '' ? `/${key}` : `${at}/${key}`)
const quotedList = (values) => values.map((value) => JSON.stringify(value)).join(', ')

function walk(value, schema, at, errors) {
  if (!isPlainObject(schema)) {
    throw new Error(`the schema node at '${at || '/'}' is not an object — the validator cannot apply it`)
  }
  const unknown = Object.keys(schema).filter((keyword) => !METADATA_KEYWORDS.has(keyword) && !SUPPORTED_KEYWORDS.has(keyword))
  if (unknown.length > 0) {
    throw new Error(
      `the schema node at '${at || '/'}' uses keyword(s) ${unknown.join(', ')} that this validator does not implement — ` +
      'extend lib/handoff-schema.mjs first (failing closed, never under-validating submitter input)',
    )
  }

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type]
    for (const type of allowed) {
      if (!SUPPORTED_TYPES.has(type)) throw new Error(`the schema node at '${at || '/'}' declares unknown type '${String(type)}'`)
    }
    if (!allowed.some((type) => matchesType(value, type))) {
      errors.push({ at, message: `must be of type ${allowed.join(' | ')} (got ${jsonTypeOf(value)})` })
      // A shape mismatch makes every sibling keyword meaningless noise.
      return
    }
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push({ at, message: `must equal the constant ${JSON.stringify(schema.const)}` })
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) throw new Error(`the schema node at '${at || '/'}' carries a non-array enum`)
    if (!schema.enum.some((candidate) => deepEqual(value, candidate))) {
      errors.push({ at, message: `must be one of ${quotedList(schema.enum.slice(0, 8))}${schema.enum.length > 8 ? ', …' : ''} (got ${JSON.stringify(value)})` })
    }
  }

  if (typeof value === 'string') {
    if (schema.pattern !== undefined) {
      let expression
      try {
        expression = new RegExp(schema.pattern, 'u')
      } catch (error) {
        throw new Error(`the schema node at '${at || '/'}' carries a malformed pattern '${schema.pattern}' (${error.message})`)
      }
      if (!expression.test(value)) errors.push({ at, message: `must match the pattern ${JSON.stringify(schema.pattern)} (got ${JSON.stringify(value)})` })
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ at, message: `must be at least ${String(schema.minLength)} characters long (got ${String(value.length)})` })
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ at, message: `must be at most ${String(schema.maxLength)} characters long (got ${String(value.length)})` })
    }
    if (schema.format !== undefined) {
      if (!SUPPORTED_FORMATS.has(schema.format)) {
        throw new Error(`the schema node at '${at || '/'}' declares format '${schema.format}' that this validator does not implement`)
      }
      if (schema.format === 'date' && !isValidDateString(value)) {
        errors.push({ at, message: `must be a calendar date in YYYY-MM-DD form (got ${JSON.stringify(value)})` })
      }
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ at, message: `must be >= ${String(schema.minimum)} (got ${String(value)})` })
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ at, message: `must be <= ${String(schema.maximum)} (got ${String(value)})` })
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push({ at, message: `must be > ${String(schema.exclusiveMinimum)} (got ${String(value)})` })
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      errors.push({ at, message: `must be < ${String(schema.exclusiveMaximum)} (got ${String(value)})` })
    }
  }

  if (isPlainObject(value)) {
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required)) throw new Error(`the schema node at '${at || '/'}' carries a non-array required`)
      for (const key of schema.required) {
        if (!(key in value)) errors.push({ at, message: `is missing the required field '${key}'` })
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) walk(value[key], childSchema, childAt(at, key), errors)
    }
    if (schema.additionalProperties !== undefined) {
      const known = new Set(Object.keys(properties))
      for (const key of Object.keys(value)) {
        if (known.has(key)) continue
        if (schema.additionalProperties === false) {
          errors.push({ at: childAt(at, key), message: `is not allowed — the schema closes the object (additionalProperties: false)` })
        } else if (isPlainObject(schema.additionalProperties)) {
          walk(value[key], schema.additionalProperties, childAt(at, key), errors)
        }
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ at, message: `must carry at least ${String(schema.minItems)} item(s) (got ${String(value.length)})` })
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ at, message: `must carry at most ${String(schema.maxItems)} item(s) (got ${String(value.length)})` })
    }
    if (schema.items !== undefined) {
      if (!isPlainObject(schema.items)) throw new Error(`the schema node at '${at || '/'}' carries a non-object items schema (only the single-schema 2020-12 form is implemented)`)
      value.forEach((item, index) => walk(item, schema.items, `${at}[${String(index)}]`, errors))
    }
  }
}
