/**
 * Company-skills router environment (#043 D1): decode the build-time blob in
 * the desktop main process and hand it to the company-skills executor
 * through a process-global slot.
 *
 * ## The channel, and why a slot
 *
 * The five API skills (`company-info`, `ocr`, `vlm-image`,
 * `scms-financial-api`, `smart-pdf-parser`) call one internal router whose
 * `ROUTER_URL`/`ROUTER_API_KEY` their scripts read through
 * `load_dotenv()` + `os.getenv()` — with no `.env` file present (the
 * collector strips every one), that resolves to the OS environment, so the
 * values only have to reach the skill child's spawn environment. The desktop
 * decodes them here, in the Electron main process only, and publishes them
 * on a `Symbol.for` globalThis slot: the Cordis loader loads
 * `dsh-company-skills` as its own module instance, so no import this package
 * could declare reaches the plugin face — the slot is the standing repo
 * answer for exactly that split (#034/#039: `Symbol.for` returns the SAME
 * registry symbol to every module instance of the process; the plugin pins
 * the same key in `dsh-company-skills/src/host-env.ts` and reads it at
 * executor construction).
 *
 * ## What deliberately does NOT happen
 *
 * The decoded values are never written to `process.env` — unlike the
 * managed-model gateway keys, which must reach terminal and CLI children
 * through normal inheritance — because the only consumer is the skills
 * executor's spawn, and inheritance would hand them to every agent-side
 * child as well. `ROUTER_API_KEY` would be caught by the harness subprocess
 * scrub (`SENSITIVE_ENV_PATTERN`, /KEY|PASSWORD|SECRET|TOKEN/i) but
 * `ROUTER_URL` would not; keeping both off `process.env` entirely makes the
 * scrub question moot. They are never logged, never sent to the renderer,
 * and never written to disk: the payload exists only in process memory for
 * the lifetime of the launch, exactly the D1 lifecycle ("仅进程内存、不落盘、
 * 关闭即逝").
 *
 * @module dsh-plugin-desktop/company-skills-env
 */

import { COMPANY_SKILLS_ENV_BLOB } from './company-skills-env-blob.ts'
import type { DesktopPolicy } from './desktop-policy.ts'

/**
 * Fixed XOR key — byte-identical to the generator
 * (`scripts/make-company-skills-env-blob.mjs`); a drift fails the decode
 * loudly instead of misreading the payload.
 */
const OBFUSCATION_KEY = 'dsh-desktop-company-skills-env-obfuscation-key-v1'

/**
 * The registry symbol both sides declare. `dsh-company-skills/src/host-env.ts`
 * pins the SAME string (`COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT` there);
 * a test in this package pins the two against drift so they cannot silently
 * diverge.
 */
export const COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT: unique symbol = Symbol.for(
  'dsh.companySkillsExecutionEnvironment',
)

/** globalThis narrowed to the slot; the slot is only touched through the helpers below. */
const executionEnvironmentGlobals = globalThis as unknown as {
  [COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT]: Readonly<Record<string, string>> | undefined
}

/** The decoded skills-router facts. */
export interface CompanySkillsRouterEnvironment {
  readonly routerUrl: string
  readonly routerApiKey: string
}

const invalidBlob = (message: string): Error => new Error(`dsh-plugin-desktop: invalid company-skills env blob: ${message}`)

/** Read the process-wide slot (whichever module instance wrote it); exported for tests. */
export function companySkillsExecutionEnvironment(): Readonly<Record<string, string>> | undefined {
  return executionEnvironmentGlobals[COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT]
}

/**
 * Publish (or clear) the host-injected company-skills execution environment.
 * The Electron launcher calls this after decoding the blob, before the Host
 * composition can load the skills plugin; passing undefined clears the slot
 * (teardown), and the record is copied defensively so a later mutation of
 * the caller's object cannot change what children see.
 */
export function setCompanySkillsExecutionEnvironment(
  fragment: Readonly<Record<string, string>> | undefined,
): void {
  executionEnvironmentGlobals[COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT]
    = fragment === undefined ? undefined : Object.freeze({ ...fragment })
}

/**
 * Decode and strictly validate one obfuscated company-skills env blob. The
 * validation mirrors the generator on purpose: a payload the generator
 * accepts must always decode here. Error messages never include blob
 * content.
 * @param blob - base64 XOR-obfuscated `{routerUrl, routerApiKey}` payload.
 * @returns the validated facts, deeply frozen.
 * @throws when the blob is malformed.
 */
export function decodeCompanySkillsEnvBlob(blob: string): CompanySkillsRouterEnvironment {
  if (typeof blob !== 'string' || blob.length === 0) {
    throw invalidBlob('the blob must be a non-empty string')
  }
  let cipher: Buffer
  try {
    cipher = Buffer.from(blob, 'base64')
  } catch (cause) {
    throw invalidBlob(`base64 decoding failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const key = Buffer.from(OBFUSCATION_KEY, 'utf8')
  const plain = Buffer.from(cipher)
  for (let index = 0; index < plain.length; index += 1) {
    plain[index] = plain[index]! ^ key[index % key.length]!
  }
  let document: unknown
  try {
    document = JSON.parse(plain.toString('utf8')) as unknown
  } catch {
    throw invalidBlob('the decoded payload is not valid JSON')
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw invalidBlob('the decoded payload must be an object')
  }
  const { routerUrl, routerApiKey } = document as Record<string, unknown>
  if (Object.keys(document).length !== 2 || routerUrl === undefined || routerApiKey === undefined) {
    throw invalidBlob('the decoded payload must carry exactly routerUrl and routerApiKey')
  }
  if (typeof routerUrl !== 'string' || typeof routerApiKey !== 'string') {
    throw invalidBlob('routerUrl and routerApiKey must be strings')
  }
  // The empty payload is the committed no-secrets default; anything else must
  // be a complete, well-formed pair (the generator already enforced this —
  // re-deriving it here keeps a hand-crafted blob from half-injecting).
  if (routerUrl.length === 0 && routerApiKey.length === 0) {
    return Object.freeze({ routerUrl: '', routerApiKey: '' })
  }
  if (routerUrl.length === 0 || routerApiKey.length === 0) {
    throw invalidBlob('routerUrl and routerApiKey must be provided together')
  }
  let url: URL
  try {
    url = new URL(routerUrl)
  } catch {
    throw invalidBlob('routerUrl must be a parseable absolute URL')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    throw invalidBlob('routerUrl must be a bare http(s) URL without credentials in it')
  }
  return Object.freeze({ routerUrl, routerApiKey })
}

/**
 * Decode the embedded blob when — and only when — the policy pins the
 * company-managed posture (`locked`). Unlocked and development builds keep
 * the blob unread, exactly the `managedModelGateway` shape; an empty payload
 * decodes to undefined ("inject nothing") rather than an error, because it
 * is the committed default for a checkout without secrets (the CI
 * secret wiring is the documented #043 follow-up).
 * @param policy - embedded desktop policy; omitted or unlocked policies stay inert.
 * @param blob - blob override for tests; defaults to the embedded constant.
 * @returns the router facts, or undefined for every unmanaged or empty build.
 * @throws when a locked build carries a corrupt or half-configured blob (fail closed).
 */
export function managedCompanySkillsEnvironment(
  policy: DesktopPolicy | undefined,
  blob: string = COMPANY_SKILLS_ENV_BLOB,
): CompanySkillsRouterEnvironment | undefined {
  if (policy?.locked !== true) return undefined
  const decoded = decodeCompanySkillsEnvBlob(blob)
  if (decoded.routerUrl.length === 0) return undefined
  return decoded
}

/**
 * Render the executor-facing environment fragment for one decoded pair. The
 * names are exactly what the skills' scripts read (`ROUTER_URL`,
 * `ROUTER_API_KEY`).
 */
export function companySkillsExecutionEnvironmentEntries(
  router: CompanySkillsRouterEnvironment,
): Readonly<Record<string, string>> {
  return Object.freeze({ ROUTER_URL: router.routerUrl, ROUTER_API_KEY: router.routerApiKey })
}
