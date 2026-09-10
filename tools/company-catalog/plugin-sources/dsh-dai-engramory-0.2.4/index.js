/**
 * dsh-dai-engramory — the Engramory memory discipline as a DeepSeek Harness plugin.
 *
 * Two things the always-on AGENTS.md block cannot do on its own:
 *
 *   1. A DETERMINISTIC index cap. dsh's `ctx.tools.guard()` is a synchronous,
 *      monotonic refusal — once a guard returns a reason, no later waterfall
 *      listener can turn it back into an allow. That makes it a stronger seam than
 *      most hosts expose, and it is why the 200-line / 25 KB limit can be enforced
 *      here rather than merely asked for. Without a shim like this one, everywhere
 *      except Claude Code the cap degrades to "rules plus a checker the agent has to
 *      remember to run".
 *   2. Skill delivery that does not depend on install paths. Registering at runtime
 *      sidesteps the five-root scan entirely, so the protocol is present because the
 *      plugin is loaded, not because a directory happened to be right.
 *
 * The decision table mirrors hooks/engramory_index_guard.py: deny only a write that
 * ENDS over a cap AND grew past the current file — a shrinking rewrite always passes,
 * so an over-cap index can be compacted incrementally (210 → 205 → 198). Only known
 * mutating tools are gated; `read` and unknown tools are never refused (the first cut
 * gated everything that named the index, which blocked recall of an over-cap index at
 * exactly the moment compaction was needed).
 *
 * Zero dependencies, no build step: plain ESM, node: builtins only.
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const name = 'engramory'

// `tools` carries the cap and is the plugin's only declared dependency. Cordis reads
// `inject` as an array of service names (or an object KEYED by them) and treats every
// entry as a hard wait — the `{ required, optional }` shape is older-Cordis syntax that
// the build dsh vendors resolves as services literally named "required"/"optional",
// which never appear, so the plugin sat pending forever (issue #8). `skills`/
// `commands` are deliberately NOT declared: the cap must mount even on a profile with
// no skill registry, and the recall gates are optional surfaces, so apply() probes
// them through nested ctx.inject() children instead.
export const inject = ['tools']

/** Mirrors hooks/engramory_index_guard.py — the caps are the protocol's, not this port's. */
const DEFAULT_INDEX_NAME = 'MEMORY.md'
const DEFAULT_MAX_LINES = 200
const DEFAULT_MAX_BYTES = 25600
/** How long a `/engramory` maintenance window stays open before auto-closing. */
const MAINTENANCE_WINDOW_MS = 5 * 60 * 1000 // 5 minutes; a safety backstop

/**
 * Recall mode. `global` (default) registers the always-on recall skill so memory is
 * recalled at the start of every task; `explicit` drops the always-on skill so memory
 * is recalled only when the user invokes `/engramory`; `off` registers neither, so
 * memory is never recalled. The choice is stored beside the index so it survives
 * restarts and is shared with the other hosts that read the same store.
 */
const DEFAULT_MODE = 'global'
const RECALL_MODES = new Set(['global', 'explicit', 'off'])
/** File holding the mode; plain text, one of the RECALL_MODES. */
const MODE_FILE = 'mode'

/** Tools that replace a file wholesale, so the post-write text is in the arguments. */
const WHOLE_FILE_WRITES = new Set(['write'])

/**
 * Tools that mutate a file in place. Only tools named here (plus
 * `str_replace_editor`'s write commands, handled explicitly) count as partial
 * writes. Unknown tools pass through: this guard is a discipline rail, not a
 * security boundary (SECURITY.md), and a false refusal of `read` costs more than a
 * miss — the next whole-file write is measured exactly regardless.
 */
const PARTIAL_WRITES = new Set(['edit', 'str_replace', 'insert'])

export function apply(ctx, config = {}) {
  // `indexPath` pins the guard to ONE file. Without it the only signal is the
  // basename, so an unrelated MEMORY.md in any other project is gated too — a real
  // refusal on a file that is not a memory index at all, with no way to opt out
  // (renaming `indexName` would just unguard the real index). The Claude Code hook
  // has had ENGRAMORY_INDEX_PATH for exactly this; this is its counterpart.
  //
  // The key and the basename are computed ONCE here: guards run on every tool call
  // and must stay cheap, so the per-call path stays a string compare and the single
  // realpath() only happens when the basename already matched.
  const indexPath = typeof config.indexPath === 'string' && config.indexPath.trim()
    ? config.indexPath.trim()
    : undefined
  const settings = {
    indexName: indexNameOf(config.indexName),
    indexPath,
    indexKey: indexPath === undefined ? undefined : pathKey(indexPath),
    // When pinned, the name to match is the pinned file's own basename.
    matchName: (indexPath === undefined
      ? indexNameOf(config.indexName)
      : basename(indexPath)).toLowerCase(),
    maxLines: positive(config.maxLines, DEFAULT_MAX_LINES),
    maxBytes: positive(config.maxBytes, DEFAULT_MAX_BYTES),
  }

  // Recall-mode controller shared by every surface that gates on it (the web
  // panel, the skill, the /engramory command, and the read guard). The mode lives
  // in the store so a restart and the other hosts reading the same folder see the
  // same choice.
  const memoryRoot = typeof config.memoryRoot === 'string' && config.memoryRoot.trim()
    ? config.memoryRoot.trim()
    : defaultMemoryRoot()
  const modeFile = join(memoryRoot, MODE_FILE)
  const mode = {
    value: readMode(modeFile, config.mode),
    // Subscribers re-run their effect when the mode changes. Kept a Set of
    // (`apply`, `dispose`) pairs so a switch is atomic: every registered surface
    // tears down to the new mode before any new surface registers.
    listeners: new Set(),
    on(applyFn) {
      const entry = { apply: applyFn, dispose: undefined, run: undefined }
      entry.run = () => {
        entry.dispose?.()
        entry.dispose = entry.apply(mode.value) ?? undefined
      }
      mode.listeners.add(entry)
      entry.run()
      return () => {
        entry.dispose?.()
        mode.listeners.delete(entry)
      }
    },
    set(next) {
      if (!RECALL_MODES.has(next) || next === mode.value) return
      mode.value = next
      writeMode(modeFile, next)
      for (const entry of [...mode.listeners]) entry.run()
    },
  }

  // A single monotonic guard. Two independent jobs share one gate so a mode flip
  // and a cap rule stay consistent in the same waterfall:
  //
  //   1. The write CAP (always on): refuse a write that would GROW the index past
  //      the 200-line / 25 KB limit. Returns a reason string; shrinking always
  //      passes.
  //   2. The read BLOCK (in `explicit` and `off`): refuse any read/list of a file
  //      inside the memory store. In `off` the model must not be able to reach the
  //      index or the note files by ANY path — `read`, `glob`, `grep`, or
  //      `str_replace_editor view` — so it has nothing to recall. In `explicit` it
  //      is the same hard block: standing rules (e.g. AGENTS.md) still nudge the
  //      model to auto-recall, and that must not silently smuggle the store in;
  //      manual recall is served by `/engramory`, which reads in plugin-side Node
  //      code (not through these file tools), so the command keeps working.
  const memoryRootKey = pathKeySafe(memoryRoot)
  // The maintenance window: a flag the /engramory command turns on so the model
  // can read AND write the store in the turn it triggers. In `explicit` (and `off`)
  // the guard otherwise refuses any read of the store — that is what stops
  // AGENTS.md standing rules from auto-recalling. But a `/engramory` maintenance
  // turn must be able to read the index/notes and write them back, so the window
  // lifts the read block (the write cap still applies). It is closed by the
  // turn/end listener below, plus a safety timer, so it can never stay open.
  let maintenance = false
  let maintenanceTimer = undefined
  const openMaintenance = () => {
    maintenance = true
    clearTimeout(maintenanceTimer)
    maintenanceTimer = setTimeout(() => { maintenance = false }, MAINTENANCE_WINDOW_MS)
    maintenanceTimer.unref?.()
  }
  const closeMaintenance = () => {
    maintenance = false
    clearTimeout(maintenanceTimer)
    maintenanceTimer = undefined
  }

  const guard = (exec) => {
    const recency = refuseOversizedIndex(exec, settings)
    if (recency !== undefined) return recency
    if (mode.value === 'global') return undefined
    // Inside an open maintenance window (a /engramory turn) the model is allowed
    // to read the store so it can review and update notes; still no auto-recall
    // outside a window.
    if (maintenance) return undefined
    return refuseStoreRead(exec, memoryRootKey, mode.value)
  }
  ctx.tools.guard(guard)

  // Close the maintenance window when the turn that opened it ends. `turn-stopping`
  // fires right before `turn/end`, so a `/engramory` turn's reads/writes are covered
  // and the window is not left open for the next turn to auto-recall. This is an
  // idempotent, safe close (it only clears the flag); the safety timer remains the
  // hard backstop if no turn event is available on a given host.
  ctx.on('agent/turn-stopping', () => closeMaintenance())

  // Store snapshot shared by the surfaces that need the store's shape: the Web
  // section, and `readStoreForRecall` (the /engramory command's plugin-side read).
  const store = {
    memoryRoot,
    indexPath: join(memoryRoot, settings.indexName),
    indexName: settings.indexName,
    maxLines: settings.maxLines,
    maxBytes: settings.maxBytes,
  }

  // Web surface (optional): the browser settings section reads the store status
  // and the recall mode, and writes the mode. Nested inject keeps this optional —
  // a host without webServer (headless / CLI) simply never mounts it, and the
  // cap/skill work regardless.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/engramory/status',
      handler: (_req, res) => sendJson(res, { ...memoryStatus(store), mode: mode.value }),
    }), 'engramory: memory status route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/engramory/mode',
      handler: (req, res) => setModeRoute(req, res, mode),
    }), 'engramory: recall mode route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/engramory/memories',
      handler: (_req, res) => sendJson(res, listMemories(store, mode.value)),
    }), 'engramory: memory files route')
  })

  // The recall skill is registered only when it tells the model to recall on its
  // own. In `global` the skill is the always-on auto-recall seat; in `explicit`
  // and `off` it is not registered, so nothing nudges the model to read memory
  // unprompted — `explicit` still has the /engramory command, `off` has neither.
  if (config.registerSkill !== false) {
    ctx.inject(['skills'], (inner) => {
      const skill = config.skill ?? builtinSkillBody()
      // effect() ties the registration to the child fiber: it is disposed when the
      // registry unloads, so a reload cannot accumulate duplicate registrations.
      inner.effect(() => mode.on((recallMode) => {
        // Guard the transition: unwinding the previous registration before
        // registering the next keeps a mode flip from stacking two skills.
        if (recallMode === 'global') {
          return inner.skills.register({
            name: 'engramory',
            description:
              'Curated file-based long-term memory: recall through MEMORY.md at the start of ' +
              'a task, save durable user/feedback/project/reference facts, run a curation ' +
              'checkpoint when a task finishes, and sync before compacting or opening a ' +
              'fresh thread. A turn that starts no work — a greeting, an acknowledgement — ' +
              'is not a task and needs none of this, but never judge that by length: a ' +
              'one-word reply continuing work underway inherits that task.',
            whenToUse:
              'Starting or resuming work, learning something durable worth a future session, ' +
              'finishing a task — including one that leaves nothing worth saving, since the ' +
              'checkpoint is still a decision to make — or approaching a ' +
              'compact/clear/new-thread boundary. Not for a bare greeting, ' +
              'acknowledgement, or reaction, which starts no task — but a terse reply ' +
              'that continues work underway does, and material already in hand (a ' +
              'pasted diff to review) does not make work a non-task. Unsure? Treat it ' +
              'as a task.',
            source: 'runtime',
            content: skill,
            // Keep the skill model-invocable (the model loads it on its own when
            // deciding to recall/protect memory) but NOT user-invocable, so it does
            // not also occupy the `/engramory` slash-command slot alongside the
            // real `/engramory` command below — that duplication showed up as two
            // same-named entries in the command menu. The user-facing entry point
            // is exclusively the command; the skill is an internal recall seat.
            invocation: { modelInvocable: true, userInvocable: false },
          })
        }
        return () => {}
      }))
    })
  }

  // `/engramory` forces one recall pass on demand. `global` and `explicit` both
  // register it; `off` omits it entirely, so there is no path — auto or manual —
  // that reaches the memory. The handler reads the store DIRECTLY in plugin-side
  // Node code (index + referenced notes) and injects that content as a user
  // message — it does NOT ask the model to `read` the files. That matters for
  // `explicit`: the file-tool guard blocks the model from reading the store on its
  // own (so standing rules cannot smuggle an auto-recall), yet the command still
  // needs to work. Because the read happens here, outside those file tools, the
  // guard never sees it and `/engramory` keeps working in `explicit`. The message
  // is still built with a DYNAMIC import of `@deepseek-ai/dsh-llm` so this plugin
  // keeps zero static dependencies (its test suite runs standalone, outside the
  // harness's node_modules); the import only resolves when a real host invokes the
  // command.
  if (config.registerCommand !== false) {
    ctx.inject(['commands'], (inner) => {
      inner.effect(() => mode.on((recallMode) => {
        if (recallMode === 'off') return () => {}
        return inner.commands.register({
          name: 'engramory',
          description: 'Recall Engramory memory (read MEMORY.md and apply relevant notes to the current task).',
          handler: async (invocation) => {
            const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
            // Open the maintenance window so the model can, in this turn, both
            // recall AND update the store (read notes, edit them, write the
            // index) without tripping the explicit-mode read block. The window
            // is closed on turn/end or by the safety timer below.
            openMaintenance()
            const recall = readStoreForRecall(store, settings)
            const text = recall.ok
              ? recall.body
              : 'Engramory: could not read the memory store: ' + recall.error
            invocation.agent.followup(createUserMessage({
              content: [{
                type: 'text',
                text: 'User invoked /engramory: recall Engramory memory as background context for the current task, ' +
                  'and apply any of it that is worth storing or updating. The store contents are below. ' +
                  'You may read the memory files and write/update notes as needed for this maintenance ' +
                  '(a maintenance window is open for this turn). Treat existing content as background that may be stale:\n\n' + text,
              }],
              source: { kind: 'user' },
            }))
            return { kind: 'success', text: 'Engramory memory recall requested.' }
          },
        })
      }))
    })
  }
}

/**
 * Read the memory store for a manual recall pass, entirely in plugin-side Node
 * (index + the note files the index points at), so it bypasses the file-tool guard
 * that blocks the model from reading the store on its own. Returns
 * `{ ok: true, body }` with the assembled text, or `{ ok: false, error }`.
 */
function readStoreForRecall(store, settings) {
  const indexPath = join(store.memoryRoot, settings.indexName)
  let indexText
  try {
    indexText = readFileSync(indexPath, 'utf8')
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  // Which note filenames does the index point at? The index uses markdown links
  // `[...](slug.md)` (the template and the real store both do), but `[[wikilink]]`
  // is also accepted — resolve both to a sibling `*.md`.
  const refs = new Set()
  for (const m of indexText.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const slug = m[1].split('#')[0].trim()
    if (!slug) continue
    refs.add(slug.endsWith('.md') ? slug : slug + '.md')
  }
  for (const m of indexText.matchAll(/\]\(([^)]+\.md)\)/g)) {
    const rel = m[1].trim()
    if (!rel) continue
    refs.add(basename(rel))
  }
  const parts = [`# Engramory memory index (${settings.indexName})\n`, indexText]
  for (const name of [...refs].sort()) {
    const notePath = join(store.memoryRoot, name)
    let raw
    try {
      raw = readFileSync(notePath, 'utf8')
    } catch {
      continue // a referenced note that is missing/unreadable is skipped, not fatal
    }
    parts.push(`\n\n## ${name}\n${raw}`)
  }
  return { ok: true, body: parts.join('') }
}

/**
 * The cap itself. Returning a string denies the call; `undefined` lets it through.
 *
 * Guards are synchronous by contract, so this stays cheap: one basename comparison
 * rejects the overwhelming majority of calls before anything is measured, and the
 * only I/O is a single read of the index on a gated write.
 */
function refuseOversizedIndex(exec, settings) {
  const args = exec?.arguments
  if (!args || typeof args !== 'object') return undefined

  // dsh's file tools carry the target as `file_path`; `str_replace_editor` calls it
  // `path`. Compare basenames case-INsensitively: on the case-insensitive
  // filesystems most stores live on (Windows/macOS), `memory.md` IS the guarded
  // index, and an exact compare let that spelling through. (Same trade-off as the
  // Python guard: on a case-sensitive FS this can gate an unrelated lowercase twin —
  // rename it, or point `indexName` elsewhere.)
  const filePath = typeof args.file_path === 'string' ? args.file_path
    : typeof args.path === 'string' ? args.path
      : undefined
  if (filePath === undefined) return undefined
  if (basename(filePath).toLowerCase() !== settings.matchName) return undefined

  const tool = typeof exec.name === 'string' ? exec.name : ''

  // Nothing below can refuse a read, a view, or an unknown tool, so leave before the
  // pinned-path check: pathKey() touches the filesystem and a guard runs on EVERY tool
  // call. Ordering it here keeps the common case a pair of string compares.
  const gated = WHOLE_FILE_WRITES.has(tool)
    || PARTIAL_WRITES.has(tool)
    || (tool === 'str_replace_editor'
      && (args.command === 'create' || args.command === 'str_replace'
        || args.command === 'insert'))
  if (!gated) return undefined
  // If the guard is pinned to one file, this is where an unrelated same-named file in
  // another project drops out.
  if (settings.indexKey !== undefined && pathKey(filePath) !== settings.indexKey) {
    return undefined
  }

  if (WHOLE_FILE_WRITES.has(tool)) {
    if (typeof args.content !== 'string') return undefined
    return verdict(args.content, readIfPossible(filePath), filePath, settings)
  }
  if (tool === 'str_replace_editor' && args.command === 'create') {
    if (typeof args.file_text !== 'string') return undefined
    return verdict(args.file_text, readIfPossible(filePath), filePath, settings)
  }

  const partial = PARTIAL_WRITES.has(tool)
    || (tool === 'str_replace_editor'
      && (args.command === 'str_replace' || args.command === 'insert'))
  if (!partial) return undefined // read / view / list / unknown: never refused

  const currentBuf = readIfPossible(filePath)
  if (currentBuf === undefined) return undefined
  const current = currentBuf.toString('utf8')
  const simulated = simulateEdit(current, args)
  if (simulated !== undefined) {
    return verdict(simulated, currentBuf, filePath, settings)
  }

  // The edit's result genuinely cannot be reconstructed from its arguments. Honest,
  // cheap rule: if the index is ALREADY over, refuse to mutate it blind — and name
  // the open door, because "compact first" while refusing edits reads as a dead end.
  const breach = measure(current, settings)
  if (!breach) return undefined
  return (
    `${displayName(settings)} is already over the Engramory cap (${breach}) and this ` +
    `edit's result cannot be measured. Compact it with a whole-file write instead: ` +
    `a rewrite that SHRINKS the index always passes, even while still over the cap. ` +
    `Pointer-ify over-long lines, merge duplicates, archive cold notes — the index ` +
    `is a table of contents, and anything past the cap silently stops being recalled.` +
    notMyIndexHint(settings)
  )
}

/**
 * Mirrors the Python guard's deny rule: refuse only when a dimension ends OVER its
 * cap AND grew past the current file, so a shrinking/keeping write on an over-cap
 * index always passes and incremental compaction stays possible. A missing or
 * unreadable current file counts as empty — a first write past the cap is refused.
 */
function verdict(text, currentBuf, filePath, settings) {
  const lines = countLines(text)
  const bytes = Buffer.byteLength(text, 'utf8')
  // Current byte size comes from the RAW buffer, mirroring how the Python guard
  // sizes the on-disk file: decoding first inflated a non-UTF-8 index ~3x (every
  // bad byte becomes a 3-byte U+FFFD), which made a genuinely growing write look
  // like a shrink and pass. Newlines survive a lossy decode, so the line count may
  // use the decoded text.
  const curLines = currentBuf === undefined ? 0 : countLines(currentBuf.toString('utf8'))
  const curBytes = currentBuf === undefined ? 0 : currentBuf.length
  const over = []
  if (lines > settings.maxLines && lines > curLines) {
    over.push(`${lines} lines > ${settings.maxLines}`)
  }
  if (bytes > settings.maxBytes && bytes > curBytes) {
    over.push(`${bytes} bytes > ${settings.maxBytes}`)
  }
  if (!over.length) return undefined
  return (
    `This write would put ${basename(filePath)} over the Engramory index cap ` +
    `(${over.join(', ')}). The index is loaded every session and the host only reads ` +
    `so far, so anything past the cap silently stops being recalled. Compact before ` +
    `writing: move detail into the linked note files, merge duplicates, archive cold ` +
    `notes, and keep every line to "one short hook + link". A write that SHRINKS the ` +
    `index always passes, so you can compact step by step.` + notMyIndexHint(settings)
  )
}


/**
 * The name to show in a refusal. `indexPath` wins over `indexName` when both are set,
 * so quoting the ignored one would send a user looking for the wrong file.
 */
function displayName(settings) {
  return settings.indexPath === undefined
    ? settings.indexName
    : basename(settings.indexPath)
}


/**
 * Without `indexPath` the guard matches on basename alone, so it can land on a file
 * that is not a memory index at all. Say so in the refusal: a user who hits this
 * needs the way out, not just the cap.
 */
function notMyIndexHint(settings) {
  if (settings.indexPath !== undefined) return ''
  return (
    ` (If this file is NOT your memory index, set this plugin's \`indexPath\` config ` +
    `to your real index's absolute path so only that file is gated.)`
  )
}

/**
 * Reconstruct a partial edit's post-write text when its arguments carry enough to
 * do it (`old_str`/`new_str`, or the Claude-style `old_string`/`new_string`).
 * Mirrors the Python guard's Edit simulation: replace the unique occurrence, or all
 * of them under a replace-all flag; an absent or ambiguous old-string means the
 * real tool errors and changes nothing, so the current text is the honest
 * prediction. Returns undefined when the shape isn't recognised.
 */
function simulateEdit(current, args) {
  const oldStr = firstString(args.old_str, args.old_string)
  if (oldStr === undefined || oldStr === '') return undefined
  const newStr = firstString(args.new_str, args.new_string) ?? ''
  if (args.replace_all === true || args.replaceAll === true) {
    return current.split(oldStr).join(newStr)
  }
  const first = current.indexOf(oldStr)
  if (first === -1) return current // the real tool errors: nothing changes
  const second = current.indexOf(oldStr, first + oldStr.length)
  if (second !== -1) return current // ambiguous: the real tool errors, nothing changes
  return current.slice(0, first) + newStr + current.slice(first + oldStr.length)
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string') return v
  }
  return undefined
}

/** Returns a human-readable breach description, or `null` when the text is within caps. */
function measure(text, { maxLines, maxBytes }) {
  const lines = countLines(text)
  const bytes = Buffer.byteLength(text, 'utf8')
  const over = []
  if (lines > maxLines) over.push(`${lines} lines > ${maxLines}`)
  if (bytes > maxBytes) over.push(`${bytes} bytes > ${maxBytes}`)
  return over.length ? over.join(', ') : null
}

/** Trailing-newline-insensitive, matching how the Python guard counts. */
function countLines(text) {
  if (!text) return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/**
 * A missing or unreadable index is not a breach: the guard's job is to stop an
 * oversized index, never to block work because a path could not be read. Returns the
 * RAW buffer — byte comparisons must use on-disk bytes (see verdict), decode at the
 * call sites that need text.
 */
function readIfPossible(filePath) {
  try {
    return readFileSync(filePath)
  } catch {
    return undefined
  }
}

function positive(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  return floored > 0 ? floored : fallback
}

/**
 * The conventional store location: `~/.dsh/.engramory-memory/` (the same path
 * the AGENTS.md memory block points at). Overridable per-deployment with
 * `config.memoryRoot`.
 */
function defaultMemoryRoot() {
  return join(homedir(), '.dsh', '.engramory-memory')
}

/**
 * Snapshot the store for the settings page. Reads are best-effort: a missing
 * or unreadable index is reported as empty (size 0), never as an error that
 * blanks the section.
 */
function memoryStatus(store) {
  let raw
  try {
    raw = readFileSync(store.indexPath)
  } catch {
    raw = undefined
  }
  const text = raw === undefined ? '' : raw.toString('utf8')
  const bytes = raw === undefined ? 0 : raw.length
  return {
    memoryRoot: store.memoryRoot,
    indexPath: store.indexPath,
    indexName: store.indexName,
    present: raw !== undefined,
    lines: countLines(text),
    bytes,
    maxLines: store.maxLines,
    maxBytes: store.maxBytes,
  }
}

/**
 * List every memory note for the settings 记忆文件 detail view: the index plus
 * all sibling `*.md` note files (archived/transient files excluded), each with
 * its parsed frontmatter, body, whether the index points at it, and byte size.
 * Read-only and best-effort — a note that cannot be read is reported with an
 * error flag rather than failing the whole listing.
 */
function listMemories(store, mode) {
  const memoryRoot = store.memoryRoot
  const files = []
  let names = []
  try {
    names = readdirSync(memoryRoot)
  } catch {
    /* missing root: empty list below */
  }
  for (const name of names.sort()) {
    if (!name.toLowerCase().endsWith('.md')) continue
    const abs = join(memoryRoot, name)
    const isIndex = basename(name).toLowerCase() === store.indexName.toLowerCase()
    let raw
    try {
      raw = readFileSync(abs)
    } catch {
      files.push({ name, isIndex, present: false, error: 'unreadable' })
      continue
    }
    const text = raw.toString('utf8')
    const { frontmatter, body } = parseFrontmatter(text)
    files.push({
      isIndex,
      bytes: raw.length,
      lines: countLines(text),
      ...frontmatter,
      // The real filename (with `.md`) must win over any frontmatter `name:`
      // slug, because `referenced` below is built from the index's `](…\.md)`
      // links, which use the filename. A bare slug would never match, so every
      // note would show as unreferenced in the settings list.
      name,
      body,
    })
  }
  // Which note filenames does the index actually point at?
  let indexText = ''
  try {
    indexText = readFileSync(join(memoryRoot, store.indexName)).toString('utf8')
  } catch { /* absent index */ }
  const referenced = new Set()
  for (const m of indexText.matchAll(/\]\(([^)]+\.md)\)/g)) {
    referenced.add(m[1])
  }
  return {
    memoryRoot,
    mode,
    indexName: store.indexName,
    maxLines: store.maxLines,
    maxBytes: store.maxBytes,
    files,
    referenced: [...referenced],
  }
}

/**
 * Parse Engramory frontmatter: a leading `---`-fenced `key: value` block (a
 * restricted subset — no nested YAML, one line per field, optionally quoted).
 * Returns the plain field values plus the body after the block. Any malformed
 * or unquoted trailing-quote quirks are tolerated (best-effort display only).
 */
function parseFrontmatter(text) {
  const first = text.indexOf('---')
  if (first !== 0) return { frontmatter: {}, body: text }
  const end = text.indexOf('\n---', first + 3)
  if (end === -1) return { frontmatter: {}, body: text }
  const block = text.slice(first + 3, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const frontmatter = {}
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    // Strip one matching trailing/leading quote pair, keep any interior text.
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"'
      || value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
      value = value.slice(1, -1)
    }
    if (key) frontmatter[key] = value
  }
  return { frontmatter, body: body.trim() }
}

/** Write a small JSON response; no CORS, same-origin browser fetch only. */
function sendJson(res, body) {
  const payload = JSON.stringify(body)
  res.statusCode = 200
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

/**
 * Read the persisted recall mode. A missing file, an unreadable file, or an unknown
 * value falls back to the configured default (config wins over the file, matching
 * how the caps resolve); a corrupt value is not an error — it decays to the default
 * and the next write repairs the file.
 */
function readMode(modeFile, configMode) {
  // An explicitly configured mode wins outright (matches how the caps resolve).
  if (configMode !== undefined) {
    return RECALL_MODES.has(configMode) ? configMode : DEFAULT_MODE
  }
  let raw
  try {
    raw = readFileSync(modeFile, 'utf8')
  } catch {
    return DEFAULT_MODE
  }
  const value = raw.trim()
  return RECALL_MODES.has(value) ? value : DEFAULT_MODE
}

/** Persist the mode. Best-effort: a writable store is not guaranteed on every host. */
function writeMode(modeFile, value) {
  try {
    mkdirSync(dirname(modeFile), { recursive: true })
    writeFileSync(modeFile, value, 'utf8')
  } catch {
    /* the in-process value still holds; the file is repaired on the next successful write */
  }
}

/** Handle `POST /engramory/mode`: read the JSON body `{ mode }`, validate, persist. */
function setModeRoute(req, res, mode) {
  let body = ''
  req.on('data', (chunk) => { body += String(chunk) })
  req.on('end', () => {
    let next
    try {
      next = JSON.parse(body).mode
    } catch {
      sendJson(res, { ok: false, error: 'expected {"mode":"global"|"explicit"|"off"}' })
      return
    }
    if (!RECALL_MODES.has(next)) {
      sendJson(res, { ok: false, error: `unknown mode "${String(next)}"` })
      return
    }
    mode.set(next)
    sendJson(res, { ok: true, mode: mode.value })
  })
}

/**
 * Normalise a path for identity comparison. `realpath` resolves symlinks and `..` so
 * two spellings of the same file compare equal, but it throws for a path with no file
 * behind it yet — and a plain `resolve` fallback is NOT interchangeable with it: an
 * index pinned before it exists, under a symlinked ancestor, would be keyed by its
 * alias at config time and by the link's target on every later call. The keys would
 * never match again and the guard would silently stop guarding its own index.
 *
 * So resolve the deepest ancestor that DOES exist and re-attach the missing tail:
 * the same file then keys identically whether or not it exists yet. Case is folded on
 * Windows only, mirroring `os.path.normcase` in the Python guard — folding it on Linux
 * would make an unrelated `memory.md` collide with the pinned index. (Known limit:
 * `toLowerCase` is not NTFS's exact case-folding table, same as the Python guard.)
 */
function pathKey(p) {
  let head = resolve(p)
  const tail = []
  for (;;) {
    try {
      head = realpathSync(head)
      break
    } catch {
      const parent = dirname(head)
      if (parent === head) break // hit the root with nothing resolvable
      tail.unshift(basename(head))
      head = parent
    }
  }
  const out = tail.length ? join(head, ...tail) : head
  return process.platform === 'win32' ? out.toLowerCase() : out
}

/**
 * Like `pathKey`, but never throws for a non-string input (the guard runs on EVERY
 * tool call and must stay cheap and total). Used to key the store root for the
 * `off`-mode read block.
 */
function pathKeySafe(p) {
  if (typeof p !== 'string' || p.length === 0) return undefined
  try {
    return pathKey(p)
  } catch {
    return resolve(p)
  }
}

/**
 * `off`-mode read block. Returns a denial string when the call would READ or LIST a
 * file inside the memory store (the index or a note), so the model has no way to
 * recall memory. Only the read-ish tools are refused; writes still pass through to
 * the normal cap guard, and everything outside the store root is untouched.
 *
 * Recognition is path-identity based: the target resolves to a real path and we ask
 * whether it lives under the store root. `read`/`view` carry `file_path`/`path`;
 * `glob`/`grep` carry a `path` search root whose results would reveal store files.
 */
function refuseStoreRead(exec, memoryRootKey, mode) {
  const args = exec?.arguments
  if (!args || typeof args !== 'object') return undefined
  if (memoryRootKey === undefined) return undefined
  const tool = typeof exec.name === 'string' ? exec.name : ''

  if (tool === 'read') {
    if (typeof args.file_path !== 'string') return undefined
    return storeReadDenial(args.file_path, memoryRootKey, mode)
  }
  if (tool === 'str_replace_editor' && args.command === 'view') {
    if (typeof args.path !== 'string') return undefined
    return storeReadDenial(args.path, memoryRootKey, mode)
  }
  // A list/search rooted inside the store can surface the index and notes.
  if (tool === 'glob' || tool === 'grep') {
    const root = typeof args.path === 'string' ? args.path
      : typeof args.pattern === 'string' ? args.pattern
        : undefined
    if (root === undefined) return undefined
    return storeReadDenial(root, memoryRootKey, mode)
  }
  // A shell command can read the store by path even though `read`/`view` are
  // refused (the model reached the index with `cat <store>/MEMORY.md`). In `off`
  // (and `explicit`) no shell command may touch the memory store at all — the
  // store is only reached through the guarded file tools or the plugin-side
  // `/engramory` read, never a paste-able `cat`/`ls`/`grep`. Match the store's
  // distinctive directory name so `~`, `$HOME`, absolute, and relative spellings
  // all resolve; path identity on every token would be fragile and slow here, and
  // a false hit only fires on a command that names the store — which is exactly
  // what must not happen in these modes.
  if (tool === 'bash' || tool === 'pwsh') {
    const command = typeof args.command === 'string' ? args.command
      : typeof args.commands === 'string' ? args.commands
        : undefined
    // The store's directory basename is its distinctive, host-readable marker
    // (normally `.engramory-memory`). Matched by text so `~`, `$HOME`, absolute,
    // and relative spellings are all caught, not just the canonical full path.
    const storeDirName = typeof memoryRootKey === 'string' ? basename(memoryRootKey) : ''
    if (command !== undefined && shellTouchesStore(command, storeDirName)) {
      return mode === 'off'
        ? 'Engramory memory is disabled (mode "off"): a shell command that touches the memory store is ' +
          'refused so nothing can be recalled through bash. Switch the recall mode to global in ' +
          'Settings → engramory配置 to re-enable it.'
        : 'Engramory is in recall mode "explicit": a shell command that touches the memory store is ' +
          'refused (memory is only recalled when you invoke /engramory). The /engramory ' +
          'command reads the store for you; do not read these files with bash.'
    }
  }
  return undefined
}

/**
 * Detect a shell command that names the memory store. Rather than parsing a whole
 * POSIX/PowerShell language, look for the store's directory basename (its unique,
 * host-readable marker) — a command that literally writes that name is a shell
 * attempt at the store, and in `explicit`/`off` there is no legitimate reason to
 * shell into it. Cheap and false-positive-free enough for a guard that runs on
 * every tool call.
 */
function shellTouchesStore(command, storeDirName) {
  if (typeof storeDirName !== 'string' || storeDirName.length === 0) return false
  const q = String.fromCharCode(39) // ' — the only regex-special char in a dir name
  let re
  try {
    // Escape any regex-special chars; the basename is normally plain.
    re = new RegExp(storeDirName.split('').map((c) => /[.\\^$*+?()[\]{}|]/.test(c) ? '\\' + c : c).join(''))
  } catch {
    return false
  }
  return re.test(command)
}

/** One denial check: is the target inside the store root? `mode` is the current recall mode. */
function storeReadDenial(target, memoryRootKey, mode) {
  const targetKey = pathKeySafe(target)
  if (targetKey === undefined) return undefined
  const sep = process.platform === 'win32' ? '\\' : '/'
  if (targetKey !== memoryRootKey && !targetKey.startsWith(memoryRootKey + sep)) {
    return undefined
  }
  return mode === 'off'
    ? 'Engramory memory is disabled (mode "off"): reading files in the memory store is ' +
      'refused so nothing can be recalled. Switch the recall mode to global in ' +
      'Settings → engramory配置 to re-enable it.'
    : 'Engramory is in recall mode "explicit": auto-reading the memory store on your own ' +
      'is refused (memory is only recalled when you invoke /engramory). The /engramory ' +
      'command reads the store for you; do not read these files directly.'
}


/**
 * An empty or non-string indexName must fall back, not silently disable the cap:
 * the numeric caps already recover from nonsense values, and this field is the one
 * that decides whether the guard fires at all.
 */
function indexNameOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_INDEX_NAME
}

/**
 * The always-on block states the discipline; this is the on-demand detail the model
 * pulls when it is actually about to recall, write, or sync. Kept deliberately short —
 * the full protocol is SKILL.md in the Engramory repo, and a skill body that has to be
 * read before it is useful is a skill that will not be read.
 */
function builtinSkillBody() {
  return [
    '# Engramory — curated file-based memory',
    '',
    'One canonical store: `MEMORY.md` is an index of pointers, one line per memory;',
    'each fact lives in its own small markdown file beside it. Never put content in',
    'the index, and never keep a second parallel store for handoffs. The ACTIVE',
    'store is flat — the four type names are values of the `type:` field, not',
    'subdirectories to create; `archive/` is the one reserved subdirectory, for',
    'notes retired out of the index.',
    '',
    '## Recall',
    '',
    'A turn, a message, or a session is NOT BY ITSELF a task: a greeting, an',
    'acknowledgement, or a reaction starts none, so it gets no recall and no',
    'checkpoint. A task is user-directed work whose CORRECT handling could depend',
    'on what the store holds — read-only work (analysis, diagnosis, planning,',
    'review)',
    'counts, and changing a file is not required. HAVING THE MATERIAL IN HAND does',
    'not make work a non-task: a diff pasted for review is still a task. NEVER INFER',
    'THIS FROM LENGTH: a one-word reply that picks an option or carries on work',
    'underway inherits that task. Still unclear? Treat it as a task.',
    '',
    'At the start of a task, read the index and open only the notes whose hooks look',
    'relevant. Treat what you recall as background that may be stale: re-verify any',
    'file, flag, or version against the repo before acting on it.',
    '',
    '## Write',
    '',
    'Before writing, confirm the fact is not already in the repo, git history, or the',
    'instruction files, and that it is not a secret value. Search the index and update',
    'an existing note rather than adding a near-duplicate. A new note is one atomic',
    'fact with frontmatter:',
    '',
    '```markdown',
    '---',
    'name: <kebab-case-slug>',
    'description: <one sharp line — this is what future-you reads to decide to open it>',
    'type: user | feedback | project | reference',
    'scope: global | repo        # optional: does this still hold in another repo?',
    'created: YYYY-MM-DD',
    'updated: YYYY-MM-DD',
    '---',
    '```',
    '',
    '`feedback` and `project` notes MUST carry a `**Why:**` line and a',
    '`**How to apply:**` line. Add exactly one pointer line to the index, and delete',
    'memories that turn out to be wrong.',
    '',
    'Store settled facts, never current state: "2.0 shipped on 2026-01-15" is durable;',
    '"the current version is X", the tip commit, or a passing test count will rot —',
    'record where to read those instead.',
    '',
    'An unfinished task may keep AT MOST ONE live `project` note holding its goal,',
    'status, decisions, constraints, blockers, and next step together — the single',
    'exception to one-file-one-fact, and a ceiling rather than a quota: a task that',
    'needs no resumable state keeps no note. Update it IN PLACE. Never a dated',
    'series (`state-2026-01-15.md`, `state-2026-01-16.md`, …), never a second',
    'handoff log indexed beside it, and retire its transient state once it ends.',
    '',
    '## When a task finishes',
    '',
    'Run one curation checkpoint. It is a judgement, not a write: promote what is',
    'durable, retire the transient state the CURRENT task left on its own live',
    '`project` note if it has one, and when nothing is worth keeping, write',
    'nothing and say so. Never append a per-turn log TO THE STORE, and never touch',
    'a file just to mark it fresh — a timestamp is not a memory.',
    '',
    '## Sync',
    '',
    'Before a deliberate compact, clear, or new thread: scan the task, dedup and update,',
    'refresh project state, promote only reusable feedback, retire completed transient',
    'state, then report what was added, updated, archived, and skipped.',
    '',
    '## The cap is enforced here',
    '',
    'This host denies a write that would GROW the index past 200 lines / 25 KB. That is',
    'a real refusal, not a warning — but a write that shrinks the index always passes,',
    'so compact first, step by step if needed: the index is loaded every session, and',
    'anything past the cap silently stops being recalled.',
    '',
    'Never write credentials, keys, tokens, or cookies into memory — record only where',
    'the secret lives.',
  ].join('\n')
}
