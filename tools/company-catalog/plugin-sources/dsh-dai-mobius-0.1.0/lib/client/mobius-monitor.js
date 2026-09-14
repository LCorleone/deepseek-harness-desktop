/**
 * Shared, demand-driven state for the Mobius browser monitor.
 *
 * Mobius has no archive: workflows stay live for their captain session until
 * the harness forgets them, so this monitor keeps a single live snapshot and
 * the same reference-counted target/refcount/discovery machinery as the
 * AgentTeams monitor, minus the archived-team fallback pass.
 * @module dsh-agent-teams/client/mobius-monitor
 */
const targets = new Map();
const targetListeners = new Set();
const snapshotListeners = new Set();
let targetSnapshot = [];
let mobiusSnapshots = { workflows: [] };
function targetKey(sessionId, workflowId) {
    return `${sessionId}\u0000${workflowId}`;
}
function publishTargets() {
    targetSnapshot = [...targets.values()]
        .filter((target) => target.active)
        .map(({ key, sessionId, workflowId }) => ({ key, sessionId, workflowId }));
    for (const listener of targetListeners)
        listener();
}
/** Subscribe to the active monitor-target list (React external-store shape). */
export function subscribeMobiusMonitorTargets(listener) {
    targetListeners.add(listener);
    return () => { targetListeners.delete(listener); };
}
/** Read the stable active-target snapshot. */
export function getMobiusMonitorTargetsSnapshot() {
    return targetSnapshot;
}
/**
 * Register one successful mobius workflow as a monitoring demand.
 *
 * The returned cleanup is reference-counted so multiple cards and React
 * StrictMode remounts cannot stop another card's monitor.
 */
export function monitorMobiusWorkflow(sessionId, workflowId) {
    const owner = sessionId.trim();
    const id = workflowId.trim();
    if (owner === '' || id === '')
        return () => { };
    const key = targetKey(owner, id);
    const existing = targets.get(key);
    if (existing === undefined) {
        targets.set(key, { key, sessionId: owner, workflowId: id, refs: 1, active: true });
        publishTargets();
    }
    else {
        existing.refs += 1;
        if (!existing.active) {
            existing.active = true;
            publishTargets();
        }
    }
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        const current = targets.get(key);
        if (current === undefined)
            return;
        current.refs -= 1;
        if (current.refs <= 0) {
            targets.delete(key);
            if (current.active)
                publishTargets();
        }
    };
}
/** Stop polling targets that no longer exist in the shared snapshot. */
export function settleMobiusMonitorTargets(keys) {
    let changed = false;
    for (const key of keys) {
        const target = targets.get(key);
        if (target?.active !== true)
            continue;
        target.active = false;
        changed = true;
    }
    if (changed)
        publishTargets();
}
/** Subscribe to the shared live snapshot. */
export function subscribeMobiusSnapshots(listener) {
    snapshotListeners.add(listener);
    return () => { snapshotListeners.delete(listener); };
}
/** Read the stable shared live snapshot. */
export function getMobiusSnapshotsSnapshot() {
    return mobiusSnapshots;
}
/** Publish a successful state-route response. */
export function updateMobiusSnapshots(workflows) {
    if (workflows === mobiusSnapshots.workflows)
        return;
    mobiusSnapshots = { workflows };
    for (const listener of snapshotListeners)
        listener();
}
/** Poll cadence for the live host snapshot route. */
export const MOBIUS_POLL_MS = 1000;
/**
 * Low-frequency probe cadence while a cardless discovery session still owns
 * no workflow. The probe keeps the panel able to pick up a workflow created
 * later in that session without turning every ordinary session into a
 * one-second filesystem scan.
 */
export const MOBIUS_PROBE_MS = 5000;
/** Host route serving live mobius workflow snapshots. */
export const MOBIUS_STATE_URL = '/plugins/dsh-mobius/mobius';
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
export function startMobiusPolling(monitorTargets, runtime = {}) {
    const discoverySessionId = runtime.discoverySessionId?.trim();
    if (monitorTargets.length === 0 && (discoverySessionId === undefined || discoverySessionId === '')) {
        return { firstTick: Promise.resolve(), stop: () => { } };
    }
    const fetchState = runtime.fetchState ?? ((url, init) => fetch(url, init));
    const schedule = runtime.schedule ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    const cancel = runtime.cancel ?? ((timer) => { clearInterval(timer); });
    const publishSnapshots = runtime.publishSnapshots ?? updateMobiusSnapshots;
    const settleTargets = runtime.settleTargets ?? settleMobiusMonitorTargets;
    let cancelled = false;
    let inFlight = false;
    // Explicit workflow targets are demanded work: start at the live cadence. A
    // discovery session starts probing low-frequency and upgrades on detection.
    let hot = monitorTargets.length > 0;
    let discoveredLiveKeys = new Set();
    let controller;
    let timer;
    const intervalMs = () => (hot ? MOBIUS_POLL_MS : MOBIUS_PROBE_MS);
    const reschedule = () => {
        cancel(timer);
        timer = schedule(() => { void tick(); }, intervalMs());
    };
    const tick = async () => {
        if (inFlight || cancelled)
            return;
        inFlight = true;
        controller = new AbortController();
        try {
            const liveResponse = await fetchState(MOBIUS_STATE_URL, {
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!liveResponse.ok)
                return;
            const body = (await liveResponse.json());
            if (cancelled || !Array.isArray(body.workflows))
                return;
            const workflows = body.workflows;
            publishSnapshots(workflows);
            discoveredLiveKeys = new Set(discoverySessionId === undefined || discoverySessionId === ''
                ? []
                : workflows
                    .filter((workflow) => workflow.captainSessionId === discoverySessionId)
                    .map((workflow) => workflow.id));
            // A discovery session found its first workflow: upgrade from the
            // low-frequency probe to the live cadence for the rest of the lifetime.
            if (!hot && discoveredLiveKeys.size > 0) {
                hot = true;
                reschedule();
            }
            const missing = monitorTargets.filter((target) => !workflows.some((workflow) => workflow.captainSessionId === target.sessionId && workflow.id === target.workflowId));
            if (missing.length === 0)
                return;
            settleTargets(new Set(missing.map((target) => target.key)));
        }
        catch (error) {
            if (error?.name === 'AbortError')
                return;
            // Host restarting; keep the last snapshot and retry on the next tick.
        }
        finally {
            inFlight = false;
        }
    };
    const firstTick = tick();
    if (timer === undefined)
        timer = schedule(() => { void tick(); }, intervalMs());
    return {
        firstTick,
        stop: () => {
            if (cancelled)
                return;
            cancelled = true;
            controller?.abort();
            cancel(timer);
        },
    };
}
