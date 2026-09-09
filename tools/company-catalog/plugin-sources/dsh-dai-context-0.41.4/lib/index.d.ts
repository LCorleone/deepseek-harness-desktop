import { z } from "zod";
import "@deepseek-ai/dsh-session";
import { Context } from "@deepseek-ai/cordis";
//#region src/host/config.d.ts
interface Config {
  /** Cap on kept per-step request records (the hard step backstop). */
  maxRequestSteps?: number;
  /** Newest whole-turn window kept; trimming crosses whole turns, never mid-turn. */
  maxKeptTurns?: number;
  maxEvents?: number;
  /**
   * Served surface nodes (newest carry the signal; live inject nodes are pinned — they land first and are few). Deliberately generous:
   * auto-compaction keeps healthy surfaces far below it, so the browser effectively lists every live node; the bound is a
   * pathological-session backstop (each push ships the whole value, ~150B/node).
   */
  maxNodes?: number;
  /** Removed (shadowed) surface nodes kept for per-step reconstruction. */
  maxArchiveNodes?: number;
}
/**
 * The cordis `Config` validator: strict on keys, defaults on the schema fields; tolerates `undefined` (a patch row without a `config:`
 * block — defaults win).
 */
declare const Config: z.ZodPreprocess<z.ZodObject<{
  maxRequestSteps: z.ZodDefault<z.ZodNumber>;
  maxKeptTurns: z.ZodDefault<z.ZodNumber>;
  maxEvents: z.ZodDefault<z.ZodNumber>;
  maxNodes: z.ZodDefault<z.ZodNumber>;
  maxArchiveNodes: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>>;
//#endregion
//#region src/host/headers.d.ts
/**
 * One stored tool: the v1 row shape carried the producer description and the
 * raw schema; folds since the #37 slim-down append metadata-only entries.
 */
interface StoredHeaderTool {
  name: string;
  tokens: number;
  description?: string;
  plugin?: string;
  schema?: unknown;
}
/** One stored epoch: v1 rows carried `system`; folds since carry `systemTokens`. */
interface StoredHeaderRecord {
  seq: number;
  time: number;
  system?: string;
  systemTokens?: number;
  tools: StoredHeaderTool[];
}
interface HeadersState {
  headers: StoredHeaderRecord[];
}
//#endregion
//#region src/host/fold.d.ts
/**
 * History retention bounds (configurable since 0.11 — see config.ts; these
 * are the defaults' values). The fold keeps per-STEP request records; once the
 * newest run count exceeds `maxKeptTurns`, the timeline is trimmed to the
 * most recent whole TURN runs (never cutting a turn in half), so turn
 * granularity can always show the full recent turn range instead of a
 * step-count fragment. The turn-run trim runs whenever the cap is crossed
 * (not only when the raw step bound is), so the bounded state stays at the
 * newest ~`maxKeptTurns` turns deterministically as a live log grows.
 */
interface TimelineState {
  /** Model-visible surface, newest last. */
  surface: SurfaceNode[];
  sums: Record<Category, number>;
  systemTokens: number;
  toolsTokens: number;
  /**
   * The projection-cache precondition is plain JSON: a property whose value
   * is `undefined` makes the whole checkpoint unserializable
   * (`snapshotJsonValue` rejects it), which fails EVERY cache write for the
   * session — including the `title` projection row that powers the session
   * list after a restart. Optional fields therefore use absent properties
   * (`model`/`provider`/`lastModel`/`contextWindow` are simply not set until
   * a value is known) instead of `undefined`-valued ones. Reads via
   * `state.model` are identical for both shapes (`undefined` on miss).
   */
  model?: string;
  provider?: string;
  lastModel?: string;
  contextWindow?: number;
  requests: RequestRecord[];
  events: ContextEventRecord[];
  /**
   * Recently removed surface nodes (stamped COPIES carrying `gone`), in
   * removal order. Feeds the Context browser's per-step reconstruction.
   * Bounded two ways in trimState: capped to `maxArchiveNodes`, and pruned
   * to removals after the oldest retained request (older removals can only
   * serve steps the requests trim already forgot).
   */
  archived: SurfaceNode[];
  /**
   * Session-cost raw material: cumulative billed-token totals per DeepSeek
   * V4 model family and pricing period (see SessionCostUsage). Running
   * totals — never trimmed, so the estimate always covers the COMPLETE
   * session log even after the request/event retention bounds cut in.
   * Absent until a v4-flash / v4-pro request reports usage.
   */
  cost?: SessionCostUsage;
  archiveFloor?: number;
  /**
   * Whole-session timing totals (see TimingTotals) — running sums over the
   * COMPLETE session log, like `cost`. Absent until the first step or tool
   * lifecycle folds in; created once and cloned-on-touch afterwards (the
   * object is shared with the persisted previous state — see `ensure`).
   */
  timing?: TimingTotals;
  /**
   * The open step's start instant, armed by `step/start` and consumed by the
   * `assistant/message` (TTFT/generation split) and `step/end` (wall time)
   * that follow it; `assistant/chunk` stamps `firstToken` on the step's first
   * token delta — absent when the stream carried none (legacy or aborted
   * steps), which leaves that call's model time unattributed. One slot, not a
   * map: steps are sequential in the log, so the newest `step/start` is the
   * one those events close — a hostile interleaved log degrades to skipped
   * durations, never to unbounded state. Same arm/remove lifecycle as
   * `pendingShadowedSeqs`.
   */
  stepStart?: {
    time: number;
    firstToken?: number;
  };
  /**
   * Tool callId → the call's name and start instant, armed by `tool/call` and
   * DELETED when its `tool/result` folds in (one result per call, in log
   * order) — the map stays at pending-call size instead of growing for the
   * session's whole lifetime (it is persisted state, shallow-copied by every
   * fold step). The start instant prices the call's duration into
   * `timing.toolsMs` when the result arrives.
   */
  callNames: Record<string, {
    name: string;
    start: number;
  }>;
  /**
   * Seq list of the surface nodes the next replacement will shadow, armed by
   * the metering event (`compaction/summary` | `compaction/prune`) and
   * consumed by the replacement that must follow it synchronously. The
   * producer's shadow price covers exactly these seqs — which can differ
   * from the replacement's declared range (pruned replacement nodes keep
   * their own seqs, beyond the range end) — so removal must follow the seqs.
   * Absent until armed, and REMOVED (not set to `undefined`) when consumed,
   * to keep the state plain JSON for the projection cache.
   */
  pendingShadowedSeqs?: number[];
  /**
   * The seq of the compaction/prune event that armed `pendingShadowedSeqs` —
   * the shadowed path rewrites that event's `tokens` from the gross shadow
   * price to the NET freed amount (removed nodes minus the synchronous
   * replacement), so the row matches the drop the trend chart shows. Same
   * arm/remove lifecycle as `pendingShadowedSeqs`.
   */
  pendingShadowEventSeq?: number;
}
//#endregion
//#region src/shared/types.d.ts
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The plugin's whole-value context timeline: current composition,
     * per-request history, context events, and the model-visible surface.
     * The Host folds it from the session log; clients receive the finished
     * value (key absence = the plugin's host half is not composed).
     */
    contextTimeline: ContextTimeline;
    /**
     * The request-header CONTENT epochs (full system prompt + tool schemas)
     * behind the timeline's envelope figures. A separate unit so the hot
     * `contextTimeline` value stays lean: headers change rarely, so this
     * value (and its pushes) change only when a `request/header` lands.
     * The Context browser card reads it to show the actual prompt/schema
     * content of a picked step (key absence = older host: tokens only).
     */
    contextHeaders: ContextHeaders;
  }
  interface SessionProjectionStateMap {
    contextTimeline: TimelineState;
    contextHeaders: HeadersState;
  }
}
type Category = 'user' | 'inject' | 'assistant' | 'tool';
interface Snapshot {
  ok: boolean;
  model?: string;
  provider?: string;
  contextWindow?: number;
  current: {
    system: number;
    tools: number;
    user: number;
    inject: number;
    assistant: number;
    tool: number;
    total: number;
  };
  /**
   * Provider-anchored occupancy of the NEXT request. LEGACY since 0.11: the
   * Host no longer folds this — the Client reads the official token-meter
   * `contextPressure` projection key (`useProjection('contextPressure')`)
   * instead. Kept optional for wire compatibility with older clients.
   */
  occupancy?: {
    pressureTokens?: number;
    surfaceTokens: number;
    sampledSurfaceTokens?: number;
    projectedTokens?: number;
    contextWindow?: number;
  };
  /**
   * Image blocks live in the CURRENT context (user uploads plus tool-result
   * images, nested blocks included) — the sum over the live surface nodes'
   * `imgs`, so compaction/prune shrink it. Absent from older hosts; clients
   * treat absence as zero.
   */
  images?: number;
  /**
   * Tool calls whose result is live in the CURRENT context (one `tool/result`
   * folds to one `tool` surface node). Calls still in flight and results
   * compacted/pruned out of the surface are not counted. Absent from older
   * hosts; clients treat absence as zero.
   */
  toolCalls?: number;
  requests: RequestRecord[];
  events: ContextEventRecord[];
  /**
   * Cumulative session-cost raw material (per-family, per-period billed
   * token totals — see SessionCostUsage). Absent until a DeepSeek V4
   * request reports usage.
   */
  cost?: SessionCostUsage;
  /**
   * Whole-session timing totals (see TimingTotals). Absent until the first
   * step lifecycle completes in the log (older plugin builds never folded
   * one — clients treat absence as an empty timing card).
   */
  timing?: TimingTotals;
  /**
   * The served live surface: the newest `maxNodes` tail PLUS every live inject node older than the tail (injections land first and are
   * few,
   * so they are pinned). Seq-ordered, oldest first.
   */
  nodes: SurfaceNode[];
  /** Live nodes not served (the overflow beyond `maxNodes`, minus pinned injects — see `nodes`). */
  droppedNodes: number;
  /**
   * Recently REMOVED surface nodes (compaction/prune shadows), each stamped
   * with `gone` (the replacing event's seq). Together with `nodes` this lets
   * the Context browser reconstruct the assembled surface of any retained
   * step: alive at request R = seq < R.seq && (gone undefined || gone > R.seq).
   */
  archive: SurfaceNode[];
  /**
   * Coverage floor of the served live `nodes`: the newest seq among the
   * `droppedNodes` live nodes not served. Present only when droppedNodes > 0.
   */
  surfaceFloor?: number;
  /**
   * Coverage floor of `archive`: the newest `gone` among archive entries the
   * retention bounds dropped. Steps with seq < archiveFloor may miss removed
   * nodes (the browser shows the reconstruction as approximate).
   */
  archiveFloor?: number;
}
/**
 * The `contextTimeline` projection's whole value — the same snapshot the Client has always rendered. `ok` is always `true` here (a
 * delivered projection is by definition available); kept for wire compatibility with the snapshot shape.
 */
type ContextTimeline = Snapshot;
/**
 * Cumulative billed-token totals for one pricing bucket of the session-cost
 * estimate (host-folded, never trimmed — running totals over the COMPLETE
 * session log, immune to the request/event retention bounds).
 */
interface CostBucketTotals {
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
/**
 * One completed tool name's whole-session call tally behind the timing
 * card's top-tools ranking (running totals, never trimmed).
 */
interface ToolTimingTotals {
  calls: number;
  ms: number;
}
/**
 * Whole-session timing totals, host-folded from the durable `step/start` /
 `step/end` / `assistant/chunk` / `tool/call` / `tool/result` lifecycle
 * (running totals over the COMPLETE session log — the same never-trimmed
 * framing as `cost`). Durations are wall-clock milliseconds: `wallMs` sums
 * whole steps, `ttftMs` the step-start → first-token slice (the model wait)
 * and `genMs` the first-token → assistant-message slice (the generation) —
 * both only over calls whose stream carried a token delta, `toolsMs` the sum
 * of per-call tool durations (parallel calls each count, so it can overlap).
 * Absent until the first step lifecycle completes in the log.
 */
interface TimingTotals {
  /** Summed wall time of completed steps (the session's active time). */
  wallMs: number;
  /** Summed step-start → first-token time (the model wait, TTFT). */
  ttftMs: number;
  /** Summed first-token → assistant-message time (the generation). */
  genMs: number;
  /** Completed model calls (assistant messages folded). */
  calls: number;
  /** Summed per-call durations of completed tool calls. */
  toolsMs: number;
  /** Completed tool calls (call/result pairs folded). */
  toolCalls: number;
  /** Per-tool-name tallies behind the timing card's ranking (bounded). */
  tools: Record<string, ToolTimingTotals>;
}
/** One model family's totals split by DeepSeek's pricing period (Beijing Time). */
interface CostFamilyUsage {
  peak?: CostBucketTotals;
  off?: CostBucketTotals;
}
/**
 * The session-cost estimate's raw material: cumulative provider-reported
 * token totals per DeepSeek V4 model family (matched on the model NAME,
 * provider-agnostic) and pricing period. The Client prices these with its
 * hardcoded list-price table in the locale's currency. Absent until a
 * deepseek-v4-flash / deepseek-v4-pro request reports usage.
 */
interface SessionCostUsage {
  flash?: CostFamilyUsage;
  pro?: CostFamilyUsage;
}
/** One model-visible message on the surface, with its heuristic token price. */
interface SurfaceNode {
  seq: number;
  time?: number;
  cat: Category;
  tokens: number;
  /** Image blocks inside this node's message (absent when zero). */
  imgs?: number;
  /**
   * Removal marker, present only on `archive` entries: the seq of the
   * replacement surface event that shadowed this node (compaction/prune).
   * The node is part of the assembled context of every request with
   * seq > this node.seq and seq < gone.
   */
  gone?: number;
  form?: string;
  text?: string;
  tool?: string;
  err?: boolean;
  skill?: string;
  calls?: string[];
}
/** One answered model call (a step); consecutive records of one turn form it. */
interface RequestRecord {
  turn?: number;
  step?: number;
  time: number;
  seq: number;
  system: number;
  tools: number;
  user: number;
  inject: number;
  assistant: number;
  tool: number;
  total: number;
  prompt?: number;
  /**
   * Billed cache-read (served) prompt tokens of this request — the
   * hit-rate numerator against `prompt` (input + cacheRead + cacheWrite).
   * Absent on older hosts / usage-less requests; zero is a real value.
   */
  cacheRead?: number;
  output?: number;
  /**
   * Turn-mode aggregate marker, set by the Client's aggregateByTurn (one bar
   * per turn shows its LAST step's record). The Host never sets it.
   */
  stepCount?: number;
  /**
   * Delta-mode signed net change, set by the Client's deltaOf (only present
   * on the delta-transformed records the TrendChart plots). The Host never
   * sets it.
   */
  net?: number;
}
/** A notable context event (compaction, prune, injection, model switch). */
interface ContextEventRecord {
  seq: number;
  time: number;
  kind: 'compaction' | 'prune' | 'inject' | 'model' | 'mode';
  form?: string;
  tokens?: number;
  count?: number;
  sub?: string;
  name?: string;
  /** One-line producer account (notice-form summary), shown after the name. */
  detail?: string;
  from?: string;
  to?: string;
  /** Turn/step of the request logged right BEFORE the event (host-stamped). */
  fromTurn?: number;
  fromStep?: number;
  /** Turn/step of the request this event contributed to (host-stamped). */
  turn?: number;
  step?: number;
}
/** One tool of a request-header epoch, with its display price. */
interface HeaderTool {
  name: string;
  tokens: number;
  /**
   * The registering plugin's label, when attribution is known: either a
   * `plugin` field carried by the raw header entry (harness-provided) or the
   * host's best-effort attribution (`mcp:<server>` for MCP tools, or the
   * pinned first-party package map). `UNKNOWN_TOOL_SOURCE` marks a tool whose
   * provider predates the attribution hook; absent means nothing is known and
   * the browser shows no tag.
   */
  plugin?: string;
}
/**
 * One request-header epoch's METADATA: the epoch boundaries and token prices
 * in force from this event's seq until the next epoch. The epoch CONTENT
 * (full system prompt text, tool descriptions/schemas) is not projected —
 * every session.list row, control baseline, push frame, and projection-cache
 * checkpoint would otherwise carry it per session × epoch. The client
 * fetches one epoch's content on demand (a seq-anchored history read off
 * `seq`) as a {@link HeaderEpochContent}.
 */
interface HeaderRecord {
  seq: number;
  time: number;
  /** The epoch's estimated system-prompt tokens; absent when it logged no system prompt. */
  systemTokens?: number;
  tools: HeaderTool[];
}
/** The `contextHeaders` projection value: the bounded epoch list (newest last). */
interface ContextHeaders {
  headers: HeaderRecord[];
}
//#endregion
//#region src/host/index.d.ts
declare const name = "dsh-context";
declare const inject: string[];
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { type Category, Config, type ContextEventRecord, type ContextHeaders, type ContextTimeline, type HeaderRecord, type HeaderTool, type HeadersState, type RequestRecord, type Snapshot, type SurfaceNode, type TimelineState, apply, inject, name };