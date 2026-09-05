# Corporate network environment self-injection — proxy + CA bundle for sandboxed shells

[中文](2026-09-05-corporate-network-env.zh.md)

Status: **implemented** (branch `corporate-network-env`, commit chain on top
of `d6c989ae87`). This note records the corporate network model diagnosed on
the user's real machine, the self-injection design that fixes sandboxed shell
HTTPS without touching the runtime, the maintenance points, and the honest
boundaries of the approximation.

## The corporate network model (diagnosed 2026-09-05)

The company network enforces **two gates** on outbound HTTPS:

1. **Mandatory proxy** — direct TCP port 443 connects complete the TCP
   handshake but the TLS session never negotiates (the middlebox cuts it);
   only traffic through the corporate proxy reaches the internet. Proxy
   configuration may arrive via PAC, not a fixed host.
2. **TLS inspection** — the proxy re-signs certificates with the corporate
   inspection CA. A client that does not trust that CA fails the handshake
   even when it uses the proxy correctly.

Who passes which gate:

| Actor | Proxy gate | Trust gate | Why |
|---|---|---|---|
| Browser / Electron's Chromium (`net.fetch`, agent browser) | ✅ | ✅ | Uses the **system proxy resolver** (WinINET/WinHTTP, PAC included) and the **system certificate store** — both gates are OS services |
| PowerShell `Invoke-WebRequest` | ✅ | ✅ | Same two OS services (.NET honors system proxy + system store) |
| Desktop plugins (host-process `fetch`) | ✅ | ✅ | Same — they run inside the Electron/Node host that clears both gates |
| Sandboxed shell: `curl` (git's build), OpenSSL-based tools | ❌ | ❌ | Honors proxy **env vars** only, verifies against a **packaged CA file** — neither OS service is consulted |
| Sandboxed shell: bundled Node `fetch` (undici) | ❌ | ❌ | No proxy env by default; verifies against **compiled-in Mozilla roots** |

The observed symptom on the user's machine (DNS ok, ping ok, TCP/443 ok,
every HTTPS request "underlying connection closed") is exactly this
combination: TCP reachable, TLS killed — because the shell children fail
**both** gates simultaneously. This is why "it works in the browser" and
"it works in PowerShell" were red herrings: those actors never face the
gates the shell children face.

## The fix: self-injection in the Electron main process

`src/corporate-network-env.ts` (desktop plugin) resolves the same two facts
through the OS and returns them as **plain environment entries**;
`src/main.ts` merges them into `process.env` after `app.whenReady()` and
**before any child process spawns** (before pnpm runtime install, Host boot,
profile materialization):

```
resolveCorporateNetworkEnv(app)
├── proxy:  session.defaultSession.resolveProxy('https://registry.npmjs.org/')
│           → Chromium answers through the system resolver (PAC included)
│           → "PROXY host:port;PROXY …;DIRECT" → first directive → http(s)://host:port
└── CA:     spawn PowerShell (main process, NOT sandboxed)
            → export Cert:\LocalMachine\Root + Cert:\CurrentUser\Root + Cert:\LocalMachine\CA
            → deduplicated by thumbprint, PEM (base64 DER per certificate)
            → <userData>/corporate-ca-bundle.pem  (re-exported every launch via temp + rename)
```

### The injected key set (final)

| Key | Value | Condition |
|---|---|---|
| `HTTPS_PROXY` / `HTTP_PROXY` | resolved proxy URL, e.g. `http://10.172.64.36:80` | proxy detected (first directive; `DIRECT` → omitted) |
| `NO_PROXY` | intranet bypass list (below) | proxy detected |
| `NODE_USE_ENV_PROXY` | `1` | proxy detected **and** its URL scheme is http/https (see boundaries) |
| `NODE_EXTRA_CA_CERTS` | `<userData>/corporate-ca-bundle.pem` | bundle exported and non-empty |
| `SSL_CERT_FILE` | same path | same |
| `CURL_CA_BUNDLE` | same path | same |

`NODE_EXTRA_CA_CERTS` is **additive** (Node keeps its built-in roots plus the
bundle); `SSL_CERT_FILE` and `CURL_CA_BUNDLE` **replace** the default bundle
for OpenSSL/curl consumers — which is correct here, because the exported
Windows stores already contain the public roots plus the corporate
inspection CA.

`NODE_USE_ENV_PROXY=1` is what makes the proxy variables real for the
bundled Node runtime: undici's `fetch` reads `HTTP(S)_PROXY`/`NO_PROXY`
**only** when that flag is set (support landed in Node v22.21.0 and
v24.0.0; the bundled runtime is v22.23.2, so every sandboxed `node` child
has it). The flag rides along only for `http://`/`https://` proxy URLs —
Node's environment proxy understands no socks scheme, so a SOCKS
resolution still injects the proxy variables for curl/git/npm and records
one log line instead of the flag (see boundaries).

### Why assignment into `process.env` reaches the sandbox

The inheritance chain, verified link by link:

```
Electron main process.env
  └─(in-process Host boot; every spawn passes process.env or inherits it)
runtime / Host process
  └─(dsh-subprocess childEnv = scrubbedParentEnv() + caller overrides)
sandboxed pwsh / curl / node children
```

The one place names could be dropped is `scrubbedParentEnv()`
(`@deepseek-ai/dsh-subprocess`): it removes only credential-shaped names
(`KEY|PASSWORD|SECRET|TOKEN`, case-insensitive) and every `DSH_*` name.
All eight injected names survive by construction — the proxy bypass works
with **zero runtime changes** (a hard boundary for this work).

### Failure semantics — every path boots

- Not win32 → `{}`; no probe, no spawn (macOS dev and CI unchanged).
- Windows with no proxy detected (`DIRECT`) → only CA keys injected.
- CA export fails (PowerShell missing, non-zero exit, timeout 10 s, empty
  stores) → proxy keys only; one `logError` line; **a stale bundle from an
  earlier launch is deliberately not trusted** (only a successful export
  this launch proves this launch's stores).
- Any unexpected exception in the wiring → caught in `main.ts`, one
  `logError` line, boot continues bare — behavior identical to a
  non-corporate machine today.

## Maintenance point: the intranet bypass list

`INTRANET_NO_PROXY_ENTRIES` in `src/corporate-network-env.ts` is the single
place to extend when intranet hostnames evolve. Current content: loopback,
the RFC1918 range, the company domains, and the known hosts
(`gitlab.s.dai.deloitte.cn`, `sdp.deloitre.com.cn`, `ai.deloitre.com.cn`).

Each wildcard domain is spelled three ways (`*.deloitte.cn`, `deloitte.cn`,
`.deloitte.cn`) because NO_PROXY consumers disagree: libcurl suffix-matches
a bare domain and honors CIDR for IP ranges, Go's httpproxy and npm want a
`*.` prefix, undici's environment proxy agent wants a leading dot.
Redundant spellings are ignored by consumers that don't need them.

## Troubleshooting: shell HTTPS broken on a corporate machine

1. **Check the injection line** in the desktop log at startup:
   `corporate network environment injected (HTTPS_PROXY, …)` — if absent on
   Windows, the network resolved DIRECT or every step degraded (read the
   paired `logError` lines).
2. **Check the three facts inside a sandboxed shell**:
   `Get-ChildItem Env: | Where-Object Name -match 'PROXY|CA_CERTS|SSL_CERT_FILE|CURL_CA_BUNDLE'`
   — all keys present means the chain held.
3. **Check the bundle**: `<userData>/corporate-ca-bundle.pem` must exist and
   be non-empty (a few hundred KB of `BEGIN CERTIFICATE` blocks); if it is
   missing, find the `corporate CA export failed: …` log line for the
   reason (missing PowerShell, non-zero exit, timeout).
4. **Isolate the gate**: `curl.exe -v https://registry.npmjs.org/` — a
   certificate error with a proxy CONNECT succeeding means trust (CA) only;
   "connection closed" during CONNECT means proxy reachability or an
   inspection middlebox.

## Honest boundaries

- **PAC networks: static env is an approximation.** Chromium answers the
  proxy question for **one** probe URL (`registry.npmjs.org`). A PAC that
  routes other destinations differently, or fails over between proxies, is
  not expressible in `HTTPS_PROXY`; only the **first** directive of the
  resolution is injected. For the observed network (one proxy for all
  outbound) this is exact.
- **The bypass list must evolve with the intranet.** An intranet host not
  on `NO_PROXY` will be pushed at the corporate proxy and typically die
  there; the fix is one line in `INTRANET_NO_PROXY_ENTRIES`.
- **NO_PROXY wildcard semantics vary by consumer** — hence the triple
  spelling; a tool with a fourth dialect may still mismatch.
- **Bundle freshness is per-launch.** The bundle is rewritten at every
  startup; certificates pushed to the machine mid-session only take effect
  after the next desktop restart. Long-lived sessions keep the launch-time
  trust set.
- **Bundle tamper surface: same user = accepted.** The bundle lives in
  user-writable `userData` for the session's lifetime; a same-user process
  could swap it after export and every sandboxed child would then trust
  the attacker's CA via `SSL_CERT_FILE`/`CURL_CA_BUNDLE` (replacement
  semantics). `userData` is per-user ACL-protected and a same-user attacker
  already owns this app (PATH, config, DLL pre-placement), so this is an
  accepted risk, not a privilege boundary crossing. The export stages
  into a sibling `.tmp` file and renames it into place, so no child
  observes a half-written bundle and a failed export leaves the previous
  launch's file untouched; the stat→inject swap window shrinks to the
  rename itself.
- **SOCKS-only networks leave sandboxed Node `fetch` on its direct path.**
  `NODE_USE_ENV_PROXY` is withheld for socks resolutions because Node's
  environment proxy (undici) supports no socks scheme; sandboxed
  `curl`/`git`/`pnpm` still route through the socks proxy, and one log line
  records the withholding. Not a regression — direct TLS is cut by the
  middlebox on inspected networks anyway.
- **curl lower-case nuance**: curl reads `http_proxy` (lower case) for
  plain-HTTP proxying; on Windows the OS environment is case-insensitive so
  the upper-case injection resolves for Windows lookups, but a
  case-sensitive curl port that ignores `HTTP_PROXY` would need the lower-case
  spelling added.
- **Scope**: this changes nothing about the Electron/Chromium network stack
  itself (it already uses the OS services), nothing about the sandbox
  policy, and nothing in the runtime repo.
