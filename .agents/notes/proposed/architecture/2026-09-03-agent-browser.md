# Agent Note: P8 Agent browser capability (agent-browser)

Status: Proposed

English | [ä¸­æ](2026-09-03-agent-browser.zh.md)

## Background and goals

P8 gives the DSH Desktop agent the ability to operate real web pages: an
embedded Chromium surface the agent can observe (DOM snapshot, screenshot),
act on (trusted input events), and hand to the human at any moment
(claimControl). The feasibility reference is Minke (github.com/lencx/Minke):
Electron `<webview>` + a hand-written CDP client over
`webContents.debugger` â no external browser download, login state is a
local partition, and the guest renders visibly for the human. We do NOT
copy Minke's shape: it vendors plugins into a burned-in checkout (our
red line) and carries ~4.8k lines of CDP code. Everything here lives in
`dsh-plugin-desktop` as dynamic host-plugin rows, over a minimal four-domain
CDP surface, targeting well under 1k lines for the CDP layer.

A second reference, trycua/cua (scout-cua), contributes design lessons
recorded in "External references" below: an action normalizer layer, the
policy-as-callback lifecycle pattern, context-management discipline, and an
explicit "backendNodeId first, coordinates fallback" observation doctrine.
Its weak danger-confirmation (URL blacklist still TODO) is treated as a
counter-example: our approval gate and claimControl follow the P8 red lines
from the dev-log card, not cua's.

Scope guard: `deepseek-harness/` submodule untouched; no changes to
`dsh-community-market` runtime; all host code in `dsh-plugin-desktop/src`,
client code in `dsh-plugin-desktop/src/client`, native window UI in
`dsh-plugin-desktop/src/native-ui`.

## 1. Window and mounting

**Decision: a dedicated native BrowserWindow, not a panel in the main window.**

- The main shell window is built by `window-options.ts` with `sandbox: true`
  and no `webviewTag`; the sso-gate even denies `will-attach-webview`
  outright. Enabling `webviewTag` on the primary renderer would widen the
  attack surface of the app's most trusted surface and place arbitrary web
  content under the web client's DOM. Rejected.
- The browser window follows the native-ui window precedent
  (`sso-gate-window.ts`, `profile-create-window.ts`): a sandboxed
  BrowserWindow loading a local document from the unpacked native-ui mirror
  (`unpackedAsarPath(fileURLToPath(new URL('./native-ui/agent-browser.html',
  import.meta.url)))`), new Vite input in `vite.native-ui.config.ts`.
- WebPreferences: `webviewTag: true`, `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`,
  `partition: <one-shot or persistent token>` (see Â§5). The `<webview>` tag
  in the document carries `allowpopups="false"` and no preload. The window's
  `will-attach-webview` handler scrubs guest webPreferences (drop any
  preload/node flags) exactly like Electron's security guidance; the guest
  webContents (obtained from `did-attach-webview`) gets
  `setWindowOpenHandler(() => ({ action: 'deny' }))`.
- Sizing: default 1120x760, min 720x540, `autoHideMenuBar`, dark background.
- Multi-instance: **one browser window per application** for v1. Tool calls
  serialize through a per-window mutex; the first agent session to use the
  surface holds it, later sessions receive a busy error naming the holder.
  Tabs and multi-window are explicit non-goals for v1 (the tool surface has
  no tab parameter, so a later tab dimension is additive).
- webview availability on our Electron (43.4.0): `<webview>` is still
  shipped (`did-attach-webview`/`will-attach-webview`,
  `webviewTag` option in `electron.d.ts`). Electron's posture remains "not
  recommended"; that risk and its fallback are recorded in Â§8. We never use
  the embedder-side webview scripting API (`executeJavaScript`, `send`,
  `insertCSS` on the element) â automation goes through CDP in the main
  process only. That both shrinks the CDP surface and closes the
  "embedder scripts the guest" hole.

## 2. IPC and process topology

**Correction to the task premise, verified in code**: the Cordis host tree is
booted IN the Electron main process â `src/main.ts` calls `boot()` (from
`@deepseek-ai/dsh-app-boot`) directly and provides the `ElectronDesktopRuntime`
instance into the host context (`hostCtx.provide('desktopRuntime', runtime)`).
The tool registry (`ctx.tools`), the agent loop, and Electron therefore share
one process. There is no host-subprocess hop to bridge.

- **Tools â executor**: same as `directory-picker`: the launcher provides a
  new narrow capability `desktopAgentBrowser` in main.ts's `prepare`
  callback (precedents: `desktopRuntime`, `desktopActions`,
  `desktopPnpmBootstrap`, `desktopPolicy`, `desktopCompanyCatalogHttp`).
  The host plugin `dsh-plugin-desktop/agent-browser` injects it and calls
  typed TS methods directly. `exec.signal` is forwarded so claimControl and
  turn cancellation abort in-flight CDP work.
- **Browser window UI**: main process pushes view-model snapshots with
  `webContents.send('dsh-agent-browser/state', vm)`; the window document
  uses a new dedicated preload (`agent-browser-preload.cjs`,
  `contextBridge.exposeInMainWorld`) exposing exactly
  `onState(cb) / claimControl() / releaseControl() / closeWindow()`.
  (Same shape as the file-path bridge in `preload.ts`; a separate file
  because `preload.cjs` belongs to the main shell window.)
- **Web client UI** (banner + tool cards): same-origin loopback routes on
  `ctx.webServer`, origin-checked like `DESKTOP_DIRECTORY_PICKER_PATH`:
  `GET/POST /_dsh/desktop/agent-browser/state|claim|release` plus an SSE
  route `/_dsh/desktop/agent-browser/events` (the WebServer route contract
  explicitly supports handlers that hold the response open). This works
  because the client renderer IS the loopback origin; the native window
  (file://) cannot use these routes â hence the preload bridge above.
- **Serialization**: JSON view-models
  `{ url, title, phase: 'idle'|'observing'|'acting'|'claimed', generation,
  actionDescription? }`; snapshots `{ url, title, generation, viewport,
  truncated, tree }` where `tree` is the text projection; screenshots are
  captured as JPEG bytes, persisted through `ctx.attachments.saveImage`
  â `ImageBlock` attachment refs (never raw base64 in the session log);
  SSE frames `{ kind: 'state'|'stale'|'navigation', ... }`. No secret-shaped
  value ever crosses any channel (see Â§5 password rules).

## 3. Minimal CDP surface

One `webContents.debugger.attach('1.3')` session on the guest webContents.

| Domain | Commands | Events |
|---|---|---|
| DOM | `enable`, `getDocument {depth, pierce:true}`, `getBoxModel`, `resolveNode` | `setChildNodes`, `childNodeInserted/Removed`, `shadowRootPushed/Popped` |
| Runtime | `callFunctionOn {objectId, returnByValue}`, `evaluate {contextId}` (isolated world only) | `executionContextCreated/Destroyed` |
| Input | `dispatchMouseEvent` (moved/pressed/released/wheel), `dispatchKeyEvent` (keyDown/char/keyUp with `windowsVirtualKeyCode`, `text`, modifiers), `insertText` | â |
| Page | `enable`, `navigate`, `getFrameTree`, `createIsolatedWorld`, `captureScreenshot {format:'jpeg', quality:60, clip}`, `setLifecycleEventsEnabled` | `frameNavigated`, `navigatedWithinDocument`, `loadEventFired`, `DOMContentLoaded` |

Explicitly out: Network, Emulation, Overlay, Fetch, Target auto-attach, and
`DOMSnapshot` (its compressed layout payload costs more parsing code than
the DOM-domain tree walk). Downloads and dialogs come from Electron-native
events (`session.on('will-download')`, guest `window.open` already denied).

**Ref / generation mechanism (the "few hundred lines" core):**

- `ref` IS the CDP `backendNodeId`, rendered `e<base36>`. The snapshot keeps
  only the set of live refs for validation; there is no side table to
  maintain. Refs survive DOM moves within a document and die with the
  document â exactly the Playwright/Minke semantics.
- `generation` is a monotonic counter bumped on: main-frame navigation
  (`frameNavigated`/`navigatedWithinDocument`), any DOM mutation event, and
  completion of `browser_open/navigate`. Act tools accept an optional
  `generation`; a mismatch fails with a `STALE_SNAPSHOT` error whose text
  tells the model to re-observe. Unknown `ref` fails `REF_NOT_FOUND`. ~60
  lines including listeners.
- Snapshot build: host-side walk of the `getDocument` tree (tag, role
  inference from tag/ARIA, text from `nodeValue`, bounded at ~5k nodes with
  a truncation marker). **Zero page-side script for observation** â the
  isolation story is "we never inject to look". The isolated world
  (`Page.createIsolatedWorld` on the main frame) is used ONLY for act-phase
  helpers (`focus()`, `scrollIntoView`/`scrollBy`, reading a non-secret
  input's value for VERIFY) as audited `callFunctionOn` snippets.
- Observation doctrine (scout-cua lesson 4): **backendNodeId first,
  coordinates as documented fallback**. v1 tools accept refs only; a
  coordinate click path (viewport CSS px, `getBoxModel` centers) exists in
  the executor for pages whose nodes cannot be resolved â enable behind the
  same click tool as `{x,y}` alternative in a later batch if field data
  demands it. Coordinates, when used, are CSS pixels in the guest viewport;
  screenshots declare their pixel dimensions alongside, so the cua-class
  "resolution alignment" hazard is avoided by construction.

## 4. Tool set and prompt injection

Registered with `defineTool` from the host plugin on the global layer of
`ctx.tools` (the locked build ships exactly one preset, `deloitte-standard`,
so global-layer registration is equivalent to preset visibility; a preset
`restrict()` trim stays possible later). Every tool declares
`output.schema` + `render` (canonical-value contract), a cooperative
`timeoutMs`, and is exclusive (`isConcurrencySafe` omitted).

| Tool | Parameters (canonical) | Returns | Notes |
|---|---|---|---|
| `browser_open` | `{ url, waitForLoad?: boolean }` | `{ url, title, generation }` | creates window/webview if needed; approval ask when target origin differs from policy baseline (Â§5) |
| `browser_navigate` | `{ url }` | same | alias on a live page |
| `browser_snapshot` | `{ generation?: number }` | `{ generation, url, title, truncated, tree }` | read-only; the OBSERVE primitive |
| `browser_click` | `{ ref, generation?, button?: 'left'\|'middle'\|'right', clickCount?: number }` | `{ generation, performed }` | box-model center â Input press/release; overlay highlights the ref |
| `browser_type` | `{ ref, text, generation?, clear?: boolean, submit?: boolean }` | `{ generation, performed }` | focus via isolated world; `insertText`; `submit` sends Enter (form submit â approval ask); password target â hard error pointing to claimControl |
| `browser_scroll` | `{ ref?, direction: 'up'\|'down', amount: number, generation? }` | `{ generation, performed }` | isolated-world scroll; wheel fallback for custom scrollers |
| `browser_wait` | `{ ms?, until?: 'load'\|'settle', timeoutMs? }` | `{ generation, waited }` | lifecycle events; settle = generation quiet T ms |
| `browser_screenshot` | `{ }` (v1 viewport only) | text block + `ImageBlock` | jpeg q60 downscaled â¤1280w; `attachments.saveImage`; presentation meta carries a prune hint |
| `browser_claim_control` | `{ reason }` | `{ claimed: true }` | model-side hand-off; act tools then fail-fast until the human releases |

**Action normalizer (scout-cua lesson 1)**: a pure `normalizeBrowserArgs()`
runs at the top of every act tool's `execute` â the declared schemas stay
canonical, but the normalizer accepts model-hallucinated aliases
(`click_type`/`left_click`/`single_click` â `click`; `coordinate:[x,y]` â
`x`/`y`; `element`/`ref_id` â `ref`; scheme-less `url` â `https://â¦`;
stringified numbers for `generation`). ~150 lines + an alias-matrix spec.
This is zero-cost reliability: the tool never rejects a semantically correct
call over spelling, and cua validated the class of hallucinations it fixes.

**Error taxonomy (scout-cua lesson 3)**: tool failures are classified before
returning â `STALE_SNAPSHOT`/`REF_NOT_FOUND` (self-correcting: error text
says the next step), `OPERATOR_HAS_CONTROL` (fail-fast), `DENIED_BY_POLICY`
(fatal), and transient CDP failures (debugger detach race, target busy)
which retry inside the executor with capped exponential backoff (â¤3 tries,
â¤2s total) before surfacing. Every error returns as an isError tool result
with corrective text â the "error backfeed" loop cua implements is the dsh
default because the registry materializes thrown errors as model-visible
results already.

**Prompt injection**: `ctx.systemPrompt.section({ name: 'agent-browser',
order: 150, ... })` registered from the host plugin â the same seam the
plan-mode section and harness identity use. Content: the OBSERVE â RESOLVE
â ACT â VERIFY discipline (snapshot before acting; only refs from the
latest generation; verify after each act via snapshot/screenshot; never
guess coordinates), password/credentials policy (never read, never type;
invite the human via claimControl), URL policy awareness, claimControl
etiquette, and screenshot frugality. Dynamic context (current page URL +
generation + claim state) rides `ctx.systemPrompt.context()` so each model
step sees the live surface without a tool call.

## 5. Security model (red lines â mechanisms)

1. **Dangerous-action approval** â reuse the existing seam, no new surface:
   the plugin registers a `tools/pre-execute` waterfall listener for its own
   tool names and returns `{ kind: 'ask', reason }` for: cross-origin
   navigation (origin change vs. current page), form submission
   (`submit:true` or Enter-into-form), and download initiation
   (`will-download` â v1 cancels and reports; a pre-ask is a batch-4
   refinement). `ask` resolves through the existing `ApprovalService`
   (`ctx.get('approval')`) into the standard client approval UI with audit
   pair (`approval/asked`/`decided`) â the same path `tools/pre-execute`
   ask-decisions already use fleet-wide.
2. **Partition token + login persistence** â default is a one-shot
   in-memory partition `dsh-agent-browser-<uuid>` created per browser
   session scope; cookies/cache die with it. Persistence requires BOTH the
   policy flag `agentBrowser.allowPersistLogin` (see 5) and an explicit,
   revocable user toggle (Desktop settings namespace, restart-applied;
   toolbar chip in the browser window). When enabled, the partition becomes
   `persist:dsh-agent-browser-<randomUUID>` stored under Electron userData
   (Chromium profile layout); cookie confidentiality rides the existing
   `enableCookieEncryption` fuse â no additional key material is
   introduced. A "clear login state" toolbar action destroys the partition
   directory.
3. **Password-field masking** â three enforcement points:
   (a) the snapshot walker is host-side and simply never emits `value` for
   `input[type=password]`, inputs with sensitive `autocomplete`
   (`current-password`, `new-password`, `cc-*`, `one-time-code`), and marks
   them `[password field: value hidden]`; (b) isolated-world helpers are an
   allowlist of audited snippets that read `value` only for non-secret
   inputs; (c) `browser_type` refuses password targets outright with an
   error directing the model to ask the human (claimControl) â typed
   credentials would otherwise live in tool arguments and logs. Screenshots
   need no special handling: native password rendering masks glyphs.
   `mask-secrets.ts` already scrubs token-shaped strings from any log line
   that does slip through.
4. **claimControl** â three entry points: always-visible button in the
   browser window toolbar, a banner action in the web client (loopback
   POST), and the model-facing `browser_claim_control` tool. On claim: the
   session flips to `claimed`, in-flight agent calls abort through their
   forwarded `exec.signal`, subsequent act tools fail-fast with
   `OPERATOR_HAS_CONTROL`, and the agent's synthetic input stops entirely â
   the human's real mouse/keyboard work natively (there is nothing to
   intercept). Release restores the agent with a generation bump (the page
   likely changed). The visual cursor overlay and ref highlight are drawn by
   the native-ui overlay layer from coordinates the executor already knows
   (`getBoxModel` before click; last dispatched mouse point) â no page CSS
   injection anywhere.
5. **URL policy** â a new embedded `desktop-policy` key
   `agentBrowser: { enabled: boolean, allowOrigins: string[], allowPersistLogin: boolean }`.
   Locked builds ship `enabled:false` until company config lands; dev
   policy ships `enabled:true, allowOrigins:['*']`. Enforcement: before
   `open/navigate`, and on the FINAL URL of every redirect chain
   (`frameNavigated` â a redirect that leaves the allowlist halts the load
   and errors). Non-allowlisted navigation is deny (not ask) when an
   allowlist is configured; ask applies to allowlisted-but-cross-origin
   transitions. Adding the key touches the strict parser (9â10 fields), the
   six-entry environment hand-off (6â7, CLI decode reconstructs the key as
   disabled), both `src/policy/*.json` assets, and `desktop-policy.spec.ts`
   â a bounded change fully covered by the existing spec.

**Renderer boundary**: all client-side code stays Node-free; the existing
`renderer-node-globals.spec.ts` machine gate automatically covers every new
file under `src/client` and `src/native-ui`. The `<webview>` element itself
is a DOM node in a sandboxed guest process â not a Node-global concern, and
the embedder never scripts it (Â§1). The client banner and tool cards are
plain React + same-origin fetch.

## 6. Batch plan

Batches are vertical, acceptance-testable slices; each lands green on
`yarn check` (typecheck + vitest + renderer gate).

**B1 â Read-only loop** (~4â5d): window + webview + CDP client + snapshot /
open / navigate / wait / screenshot + prompt section + policy-key skeleton.
Files: `agent-browser-contract.ts`, `agent-browser-cdp.ts`,
`agent-browser-session.ts`, `agent-browser-window.ts`, `agent-browser.ts`,
`native-ui/agent-browser/{agent-browser.html,main.tsx,App.tsx}`,
`agent-browser-preload.ts`; modifications: `package.json` (exports/files),
`tsdown.config.ts`, `vite.native-ui.config.ts`, `cordis.patch.yml` (new
host row), `desktop-policy.ts`, `src/policy/*.json`, `main.ts` (provide),
`index.ts` (route wiring stays inside the new plugin's apply).
Acceptance: fake-debugger CDP client spec; snapshot builder over fixture
`getDocument` payloads; ref/generation counter spec; window-options /
preload bridge spec; policy parse spec; renderer-node-globals regression;
manual dev smoke (open â snapshot â screenshot visible in window).

**B2 â Act loop** (~4â5d): click / type / scroll + normalizer + stale-ref
errors + pre-execute asks + password hard-refusal + overlay cursor/highlight
+ claim state machine (window button) + abort plumbing.
Files: `agent-browser-normalize.ts`, executor extensions, overlay
components. Acceptance: alias-matrix normalizer spec; ask-trigger matrix
(cross-origin nav, submit) against a stubbed approval service; password
refusal; STALE/REF_NOT_FOUND backfeed; claimed fail-fast + in-flight abort.

**B3 â Human collaboration + identity** (~3â4d): client banner + SSE route +
`browser_claim_control` + partition token lifecycle + persistLogin setting
behind policy + clear-login action. Files: `client/agent-browser-ui.tsx`
(+ registration in `client/index.ts`), SSE route in the plugin, partition
manager. Acceptance: SSE event projection spec; claim from all three
entries converges on one state machine; policy `allowPersistLogin:false`
makes the toggle unreachable; one-shot token leaves no partition dir after
close.

**B4 â Policy + hardening** (~3â4d): allowlist enforcement incl. redirect
chain and download cancel, screenshot prune hints consumed by
compaction-tool-result-pruner config, masked audit lines, red-line test
sweep, webview-fallback spike note. Files: `agent-browser-policy.ts`,
preset pruner config touch (`agent-presets/deloitte-standard/agent.cordis.yml`
pruning section), docs. Acceptance: allowlist specs incl. redirect-escape
and download refusal; prune hint spec; full `yarn check` + package spec
updates.

## 7. Risks and effort

- **Electron webview posture**: "not recommended" is a standing Electron
  doc position; the tag remains shipped in 43.x and Minke validates the
  exact composition. Mitigation: all webview dependence sits behind the
  window module (create/navigate/events); a fallback to a
  `WebContentsView`-hosted guest (automation identical, embedding visuals
  differ) is a contained rewrite of one file, spiked in B4.
- **debugger attach conflicts**: opening DevTools on the guest detaches our
  session (`detach` event) â handle by re-attach with one retry and a
  clear tool error; document that guest DevTools belongs to the human.
- **CDP surface maintenance**: four domains, all stable for years; the
  protocol is fetched through Electron's typed `Debugger` API, no
  websocket endpoint or version negotiation of our own.
- **Upstream 0.1.2 coupling**: five seams â `defineTool` output contract,
  `systemPrompt.section/context`, `ApprovalService` request shape,
  `attachments.saveImage`, `webServer.register` â plus the policy
  environment hand-off entry count (must be re-verified against any CLI-side
  decode change in 0.1.2). All are stable public contracts today.
- **Effort**: B1 4â5d, B2 4â5d, B3 3â4d, B4 3â4d â **14â18 person-days**
  including tests; excludes review latency. Matches the card's 1â2 week
  implementation window at 1â1.5 engineers.

## 8. External references (Minke / cua) â adoption record

| Idea | Source | Decision |
|---|---|---|
| `<webview>` + `webContents.debugger`, no external browser | Minke | Adopted (this design) |
| DOM snapshot via DOM domain + resolveNode; ref staleness | Minke | Adopted, with refs = backendNodeId and a single generation counter instead of per-element tracking |
| Real input via Input domain; screenshots via Page.captureScreenshot | Minke | Adopted unchanged |
| Burned-in vendored plugins; 4.8k-line CDP layer | Minke | Rejected â dynamic host-plugin rows, minimal four-domain surface |
| Action normalizer before parsing (left_clickâclick, coordinateâx/y) | cua `OperatorNormalizerCallback` | Adopted â `normalizeBrowserArgs()` inside tool execute (Â§4); ~150 lines |
| Policy plugins on lifecycle hooks (budget breaker, image retention, audit on on_llm_start/end/on_run_continue) | cua callbacks | Adopted as mapping onto EXISTING dsh seams: `tools/execute` wrappers (timeout policy precedent), `tools/post-execute`, compaction pruner, `systemPrompt.context` â no new loop mechanism is built |
| Keep only newest N screenshots in context (ImageRetention) | cua | Adopted via attachment-backed screenshots + prune hints consumed by `tool-result-pruner` (preset already configures it); capture-side downscale q60/â¤1280w |
| Resolution alignment declared for coordinate mapping | cua | Moot-by-construction here (CSS-px coordinates + declared screenshot dimensions); documented in Â§3 |
| Transient vs fatal error taxonomy with backoff; errors fed back as outputs | cua | Adopted (Â§4 error taxonomy); dsh's registry already materializes errors as model-visible results |
| backendNodeId-first, coordinates fallback | scout-cua synthesis | Adopted as doctrine (Â§3); v1 ships refs only, coordinate path reserved |
| cua's danger confirmation (URL blacklist TODO) | cua | Rejected as a model â our approval gate rides `tools/pre-execute`âApprovalService, URL policy rides the embedded policy file (Â§5) |
| `human_tool` queue (human as an adapter between agent turns) | cua | Rejected â too heavy; claimControl covers the human-in-the-loop need |

## File-level change list

New (dsh-plugin-desktop):
- `src/agent-browser-contract.ts` â route paths, view-models, state-machine types, `ctx.desktopAgentBrowser` declaration merge
- `src/agent-browser-cdp.ts` â typed minimal CDP client over `webContents.debugger`
- `src/agent-browser-session.ts` â window/webview lifecycle, ref+generation, claim state, serialization, abort
- `src/agent-browser-window.ts` â BrowserWindow + preload wiring + view-model push
- `src/agent-browser-preload.ts` â contextBridge for the window UI (built as `agent-browser-preload.cjs`)
- `src/agent-browser-normalize.ts` â action-argument normalizer
- `src/agent-browser-policy.ts` â URL allowlist + dangerous-action classification (B4)
- `src/agent-browser.ts` â host plugin: tools, prompt section, routes + SSE, policy gating
- `src/native-ui/agent-browser/{agent-browser.html,main.tsx,App.tsx,Overlay.tsx}` â toolbar, webview host, cursor/ref overlay
- `src/client/agent-browser-ui.tsx` â conversation banner + tool result cards (B3)
- `tests/agent-browser-{cdp,snapshot,tools,normalize,policy,route,client-ui}.spec.ts`

Modified:
- `package.json` â `exports` (`./agent-browser`), `files`, build inputs
- `tsdown.config.ts` â host + preload entries; `vite.native-ui.config.ts` â new HTML input
- `cordis.patch.yml` â insert `desktop-agent-browser` host row
- `src/desktop-policy.ts` â `agentBrowser` key (parser + env hand-off 6â7)
- `src/policy/desktop-policy.{dev,release}.json` â the new key
- `src/main.ts` â construct + `hostCtx.provide('desktopAgentBrowser', â¦)`
- `src/client/index.ts` â register the banner (B3)
- `agent-presets/deloitte-standard/agent.cordis.yml` â pruner threshold touch for screenshot retention (B4)

Untouched: `deepseek-harness/` submodule, `dsh-community-market` runtime, main-window webPreferences, existing approval surfaces.
