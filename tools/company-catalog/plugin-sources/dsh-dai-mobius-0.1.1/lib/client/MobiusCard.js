import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Mobius conversation card: the lightweight in-conversation summary for one
 * sequential research workflow — the workflow name, its goal, a step count,
 * and an "open activity panel" button that re-activates the top-right floater
 * (useful after it was closed, or when re-opening an old session for review).
 *
 * The card anchors to the durable `mobius_create` tool/call + tool/result fold
 * (see mobius-card-definition.ts). It holds no interrupt control here — the
 * activity panel owns the interrupt and staged-plan actions.
 * @module dsh-dai-mobius/client/card
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { getMobiusSnapshotsSnapshot, monitorMobiusWorkflow, subscribeMobiusSnapshots, } from "./mobius-monitor.js";
import css from './MobiusCard.module.css';
/** Window event the floater listens for to open itself with this workflow. */
export const OPEN_MOBIUS_PANEL_EVENT = 'dsh-mobius:open-panel';
function useMobiusSnapshots() {
    return useSyncExternalStore(subscribeMobiusSnapshots, getMobiusSnapshotsSnapshot).workflows;
}
/** Re-activate the top-right activity panel, carrying this workflow's summary. */
function openActivityPanel(data) {
    window.dispatchEvent(new CustomEvent(OPEN_MOBIUS_PANEL_EVENT, {
        detail: {
            workflowId: data.workflowId,
            captainSessionId: data.captainSessionId,
            name: data.name,
        },
    }));
}
export function MobiusCard({ node }) {
    const data = node.data;
    const owner = data.captainSessionId;
    const workflows = useMobiusSnapshots();
    useEffect(() => {
        if (owner === '')
            return;
        return monitorMobiusWorkflow(owner, data.workflowId);
    }, [data.workflowId, owner]);
    const snapshot = workflows.find((workflow) => workflow.id === data.workflowId && (owner === '' || workflow.captainSessionId === owner));
    const resolved = useMemo(() => ({
        ...data,
        captainSessionId: snapshot?.captainSessionId ?? owner,
        steps: snapshot?.steps.length ?? data.steps,
    }), [data, owner, snapshot]);
    return (_jsxs("section", { className: css.root, "data-mobius-card": true, "data-workflow-id": resolved.workflowId, children: [_jsxs("header", { className: css.head, children: [_jsx("span", { className: css.name, title: resolved.name, children: resolved.name }), _jsxs("span", { className: css.count, children: [resolved.steps, " \u4E2A\u6B65\u9AA4"] }), _jsxs("button", { type: "button", className: css.panelButton, onClick: () => { openActivityPanel(resolved); }, "aria-label": "\u6253\u5F00 Activity Panel", title: "\u6253\u5F00 Activity Panel", children: [_jsx(IconPanelLeftOutline16, {}), _jsx("span", { children: "\u6253\u5F00 Activity Panel" })] })] }), resolved.goal !== '' && _jsx("div", { className: css.goal, children: resolved.goal })] }));
}
