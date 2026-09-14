/**
 * Shared, demand-driven state for the Mobius browser monitor.
 *
 * Mobius has no archive: workflows stay live for their captain session until
 * the harness forgets them, so this monitor keeps a single live snapshot and
 * the same reference-counted target/refcount/discovery machinery as the
 * AgentTeams monitor, minus the archived-team fallback pass.
 * @module dsh-agent-teams/client/mobius-monitor
 */
/** One step row of a host mobius snapshot. */
export interface MobiusStepView {
    readonly id: string;
    readonly title: string;
    readonly target: string;
    readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'halted';
    readonly stage?: string;
    readonly context?: string;
    readonly output?: string;
    readonly assignee_id?: string;
}
/** One mobius workflow snapshot (mirrors the host MobiusWorkflowView). */
export interface MobiusWorkflowView {
    readonly id: string;
    readonly name: string;
    readonly goal: string;
    readonly phase: 'staged' | 'running' | 'done';
    /** Workflow-wide step timeout in ms (undefined = plugin default). */
    readonly timeoutMs?: number;
    /** "Eureka" mode: running step agents may self-adjust pending future steps. */
    readonly eureka?: boolean;
    /** Step agents are denied web-search/web-fetch tools. */
    readonly disableWebSearch?: boolean;
    /** Hard cap on the total number of execution stages (default 0 = unlimited). */
    readonly maxStageCount?: number;
    /** Display-only summary name per stage id. */
    readonly stageTitles?: Record<string, string>;
    readonly captainSessionId: string;
    readonly steps: readonly MobiusStepView[];
    readonly conclusion?: string;
    readonly review?: {
        readonly status: 'awaiting_review' | 'passed' | 'needs_revision';
        readonly findings: string;
        readonly round: number;
    };
}
/** A successfully-created workflow that currently needs updates. */
export interface MobiusMonitorTarget {
    readonly key: string;
    readonly sessionId: string;
    readonly workflowId: string;
}
/** Latest shared response data for the floater. */
export interface MobiusSnapshots {
    readonly workflows: readonly MobiusWorkflowView[];
}
/** Subscribe to the active monitor-target list (React external-store shape). */
export declare function subscribeMobiusMonitorTargets(listener: () => void): () => void;
/** Read the stable active-target snapshot. */
export declare function getMobiusMonitorTargetsSnapshot(): readonly MobiusMonitorTarget[];
/**
 * Register one successful mobius workflow as a monitoring demand.
 *
 * The returned cleanup is reference-counted so multiple cards and React
 * StrictMode remounts cannot stop another card's monitor.
 */
export declare function monitorMobiusWorkflow(sessionId: string, workflowId: string): () => void;
/** Stop polling targets that no longer exist in the shared snapshot. */
export declare function settleMobiusMonitorTargets(keys: ReadonlySet<string>): void;
/** Subscribe to the shared live snapshot. */
export declare function subscribeMobiusSnapshots(listener: () => void): () => void;
/** Read the stable shared live snapshot. */
export declare function getMobiusSnapshotsSnapshot(): MobiusSnapshots;
/** Publish a successful state-route response. */
export declare function updateMobiusSnapshots(workflows: readonly MobiusWorkflowView[]): void;
/** Poll cadence for the live host snapshot route. */
export declare const MOBIUS_POLL_MS = 1000;
/**
 * Low-frequency probe cadence while a cardless discovery session still owns
 * no workflow. The probe keeps the panel able to pick up a workflow created
 * later in that session without turning every ordinary session into a
 * one-second filesystem scan.
 */
export declare const MOBIUS_PROBE_MS = 5000;
/** Host route serving live mobius workflow snapshots. */
export declare const MOBIUS_STATE_URL = "/plugins/dsh-mobius/mobius";
interface MobiusFetchResponse {
    readonly ok: boolean;
    json(): Promise<unknown>;
}
/** Injectable browser primitives used by the poll controller and its tests. */
export interface MobiusPollingRuntime {
    /**
     * Current captain session to discover after a cold client/host restart.
     * This one-time scope restores workflows whose older conversation log has no
     * mobius card capable of registering an explicit monitor target.
     */
    readonly discoverySessionId?: string;
    readonly fetchState?: (url: string, init: {
        readonly cache: 'no-store';
        readonly signal: AbortSignal;
    }) => Promise<MobiusFetchResponse>;
    readonly schedule?: (callback: () => void, intervalMs: number) => unknown;
    readonly cancel?: (timer: unknown) => void;
    readonly publishSnapshots?: (workflows: readonly MobiusWorkflowView[]) => void;
    readonly settleTargets?: (keys: ReadonlySet<string>) => void;
}
/** Handle returned by one current-session polling loop. */
export interface MobiusPollingController {
    /** The immediate first pass, exposed so offline verification can await it. */
    readonly firstTick: Promise<void>;
    /** Idempotently stop the timer and abort the current request. */
    stop(): void;
}
/**
 * Start the single polling loop for the current session's requested targets.
 *
 * With neither targets nor a discovery session this is deliberately inert.
 * Explicit workflow targets poll at the live cadence from the start. A
 * discovery session performs an immediate restore pass, then — while it still
 * owns no workflow — probes on a low-frequency cadence, so a workflow created
 * later in that session is discovered without a manual reload, without turning
 * every ordinary session into a one-second filesystem scan. The moment a
 * workflow for the discovery session appears, the controller upgrades to the
 * live one-second cadence for the rest of its lifetime. The caller — the
 * session view, which stops the controller when the session is no longer
 * current — bounds the lifetime.
 */
export declare function startMobiusPolling(monitorTargets: readonly MobiusMonitorTarget[], runtime?: MobiusPollingRuntime): MobiusPollingController;
export {};
