/**
 * Browser-side API + shared polled state for the DAI notebook capsule.
 *
 * The capsule is a global floating entry. It reads the workspace-scoped
 * notebook snapshots from the host and issues mutations through the same host,
 * so anything typed here is immediately visible to (and editable by) the
 * notebook_* tools in the chat.
 */
export const STATE_URL = '/plugins/dsh-dai-notebook/state';
export const MUTATE_URL = '/plugins/dsh-dai-notebook/mutate';
const listeners = new Set();
let shared = { notebooks: [] };
export function subscribeNotebookSnapshot(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function getNotebookSnapshot() {
    return shared;
}
function publish(next) {
    shared = next;
    for (const listener of listeners)
        listener();
}
/** In-flight guard so overlapping polls never reorder the snapshot. */
let polling = false;
async function fetchJson(url, init) {
    return fetch(url, init);
}
export async function refreshNotebookState() {
    if (polling)
        return;
    polling = true;
    try {
        const response = await fetchJson(STATE_URL, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (!response.ok)
            return;
        const body = (await response.json());
        if (!isStateResponse(body))
            return;
        publish({ notebooks: body.notebooks });
    }
    catch {
        // Host restarting or offline — keep the last snapshot.
    }
    finally {
        polling = false;
    }
}
/** Start a lightweight polling loop; returns a stop function. */
export function startNotebookPolling(intervalMs = 2000) {
    let cancelled = false;
    let timer;
    const tick = () => { void refreshNotebookState(); };
    void refreshNotebookState();
    timer = setInterval(tick, intervalMs);
    return () => {
        cancelled = true;
        if (timer !== undefined)
            clearInterval(timer);
    };
}
/** Pick the workspace notebook for a given cwd (path), else the first. */
export function selectWorkspace(notebooks, cwd) {
    if (notebooks.length === 0)
        return undefined;
    if (cwd !== undefined) {
        const found = notebooks.find((n) => n.workspace === cwd);
        if (found !== undefined)
            return found;
    }
    return notebooks[0];
}
/** Issue one mutation and refresh the shared snapshot from the result. */
export async function mutateNotebook(sessionId, op, payload = {}) {
    const response = await fetch(MUTATE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, op, ...payload }),
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
        let message = `mutation failed (${response.status})`;
        try {
            const body = (await response.json());
            if (typeof body.error === 'string')
                message = body.error;
        }
        catch {
            // keep default
        }
        throw new Error(message);
    }
    const snapshot = (await response.json());
    await refreshNotebookState();
    return snapshot;
}
function isStateResponse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    if (!Array.isArray(record.notebooks))
        return false;
    return record.notebooks.every((n) => n !== null && typeof n === 'object'
        && typeof n.workspace === 'string'
        && typeof n.snapshot === 'object');
}
