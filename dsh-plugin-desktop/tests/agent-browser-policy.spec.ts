/**
 * P8 B4 red-line suite: URL policy enforcement and hardening.
 *
 * Covers the B4 acceptance matrix against the pure decision home
 * (agent-browser-policy.ts) and the session's guest enforcement wiring:
 *
 * - the wildcard/non-http(s) regression (deny file:/data:/javascript: even
 *   under `['*']`),
 * - the allowlist deny matrix at the pre-commit guest points — `will-navigate`
 *   (renderer-initiated main frame) and `will-redirect` (server-side chain,
 *   incl. the terminal check: a chain whose FINAL hop leaves the allowlist is
 *   broken before the target receives a request),
 * - the post-commit `frameNavigated` backstop (surface-only, and the declared
 *   MAIN-FRAME boundary: an off-allowlist iframe navigation is page behavior,
 *   not a violation),
 * - the download refusal (cancel + report, §5.1 v1 posture),
 * - the masked audit lines (token-shaped query values never survive into the
 *   desktop log — mask-secrets is the log-side backstop),
 * - the screenshot retention hint (present-and-recorded only; nothing
 *   consumes it in 0.1.1-rc.2, design §8),
 * - the audited classifier's label→control forwarding (B2-fix2 review P2).
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { DesktopPolicy } from '../src/desktop-policy.ts'
import type { DesktopAgentBrowser } from '../src/agent-browser-contract.ts'
import { maskSecrets } from '../src/mask-secrets.ts'
import {
  agentBrowserAllowsUrl,
  agentBrowserDeniedMessage,
  agentBrowserDownloadCancelledNotice,
  agentBrowserNavigationBackstopNotice,
  agentBrowserNavigationDeniedNotice,
} from '../src/agent-browser-policy.ts'
import { AUDITED_SNIPPET_IS_SUBMIT_CONTROL } from '../src/agent-browser-session.ts'
import type {
  AgentBrowserDownloadItem,
  AgentBrowserGuestSession,
  AgentBrowserGuestWebContents,
} from '../src/agent-browser-session.ts'
import {
  AGENT_BROWSER_PROMPT_SECTION,
  AGENT_BROWSER_SCREENSHOT_RETENTION_HINT,
  agentBrowserPromptContextText,
  apply,
} from '../src/agent-browser.ts'
import { createHarness, fakeGuestDebugger, guardedFakeGuest } from './agent-browser-harness.ts'

const WILDCARD_POLICY = { enabled: true, allowOrigins: ['*'], allowPersistLogin: false } as const
const ALLOWLIST_POLICY = { enabled: true, allowOrigins: ['https://docs.example.test'], allowPersistLogin: false } as const

/** A session whose guest exposes the B4 guard seams, with captured audit lines. */
function guardedSession(policy: { readonly allowOrigins: readonly string[] }) {
  const debugger_ = fakeGuestDebugger()
  const guards = guardedFakeGuest(debugger_.target)
  const logLines: string[] = []
  const { session } = createHarness({
    responses: {},
    attachGuest: () => guards.guest,
    navigationPolicy: { enabled: true, allowOrigins: policy.allowOrigins, allowPersistLogin: false },
    logError: line => { logLines.push(line) },
  })
  return { debugger_, guards, logLines, session }
}

describe('agent-browser URL policy decisions (B4 home)', () => {
  it('admits every http(s) origin under the wildcard and nothing else (regression)', () => {
    expect(agentBrowserAllowsUrl('https://example.test/page', WILDCARD_POLICY)).toBe(true)
    expect(agentBrowserAllowsUrl('http://127.0.0.1:8080/', WILDCARD_POLICY)).toBe(true)
    // The wildcard admits every ORIGIN, never every scheme.
    expect(agentBrowserAllowsUrl('file:///etc/passwd', WILDCARD_POLICY)).toBe(false)
    expect(agentBrowserAllowsUrl('file:///home/user/.aws/credentials', WILDCARD_POLICY)).toBe(false)
    expect(agentBrowserAllowsUrl('data:text/html,<script>alert(1)</script>', WILDCARD_POLICY)).toBe(false)
    expect(agentBrowserAllowsUrl('javascript:location="https://evil.example"', WILDCARD_POLICY)).toBe(false)
    expect(agentBrowserAllowsUrl('about:blank', WILDCARD_POLICY)).toBe(false)
  })

  it('denies everything while the allowlist is empty, matches exact origins otherwise', () => {
    // The inert sub-policy (explicitly disabled, empty allowlist): since the
    // 2026-09-05 release flip this shape is an explicit opt-out, not the
    // release default — and it still admits nothing.
    const disabled = { enabled: false, allowOrigins: [], allowPersistLogin: false }
    expect(agentBrowserAllowsUrl('https://docs.example.test/', disabled)).toBe(false)
    expect(agentBrowserAllowsUrl('https://docs.example.test/guide', ALLOWLIST_POLICY)).toBe(true)
    expect(agentBrowserAllowsUrl('https://docs.example.test:443/guide', ALLOWLIST_POLICY)).toBe(true)
    expect(agentBrowserAllowsUrl('https://evil.example/', ALLOWLIST_POLICY)).toBe(false)
    expect(agentBrowserAllowsUrl('https://sub.docs.example.test/', ALLOWLIST_POLICY)).toBe(false)
    expect(agentBrowserAllowsUrl('not a url', ALLOWLIST_POLICY)).toBe(false)
    expect(agentBrowserAllowsUrl('file:///etc/passwd', ALLOWLIST_POLICY)).toBe(false)
  })

  it('names the policy in the deny text', () => {
    expect(agentBrowserDeniedMessage('https://evil.example/')).toContain('policy does not allow')
  })
})

describe('guest will-navigate enforcement (deny matrix, §5.5)', () => {
  it('denies off-allowlist and non-http(s) main-frame navigations before commit', async () => {
    const { guards, logLines, session } = guardedSession(ALLOWLIST_POLICY)
    await session.open('https://docs.example.test/guide', { waitForLoad: false })

    // Off-allowlist renderer-initiated navigation: denied (preventDefault),
    // never asked — the ask seam belongs to the TOOL surface only.
    expect(guards.emitWillNavigate('https://evil.example/exfil')).toBe(true)
    // Allowlisted origin: commits untouched.
    expect(guards.emitWillNavigate('https://docs.example.test/next')).toBe(false)
    // Non-http(s) is denied even though the page is already on-list —
    // including the blank document (the tool gate denies it alike).
    expect(guards.emitWillNavigate('file:///etc/passwd')).toBe(true)
    expect(guards.emitWillNavigate('about:blank')).toBe(true)

    // The denials were recorded as notices and audit lines.
    const notices = session.describe().policyNotices ?? []
    expect(notices).toHaveLength(3)
    expect(notices[0]).toBe(agentBrowserNavigationDeniedNotice('will-navigate', 'https://evil.example/exfil'))
    expect(notices[1]).toBe(agentBrowserNavigationDeniedNotice('will-navigate', 'file:///etc/passwd'))
    expect(notices[2]).toBe(agentBrowserNavigationDeniedNotice('will-navigate', 'about:blank'))
    expect(logLines).toHaveLength(3)
    expect(logLines[0]).toContain('will-navigate')
    expect(logLines[0]).toContain('https://evil.example/exfil')
  })

  it('keeps the wildcard posture: http(s) commits, non-http(s) denied (regression)', async () => {
    const { guards, session } = guardedSession(WILDCARD_POLICY)
    await session.open('https://example.test/', { waitForLoad: false })

    expect(guards.emitWillNavigate('http://127.0.0.1:8080/console')).toBe(false)
    expect(guards.emitWillNavigate('file:///etc/passwd')).toBe(true)
    expect(session.describe().policyNotices).toHaveLength(1)
  })

  it('installs no guards when no navigation policy is bound (pre-B4 compositions)', async () => {
    const debugger_ = fakeGuestDebugger()
    const guards = guardedFakeGuest(debugger_.target)
    const { session } = createHarness({ attachGuest: () => guards.guest })
    await session.open('https://example.test/', { waitForLoad: false })

    // Without the launcher-bound policy the session keeps its pre-B4 shape:
    // the guest seams exist, but nothing was installed on them.
    expect(guards.emitWillNavigate('file:///etc/passwd')).toBe(false)
    expect(guards.emitWillDownload('https://evil.example/payload.bin')).toBe(false)
    expect(session.describe().policyNotices).toBeUndefined()
  })
})

describe('guest will-redirect enforcement (redirect-chain terminal check, §5.5)', () => {
  it('breaks a chain whose final hop leaves the allowlist, before the target receives a request', async () => {
    const { guards, logLines, session } = guardedSession(ALLOWLIST_POLICY)
    await session.open('https://docs.example.test/start', { waitForLoad: false })

    // The chain starts on-list and hops on-list…
    expect(guards.emitWillRedirect('https://docs.example.test/hop1')).toBe(false)
    expect(guards.emitWillRedirect('https://docs.example.test/hop2')).toBe(false)
    // …but the terminal hop targets an off-list origin: preventDefault
    // cancels the NAVIGATION (not just the hop) — the chain is broken.
    expect(guards.emitWillRedirect('https://evil.example/terminal')).toBe(true)

    const notices = session.describe().policyNotices ?? []
    expect(notices).toHaveLength(1)
    expect(notices[0]).toBe(agentBrowserNavigationDeniedNotice('will-redirect', 'https://evil.example/terminal'))
    expect(logLines[0]).toContain('will-redirect')
    expect(logLines[0]).toContain('whole navigation was cancelled')
  })

  it('denies an off-list first hop immediately under an allowlist, admits http(s) under the wildcard', async () => {
    const { guards: strict, session: strictSession } = guardedSession(ALLOWLIST_POLICY)
    await strictSession.open('https://docs.example.test/', { waitForLoad: false })
    expect(strict.emitWillRedirect('https://sso.evil.example/callback')).toBe(true)

    const { guards: wildcard, session: wildcardSession } = guardedSession(WILDCARD_POLICY)
    await wildcardSession.open('https://example.test/', { waitForLoad: false })
    expect(wildcard.emitWillRedirect('http://127.0.0.1:8080/callback')).toBe(false)
    expect(wildcard.emitWillRedirect('data:text/html,<b>')).toBe(true)
  })
})

describe('frameNavigated post-commit backstop (§5.5)', () => {
  it('surfaces an off-allowlist committed main-frame navigation as a violation notice', async () => {
    const { debugger_, logLines, session } = guardedSession(ALLOWLIST_POLICY)
    await session.open('https://docs.example.test/', { waitForLoad: false })

    // Whatever slipped the pre-commit points and COMMITTED: post-commit
    // detection cannot block — it only surfaces the violation.
    debugger_.emit('Page.frameNavigated', {
      frame: { id: 'main-frame', url: 'https://evil.example/committed' },
    })

    const notices = session.describe().policyNotices ?? []
    expect(notices).toHaveLength(1)
    expect(notices[0]).toBe(agentBrowserNavigationBackstopNotice('https://evil.example/committed'))
    expect(logLines[0]).toContain('post-commit backstop')
  })

  it('never flags the about:blank mount document', async () => {
    const { debugger_, session } = guardedSession(ALLOWLIST_POLICY)
    await session.open('about:blank', { waitForLoad: false })

    debugger_.emit('Page.frameNavigated', { frame: { id: 'main-frame', url: 'about:blank' } })
    expect(session.describe().policyNotices).toBeUndefined()
  })

  it('never flags the Chromium error page an allowlisted origin failed to load into', async () => {
    const { debugger_, logLines, session } = guardedSession(ALLOWLIST_POLICY)
    await session.open('https://docs.example.test/', { waitForLoad: false })

    // When an ALLOWLISTED origin fails to load (DNS/network/server error)
    // Chromium commits chrome-error://chromewebdata/ as the error page: the
    // load's failure state, not a policy evasion — a violation notice there
    // would blame the policy with misleading copy (B4 review follow-up).
    debugger_.emit('Page.frameNavigated', { frame: { id: 'main-frame', url: 'chrome-error://chromewebdata/' } })
    expect(session.describe().policyNotices).toBeUndefined()
    expect(logLines).toHaveLength(0)
  })

  it('honors the declared main-frame boundary: an off-allowlist IFRAME navigation is not a violation', async () => {
    const { debugger_, session } = guardedSession(ALLOWLIST_POLICY)
    await session.open('https://docs.example.test/', { waitForLoad: false })

    // The allowlist governs the MAIN FRAME only; an iframe reaching a
    // non-allowlisted origin is declared page behavior, outside navigation
    // policy's scope (the parentId filter is where the boundary lives).
    debugger_.emit('Page.frameNavigated', {
      frame: { id: 'frame-1', parentId: 'main-frame', url: 'https://tracker.example/pixel' },
    })
    expect(session.describe().policyNotices).toBeUndefined()
  })
})

describe('download refusal (§5.1 v1 posture: cancel + report)', () => {
  it('cancels the download outright and records the report', async () => {
    const { guards, logLines, session } = guardedSession(ALLOWLIST_POLICY)
    await session.open('https://docs.example.test/guide', { waitForLoad: false })

    // Downloads are cancelled regardless of the origin — the posture is not
    // an allowlist question in v1 (a pre-ask remains a later refinement).
    expect(guards.emitWillDownload('https://docs.example.test/files/report.zip', 'report.zip')).toBe(true)
    expect(guards.emitWillDownload('https://evil.example/payload.bin', 'payload.bin')).toBe(true)

    const notices = session.describe().policyNotices ?? []
    expect(notices).toHaveLength(2)
    expect(notices[0]).toBe(agentBrowserDownloadCancelledNotice('https://docs.example.test/files/report.zip', 'report.zip'))
    expect(logLines[0]).toContain('cancelled a page-initiated download')
    // The report reaches the model through the dynamic prompt context — the
    // same seam that carries claim state, no tool call needed.
    const contextLine = agentBrowserPromptContextText(session.describe())
    expect(contextLine).toContain('policy enforcement')
    expect(contextLine).toContain('report.zip')
  })

  it('keeps the notice history bounded', async () => {
    const { guards, session } = guardedSession(WILDCARD_POLICY)
    await session.open('https://example.test/', { waitForLoad: false })
    for (let index = 0; index < 8; index += 1) {
      expect(guards.emitWillDownload(`https://example.test/file-${String(index)}.bin`)).toBe(true)
    }
    const notices = session.describe().policyNotices ?? []
    expect(notices).toHaveLength(5)
    expect(notices.at(-1)).toContain('file-7.bin')
  })

  it('takes the will-download listener down with the surface — no accumulation across open/close cycles', async () => {
    // Under a persist partition the SESSION object outlives the window:
    // Electron hands the SAME session back on every reopen, so a listener
    // that survives close stacks one copy per cycle — one download would
    // fire N cancels, N notices, and N audit lines (B4 review follow-up).
    const listeners = new Set<(event: unknown, item: AgentBrowserDownloadItem) => void>()
    const sharedSession: AgentBrowserGuestSession = {
      // Real-Electron shape (probed): `on` returns the emitter, not a
      // disposer — removal rides the Node `removeListener` seam.
      on: (event, listener) => {
        if (event !== 'will-download') return undefined
        listeners.add(listener)
        return undefined
      },
      removeListener: (event, listener) => {
        if (event === 'will-download') listeners.delete(listener)
      },
    }
    // A fresh guest per cycle (the webContents dies with the window), all
    // riding the one shared session object — the persist-partition shape.
    const debugger_ = fakeGuestDebugger()
    const guestForCycle = (): AgentBrowserGuestWebContents => ({
      ...guardedFakeGuest(debugger_.target).guest,
      session: sharedSession,
    })
    const logLines: string[] = []
    const { session } = createHarness({
      attachGuest: guestForCycle,
      navigationPolicy: { enabled: true, allowOrigins: ALLOWLIST_POLICY.allowOrigins, allowPersistLogin: false },
      logError: line => { logLines.push(line) },
    })

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await session.open('https://docs.example.test/', { waitForLoad: false })
      expect(listeners.size).toBe(1)
      await session.close()
      expect(listeners.size).toBe(0)
    }

    // Reopen over the same session object: ONE page download, ONE cancel,
    // ONE notice — with the leak the third cycle would carry three.
    await session.open('https://docs.example.test/', { waitForLoad: false })
    expect(listeners.size).toBe(1)
    let cancels = 0
    for (const listener of [...listeners]) {
      listener(undefined, {
        cancel: () => { cancels += 1 },
        getURL: () => 'https://docs.example.test/files/report.zip',
        getFilename: () => 'report.zip',
      })
    }
    expect(cancels).toBe(1)
    expect(session.describe().policyNotices ?? []).toHaveLength(1)
    expect(logLines).toHaveLength(1)
  })
})

describe('masked audit lines (B4 hardening)', () => {
  it('masks token-shaped query values out of every enforcement report line', () => {
    // The exact lines installPolicyGuards hands to logError; the desktop log
    // sinks run maskSecrets over them (ElectronStderrLogger/LogFileSink), so
    // a token riding a denial URL cannot survive into the log file.
    const lines = [
      `dsh-plugin-desktop: agent browser ${agentBrowserNavigationDeniedNotice('will-navigate', 'https://evil.example/exfil?access_token=abcdef0123456789abcdef0123456789')}`,
      `dsh-plugin-desktop: agent browser ${agentBrowserNavigationDeniedNotice('will-redirect', 'https://sso.example/cb?code=0123456789abcdef0123456789abcdef')}`,
      `dsh-plugin-desktop: agent browser ${agentBrowserNavigationBackstopNotice('https://evil.example/land?session=0123456789abcdef0123456789')}`,
      `dsh-plugin-desktop: agent browser ${agentBrowserDownloadCancelledNotice('https://docs.example.test/dl?authkey=999988887777666655554444', 'report.zip')}`,
    ]
    for (const line of lines) {
      const masked = maskSecrets(line)
      expect(masked).not.toMatch(/0123456789abcdef/iu)
      expect(masked).not.toMatch(/abcdef0123456789abcdef/iu)
      expect(masked).not.toMatch(/999988887777666655554444/u)
      expect(masked).not.toMatch(/0123456789abcdef0123456789abcdef/u)
      // The origin itself stays visible — the audit line stays actionable.
      expect(masked).toContain('https://')
    }
    // The masked will-navigate line keeps the scheme+host and loses the token.
    expect(maskSecrets(lines[0]!)).toContain('evil.example')
    expect(maskSecrets(lines[0]!)).toContain('access_token=****')
  })

  it('masks the tool-level deny message the same way', () => {
    const masked = maskSecrets(`[DENIED_BY_POLICY] ${agentBrowserDeniedMessage('https://evil.example/x?token=deadbeefdeadbeefdeadbeefdeadbeef')}`)
    expect(masked).not.toContain('deadbeefdeadbeefdeadbeefdeadbeef')
    expect(masked).toContain('policy does not allow')
  })
})

describe('screenshot retention hint (§8: present-and-recorded future marker)', () => {
  it('projects the prune hint through output.presentationMeta — nothing consumes it', async () => {
    const { context, tools } = fakePluginContext()
    apply(context)
    const tool = tools.find(candidate => candidate.name === 'browser_screenshot')!
    const definition = tool as unknown as {
      output: {
        render: (args: unknown, value: unknown) => Array<{ type: string }>
        presentationMeta?: (args: unknown, value: unknown) => unknown
      }
    }
    expect(typeof definition.output.presentationMeta).toBe('function')

    const value = await tool.execute({}, { signal: undefined }) as { generation: number }
    const meta = definition.output.presentationMeta!({}, value) as Record<string, unknown>
    // The hint marker is present and recorded (persisted by the registry on
    // the tool/result); the rc.2 pruner ignores it by design — it budgets
    // characters only, so an ImageBlock costs zero.
    expect(meta).toMatchObject({
      ...AGENT_BROWSER_SCREENSHOT_RETENTION_HINT,
      generation: value.generation,
    })
    expect(AGENT_BROWSER_SCREENSHOT_RETENTION_HINT).toEqual({
      kind: 'agent-browser-screenshot',
      retention: { prune: 'oldest-first', blockType: 'image' },
    })
    // The canonical tool value itself is unchanged — the hint is meta-only.
    expect(definition.output.render({}, value).map(block => block.type)).toEqual(['text', 'image'])
  })
})

describe('tool-level deny precedence over the cross-origin ask (§5.1/§5.5)', () => {
  it('denies off-allowlist navigation with no approval ask; asks on-list cross-origin', async () => {
    const navigate = vi.fn(async () => ({ url: 'https://docs.example.test/x', title: 'X', generation: 1 }))
    const { context, tools, preExecute } = fakePluginContext({ navigate })
    apply(context)
    const tool = tools.find(candidate => candidate.name === 'browser_navigate')!
    const listener = preExecute()!
    const next = async (): Promise<PreToolDecision> => ({ kind: 'allow' })

    // Off-allowlist: DENY, NOT ASK — the pre-execute classifier stays silent
    // (the body's deny owns the case), and the executor is never reached.
    expect(await listener({ name: 'browser_navigate', arguments: { url: 'https://evil.example/' } }, next))
      .toEqual({ kind: 'allow' })
    await expect(tool.execute({ url: 'https://evil.example/' }, { signal: undefined }))
      .rejects.toThrow('DENIED_BY_POLICY')
    expect(navigate).not.toHaveBeenCalled()

    // Allowlisted-but-cross-origin (example.test → docs.example.test): the
    // §5.1 ask survives exactly as before.
    expect(await listener({ name: 'browser_navigate', arguments: { url: 'https://docs.example.test/guide' } }, next))
      .toMatchObject({ kind: 'ask' })
    const allowed = await tool.execute({ url: 'https://docs.example.test/guide' }, { signal: undefined }) as { generation: number }
    expect(allowed.generation).toBe(1)
    expect(navigate).toHaveBeenCalledWith('https://docs.example.test/guide', undefined)
  })
})

describe('prompt boundary declaration (§5.5 main-frame scope)', () => {
  it('tells the model the allowlist governs the main frame only', () => {
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('MAIN FRAME only')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('iframes and subresources')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('page behavior')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('DENIED_BY_POLICY')
  })
})

describe('audited classifier label→control forwarding (B2-fix2 review P2)', () => {
  /** Minimal label-aware DOM mirror the snippet executes against. */
  interface MirrorElement {
    readonly tagName: string
    readonly type?: string | undefined
    readonly form?: object | undefined
    readonly forId?: string | undefined
    readonly parent?: MirrorElement | undefined
    readonly children?: readonly MirrorElement[] | undefined
    /** Document view the snippet's `label.ownerDocument.getElementById(for)` reads. */
    readonly ownerDocument?: { getElementById(id: string): MirrorElement | null } | undefined
    closest(selector: string): MirrorElement | null
    getAttribute(name: 'for'): string | null
    querySelector(selector: string): MirrorElement | null
  }

  function mirrorElement(options: {
    tag: string
    type?: string
    inForm?: boolean
    forId?: string
    id?: string
    parent?: MirrorElement
    children?: readonly MirrorElement[]
    byId?: Map<string, MirrorElement>
  }): MirrorElement {
    const registry = options.byId
    const el: MirrorElement = {
      tagName: options.tag,
      type: options.type ?? (options.tag === 'button' ? 'submit' : options.tag === 'input' ? 'text' : undefined),
      form: options.inForm === false ? undefined : {},
      forId: options.forId,
      parent: options.parent,
      children: options.children ?? [],
      // The live map backs getElementById, so registration order is free.
      ownerDocument: registry === undefined ? undefined : { getElementById: id => registry.get(id) ?? null },
      closest(selector: string): MirrorElement | null {
        const tags = selector.split(',').map(part => part.trim().toLowerCase())
        let candidate: MirrorElement | undefined = el
        while (candidate !== undefined) {
          if (tags.includes(candidate.tagName.toLowerCase())) return candidate
          candidate = candidate.parent
        }
        return null
      },
      getAttribute(name: 'for'): string | null {
        return name === 'for' ? (el.forId ?? null) : null
      },
      querySelector(selector: string): MirrorElement | null {
        // The two shapes the audited snippet's label search uses: `button`
        // and `input:not([type=hidden i])` — a tag, optionally excluding one
        // case-insensitive [attr=value] match (hidden inputs are not
        // labelable, so the nested search skips them).
        const parts = selector.split(',').map(part => part.trim().toLowerCase())
        const matches = (candidate: MirrorElement, part: string): boolean => {
          const parsed = /^([a-z]+)(?::not\(\[([a-z-]+)=([^\]]+?)( i)?\]\))?$/.exec(part)
          if (parsed === null || candidate.tagName.toLowerCase() !== parsed[1]) return false
          if (parsed[2] === undefined) return true
          return String(candidate.type ?? '').toLowerCase() !== parsed[3]
        }
        const walk = (candidate: MirrorElement): MirrorElement | null => {
          for (const child of candidate.children ?? []) {
            if (parts.some(part => matches(child, part))) return child
            const nested = walk(child)
            if (nested !== null) return nested
          }
          return null
        }
        return walk(el)
      },
    }
    if (options.id !== undefined && options.byId !== undefined) options.byId.set(options.id, el)
    return el
  }

  /** Execute the audited snippet against one mirror element, isolated-world style. */
  const classify = (element: MirrorElement): boolean => {
    const snippet = new Function(`return (${AUDITED_SNIPPET_IS_SUBMIT_CONTROL})`)() as (this: unknown) => boolean
    return snippet.call(element)
  }

  it('forwards a label click to its associated submit control (for= wins)', () => {
    const byId = new Map<string, MirrorElement>()
    mirrorElement({ tag: 'button', type: 'submit', id: 'submit-btn', byId })
    mirrorElement({ tag: 'input', type: 'text', id: 'text-field', byId })
    const labelForSubmit = mirrorElement({ tag: 'label', forId: 'submit-btn', byId })
    const labelForText = mirrorElement({ tag: 'label', forId: 'text-field', byId })

    expect(classify(labelForSubmit)).toBe(true)
    // A label whose control does not submit never raises the ask.
    expect(classify(labelForText)).toBe(false)
  })

  it('forwards to the first nested control when the label has no for', () => {
    const nestedSubmit = mirrorElement({ tag: 'button', type: 'submit' })
    const wrappingLabel = mirrorElement({ tag: 'label', children: [nestedSubmit] })
    const innerSpan = mirrorElement({ tag: 'span', parent: wrappingLabel })
    // The click lands on the label's inner text and still submits the form.
    expect(classify(wrappingLabel)).toBe(true)
    expect(classify(innerSpan)).toBe(true)

    const nestedText = mirrorElement({ tag: 'input', type: 'text' })
    const textLabel = mirrorElement({ tag: 'label', children: [nestedText] })
    expect(classify(textLabel)).toBe(false)
  })

  it('skips a nested hidden input when forwarding to the label control', () => {
    // A hidden input is not labelable — Chromium forwards a label
    // activation to the first LABELABLE control — so tree-order-first over
    // `button, input` must not let a hidden CSRF token swallow the ask when
    // the real submit control follows it (B4 review follow-up).
    const hidden = mirrorElement({ tag: 'input', type: 'hidden' })
    const submit = mirrorElement({ tag: 'input', type: 'submit' })
    const label = mirrorElement({ tag: 'label', children: [hidden, submit] })
    expect(classify(label)).toBe(true)

    // The case-insensitive selector spelling: content `type=HIDDEN` is the
    // same non-labelable control as `type=hidden`.
    const upperHidden = mirrorElement({ tag: 'input', type: 'HIDDEN' })
    expect(classify(mirrorElement({ tag: 'label', children: [upperHidden, submit] }))).toBe(true)

    // A label wrapping ONLY a hidden input forwards to nothing: no ask.
    expect(classify(mirrorElement({ tag: 'label', children: [hidden] }))).toBe(false)
  })

  it('keeps the button/input ancestor climb and fails closed elsewhere', () => {
    const submitButton = mirrorElement({ tag: 'button', type: 'submit' })
    expect(classify(mirrorElement({ tag: 'span', parent: submitButton }))).toBe(true)
    expect(classify(mirrorElement({ tag: 'span', parent: mirrorElement({ tag: 'div' }) }))).toBe(false)
    // A formless submit control cannot submit anything the page recognizes.
    const formless = mirrorElement({ tag: 'button', type: 'submit', inForm: false })
    expect(classify(mirrorElement({ tag: 'span', parent: formless }))).toBe(false)
  })
})

/** Minimal plugin context for the tool-level assertions (the tools-spec shape). */
function fakePluginContext(executor: Partial<DesktopAgentBrowser> = {}) {
  const tools: Array<ToolDefinition & { name: string, execute(args: unknown, exec: unknown): Promise<unknown> }> = []
  const listeners: Array<{ event: string, listener: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown> }> = []
  const live = { open: true, url: 'https://example.test/page', title: 'Example', phase: 'observing' as const, generation: 2 }
  const attachments = {
    saveImage: vi.fn(async (input: { data: Uint8Array, name?: string }) => ({
      attachmentId: 'att-1',
      mediaType: 'image/jpeg' as const,
      bytes: input.data.byteLength + 897,
      width: 1280,
      height: 400,
      ...(input.name === undefined ? {} : { name: input.name }),
    })),
  }
  const context = {
    desktopPolicy: {
      locked: false,
      managedModels: false,
      requireSso: false,
      companyCatalogOrigin: null,
      companyManifestUrl: 'company-market/catalog-manifest.json',
      allowHomePatch: false,
      allowManualPluginAdd: false,
      trustRoots: [],
      usageReport: false,
      agentBrowser: ALLOWLIST_POLICY,
    } satisfies DesktopPolicy,
    desktopAgentBrowser: {
      describe: () => live,
      open: vi.fn(),
      navigate: vi.fn(),
      snapshot: vi.fn(),
      wait: vi.fn(),
      captureScreenshot: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), width: 1280, height: 400 })),
      click: vi.fn(),
      type: vi.fn(),
      scroll: vi.fn(),
      isSubmitControl: vi.fn(async () => false),
      claimControl: vi.fn(),
      releaseControl: vi.fn(),
      close: vi.fn(),
      ...executor,
    } as DesktopAgentBrowser,
    systemPrompt: {
      section: () => () => {},
      context: () => () => {},
    },
    tools: { register: (definition: ToolDefinition) => { tools.push(definition as never) } },
    on: (event: string, listener: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
      listeners.push({ event, listener })
      return () => {}
    },
    inject: () => {},
    get: (key: string) => {
      if (key === 'attachments') return attachments
      if (key === 'desktopAgentBrowser') return context.desktopAgentBrowser
      if (key === 'desktopPolicy') return context.desktopPolicy
      return undefined
    },
    logger: { info: vi.fn(), error: vi.fn() },
  }
  return {
    context: context as unknown as Context,
    tools,
    attachments,
    preExecute: () => listeners.find(entry => entry.event === 'tools/pre-execute')?.listener,
  }
}
