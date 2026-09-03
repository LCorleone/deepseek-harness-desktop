/**
 * Agent-browser login-persistence document and partition tokens (design
 * §5.2, B3).
 *
 * The default remains the one-shot in-memory partition minted per window
 * creation; the persist form is a UUID minted ONCE when the user enables the
 * toggle, stored in the Desktop-owned login-state document (the
 * desktop-settings-controller storage precedent: a launcher-owned state file
 * outside the Harness profile tree), and reused across launches so the guest
 * partition `persist:dsh-agent-browser-<uuid>` actually survives restarts.
 *
 * Pure document logic here; the Electron-facing wipe (session.clearStorageData
 * + partition-directory removal) lives in `agent-browser-window.ts`, and the
 * session only consumes the store seam (`agent-browser-session.ts`).
 *
 * @module dsh-plugin-desktop/agent-browser-partition
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Persist partitions carry this prefix; one-shot partitions never do. */
export const AGENT_BROWSER_PERSIST_PARTITION_PREFIX = 'persist:dsh-agent-browser-'

/** Shape of the Desktop-owned login-state document (versioned on disk). */
export interface AgentBrowserLoginDocument {
  readonly version: 1
  /** Whether the user enabled login persistence (restart/window-creation applied). */
  readonly persistLogin: boolean
  /** The persist partition UUID; minted once at first enable, rotated on clear. */
  readonly persistUuid?: string
}

/** Document before any user choice: one-shot partitions only. */
export const DEFAULT_AGENT_BROWSER_LOGIN: AgentBrowserLoginDocument = Object.freeze({
  version: 1,
  persistLogin: false,
})

/** UUID shape accepted as a persist partition identity. */
export function isAgentBrowserUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
}

/** The persist partition token of one UUID (§5.2: `persist:dsh-agent-browser-<uuid>`). */
export function agentBrowserPersistPartition(uuid: string): string {
  return `${AGENT_BROWSER_PERSIST_PARTITION_PREFIX}${uuid}`
}

/**
 * Strictly parse one stored login document; anything malformed recovers to
 * the default (the profile-selection state precedent: a broken state file
 * never strands the surface, it only drops the preference).
 */
export function parseAgentBrowserLoginDocument(value: unknown): AgentBrowserLoginDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_AGENT_BROWSER_LOGIN
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const expected = record.persistUuid === undefined
    ? ['persistLogin', 'version']
    : ['persistLogin', 'persistUuid', 'version']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return DEFAULT_AGENT_BROWSER_LOGIN
  }
  if (record.version !== 1 || typeof record.persistLogin !== 'boolean') return DEFAULT_AGENT_BROWSER_LOGIN
  if (record.persistUuid !== undefined && !isAgentBrowserUuid(record.persistUuid)) {
    return DEFAULT_AGENT_BROWSER_LOGIN
  }
  return Object.freeze({
    version: 1,
    persistLogin: record.persistLogin,
    ...(record.persistUuid === undefined ? {} : { persistUuid: record.persistUuid }),
  })
}

/**
 * The next document for one toggle action: enabling mints the UUID ONCE
 * (only when none exists — reminting per toggle would silently defeat
 * persistence, §5.2); disabling keeps the UUID so a later re-enable reuses
 * the same partition unless the user cleared it.
 */
export function nextAgentBrowserLoginForToggle(
  current: AgentBrowserLoginDocument,
  enabled: boolean,
  mintUuid: () => string,
): AgentBrowserLoginDocument {
  if (!enabled) return Object.freeze({ version: 1, persistLogin: false, ...(current.persistUuid === undefined ? {} : { persistUuid: current.persistUuid }) })
  if (isAgentBrowserUuid(current.persistUuid)) return Object.freeze({ version: 1, persistLogin: true, persistUuid: current.persistUuid })
  return Object.freeze({ version: 1, persistLogin: true, persistUuid: mintUuid() })
}

/**
 * The document after a login-state clear: a freshly minted UUID under the
 * same preference (clearing wipes credentials, it does not uninstall the
 * feature) — the rotated identity is what makes the NEXT window creation
 * start from an empty partition even if directory removal missed residue.
 */
export function rotatedAgentBrowserLogin(
  current: AgentBrowserLoginDocument,
  mintUuid: () => string,
): AgentBrowserLoginDocument {
  return Object.freeze({ version: 1, persistLogin: current.persistLogin, persistUuid: mintUuid() })
}

/** Store seam the session consumes (the launcher binds it to the state file). */
export interface AgentBrowserLoginStore {
  read(): AgentBrowserLoginDocument
  write(next: AgentBrowserLoginDocument): void | Promise<void>
}

/**
 * File-backed login document over a Desktop-owned state file, written
 * atomically through the same temp-file + rename discipline as the profile
 * selection state (`profile-manager.ts`).
 */
export class AgentBrowserLoginFileStore implements AgentBrowserLoginStore {
  private readonly statePath: string

  constructor(statePath: string) {
    this.statePath = statePath
  }

  read(): AgentBrowserLoginDocument {
    let text: string
    try {
      text = readFileSync(this.statePath, 'utf8')
    } catch {
      // Absent (first launch) or unreadable: the default one-shot document.
      return DEFAULT_AGENT_BROWSER_LOGIN
    }
    try {
      return parseAgentBrowserLoginDocument(JSON.parse(text) as unknown)
    } catch {
      return DEFAULT_AGENT_BROWSER_LOGIN
    }
  }

  write(next: AgentBrowserLoginDocument): void {
    const directory = dirname(this.statePath)
    mkdirSync(directory, { recursive: true })
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, `${JSON.stringify(next, undefined, 2)}\n`, 'utf8')
      renameSync(temporary, this.statePath)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
