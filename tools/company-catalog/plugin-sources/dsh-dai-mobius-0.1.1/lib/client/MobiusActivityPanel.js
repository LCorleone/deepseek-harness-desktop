import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Mobius activity panel: the top-right floater monitoring every research
 * workflow for the current session.
 *
 * This is the Mobius sibling of the AgentTeams ActivityPanel: the same
 * shell-overlay floater that docks at the conversation's top-right edge by
 * default, can be dragged into a floating window, resized, and folded into an
 * activity badge. On wide viewports the docked panel makes the conversation
 * column yield space; narrow viewports keep a simple inset overlay. It polls
 * the host `/plugins/dsh-mobius/mobius` route for server-side workflow
 * snapshots, with a collapsed badge that auto-expands once when activity
 * appears. Every workflow card shows its ordered steps, per-step status and
 * output, and the final conclusion.
 *
 * The floater mounts in ui-layout's additive `shell.overlay`; it is not a
 * conversation node. All shell geometry, resize/dock gestures and cross-session
 * collapse logic mirror the AgentTeams panel, but the content is workflow
 * cards instead of a team graph.
 * @module dsh-agent-teams/client/mobius-activity
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, } from 'react';
import { IconCheckOutline14, IconChevronDownOutline14, IconDownloadOutline16, IconPanelLeftOutline16, IconSkillOutline16, IconStopFill16, } from '@deepseek-ai/dsh-client-ui-primitives';
import { mobiusPanelExpandedForSession, mobiusPanelShouldAutoExpand, mobiusPanelPhaseOf, mobiusRunsWater, } from "./mobius-activity-model.js";
import { getMobiusMonitorTargetsSnapshot, getMobiusSnapshotsSnapshot, startMobiusPolling, subscribeMobiusMonitorTargets, subscribeMobiusSnapshots, } from "./mobius-monitor.js";
import { DEFAULT_PANEL_LAYOUT, compactPanelForBounds, dockPanelLayout, floatPanelLayout, movePanelLayout, panelMaximumHeight, panelUsesAutoHeight, parseBadgeOffset, parsePanelLayout, resizePanelLayout, resolvePanelGeometry, } from "./panel-geometry.js";
import { OPEN_MOBIUS_PANEL_EVENT } from "./MobiusCard.js";
import css from './MobiusActivityPanel.module.css';
/** Mobius-specific storage keys (kept separate so the two panels never collide). */
const PANEL_LAYOUT_STORAGE_KEY = 'dsh-mobius:activity-panel:v1';
const PANEL_BADGE_OFFSET_STORAGE_KEY = 'dsh-mobius:activity-badge-offset:v1';
/** Grace before the panel collapses once no workflow remains. */
const AUTOCLOSE_GRACE_MS = 2000;
/**
 * Page-settle window after mount: activity restored on page load only shows
 * the collapsed badge, so the panel never yanks the conversation column
 * right after load. New activity after this window auto-expands as usual.
 * Kept short (1s) so the panel appears promptly after loading.
 */
const AUTO_OPEN_SETTLE_MS = 1000;
/** Root marker shared with the panel CSS while the shell overlay is expanded. */
const PANEL_OPEN_ATTRIBUTE = 'data-mobius-panel-open';
/** Shared width concession consumed by the conversation root CSS. */
const PANEL_SHIFT_PROPERTY = '--mobius-panel-shift';
const PANEL_CONVERSATION_GAP = 14;
const MOVE_THRESHOLD = 4;
function initialPanelLayout() {
    if (typeof window === 'undefined')
        return DEFAULT_PANEL_LAYOUT;
    return parsePanelLayout(window.localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY));
}
function initialPanelBounds() {
    if (typeof window === 'undefined')
        return { width: 1440, height: 900, anchorRight: 1440 };
    return { width: window.innerWidth, height: window.innerHeight, anchorRight: window.innerWidth };
}
/** Phase copy for the collapsed badge and the expanded-panel accent. */
const MOBIUS_PHASE_LABEL = {
    planning: '规划中',
    running: '运行中',
    completed: '已完成',
};
function phaseLabel(phase) {
    return phase === 'idle' ? '' : MOBIUS_PHASE_LABEL[phase];
}
/** Collapsed badge: an always-visible corner pill while any workflow exists. */
function CollapsedBadge({ count, phase, busy, offset, onDrag, onDragEnd, onClick, dragging }) {
    const dragRef = useRef(null);
    const handlePointerDown = (event) => {
        if (event.button !== 0)
            return;
        dragRef.current = {
            pointerId: event.pointerId,
            originX: event.clientX,
            originY: event.clientY,
            startX: offset.x,
            startY: offset.y,
            moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const handlePointerMove = (event) => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId)
            return;
        event.preventDefault();
        const dx = event.clientX - drag.originX;
        const dy = event.clientY - drag.originY;
        if (!drag.moved && Math.hypot(dx, dy) < MOVE_THRESHOLD)
            return;
        drag.moved = true;
        onDrag({ x: drag.startX + dx, y: drag.startY + dy });
    };
    const finishDrag = (event) => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId)
            return;
        dragRef.current = null;
        if (drag.moved) {
            onDragEnd();
        }
        else {
            onClick();
        }
    };
    return (_jsxs("button", { type: "button", className: css.badge, "data-mobius-collapsed": true, "data-phase": phase, "data-busy": busy, "data-dragging": dragging || undefined, style: { transform: `translate(${offset.x}px, ${offset.y}px)` }, onPointerDown: handlePointerDown, onPointerMove: handlePointerMove, onPointerUp: finishDrag, onPointerCancel: finishDrag, "aria-label": `Mobius ${phaseLabel(phase)} ${count} 个工作流`, children: [_jsx("span", { className: css.badgeDot, "data-phase": phase, "data-busy": busy, "aria-hidden": true }), _jsxs("span", { className: css.badgeText, children: ["Mobius ", phaseLabel(phase)] }), _jsx("span", { className: css.badgeCount, children: count })] }));
}
/**
 * Group steps by execution stage, preserving order of first appearance.
 * Steps sharing an explicit stage form one group (run concurrently); steps
 * without a stage each stay as a single-step group (implicit sequential stage).
 */
/** Render a millisecond duration as a short, human-readable label. */
function durationLabel(ms) {
    const minutes = ms / 60_000;
    if (minutes >= 1 && Number.isInteger(minutes))
        return `${minutes} 分钟`;
    if (minutes >= 1)
        return `${minutes.toFixed(1)} 分钟`;
    const seconds = ms / 1000;
    return Number.isInteger(seconds) ? `${seconds} 秒` : `${seconds.toFixed(1)} 秒`;
}
/**
 * Group steps by execution stage, preserving order of first appearance.
 * Steps sharing an explicit stage form one group (run concurrently); steps
 * without a stage each stay as a single-step group (implicit sequential stage).
 */
function groupStepsByStage(steps) {
    const order = [];
    const byKey = new Map();
    for (const step of steps) {
        const key = step.stage !== undefined && step.stage.trim() !== '' ? step.stage.trim() : `@${step.id}`;
        if (!byKey.has(key)) {
            byKey.set(key, []);
            order.push(key);
        }
        byKey.get(key).push(step);
    }
    return order.map((key) => byKey.get(key));
}
/** Group draft step rows by stage (mirrors groupStepsByStage for the edit form). */
function groupDraftSteps(steps) {
    const order = [];
    const byKey = new Map();
    for (const step of steps) {
        const key = step.stage.trim() !== '' ? step.stage.trim() : `@${step.id}`;
        if (!byKey.has(key)) {
            byKey.set(key, []);
            order.push(key);
        }
        byKey.get(key).push(step);
    }
    return order.map((key) => byKey.get(key));
}
/** CRC-32 (IEEE 802.3) over raw bytes, used by the hand-rolled STORE zip. */
let crcTable = null;
function crc32(data) {
    if (crcTable === null) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) !== 0 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            }
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    const table = crcTable;
    for (let i = 0; i < data.length; i++) {
        const idx = ((crc ^ (data[i] ?? 0)) & 0xFF) >>> 0;
        crc = (crc >>> 8) ^ (table[idx] ?? 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
/** Build a STORE-method .zip (no external dependency, no compression) from
 *  UTF-8 text entries. Each entry carries the UTF-8 filename flag so Chinese
 *  paths survive on any unzip implementation. */
function makeZip(files) {
    const encoder = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;
    const flag = 0x0800; // general-purpose bit 11: UTF-8 filenames
    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const data = encoder.encode(file.content);
        const crc = crc32(data);
        const local = new Uint8Array(30 + nameBytes.length + data.length);
        const view = new DataView(local.buffer);
        view.setUint32(0, 0x04034b50, true); // local file header signature
        view.setUint16(4, 20, true); // version needed
        view.setUint16(6, flag, true);
        view.setUint16(8, 0, true); // method = STORE
        view.setUint16(10, 0, true); // mod time
        view.setUint16(12, 0x21, true); // mod date (1980-01-01)
        view.setUint32(14, crc, true);
        view.setUint32(18, data.length, true); // compressed size
        view.setUint32(22, data.length, true); // uncompressed size
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, 0, true); // extra length
        local.set(nameBytes, 30);
        local.set(data, 30 + nameBytes.length);
        locals.push(local);
        const central = new Uint8Array(46 + nameBytes.length);
        const cview = new DataView(central.buffer);
        cview.setUint32(0, 0x02014b50, true); // central directory signature
        cview.setUint16(4, 20, true); // version made by
        cview.setUint16(6, 20, true); // version needed
        cview.setUint16(8, flag, true);
        cview.setUint16(10, 0, true); // method = STORE
        cview.setUint16(12, 0, true); // mod time
        cview.setUint16(14, 0x21, true); // mod date
        cview.setUint32(16, crc, true);
        cview.setUint32(20, data.length, true);
        cview.setUint32(24, data.length, true);
        cview.setUint16(28, nameBytes.length, true);
        cview.setUint16(30, 0, true); // extra length
        cview.setUint16(32, 0, true); // comment length
        cview.setUint16(34, 0, true); // disk number start
        cview.setUint16(36, 0, true); // internal attrs
        cview.setUint32(38, 0, true); // external attrs
        cview.setUint32(42, offset, true); // local header offset
        central.set(nameBytes, 46);
        centrals.push({ bytes: central, localOffset: offset });
        offset += local.length;
    }
    const centralDirSize = centrals.reduce((sum, e) => sum + e.bytes.length, 0);
    const centralOffset = offset;
    const end = new Uint8Array(22);
    const eview = new DataView(end.buffer);
    eview.setUint32(0, 0x06054b50, true); // end of central directory signature
    eview.setUint16(4, 0, true); // disk number
    eview.setUint16(6, 0, true); // disk with central dir
    eview.setUint16(8, files.length, true); // entries on this disk
    eview.setUint16(10, files.length, true); // total entries
    eview.setUint32(12, centralDirSize, true);
    eview.setUint32(16, centralOffset, true);
    eview.setUint16(20, 0, true); // comment length
    const all = new Uint8Array(centralOffset + centralDirSize + end.length);
    let pos = 0;
    for (const p of locals) {
        all.set(p, pos);
        pos += p.length;
    }
    for (const e of centrals) {
        all.set(e.bytes, pos);
        pos += e.bytes.length;
    }
    all.set(end, pos);
    return new Blob([all], { type: 'application/zip' });
}
/** Compose the SKILL.md for a workflow-derived skill: YAML frontmatter with a
 *  slugged `name` and trigger-rich `description`, then the goal, run options,
 *  ordered step plan, and how-to-run. */
function buildSkillMd(wf) {
    const slug = wf.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mobius-workflow';
    const lines = [];
    const goalLine = wf.goal.trim() !== '' ? wf.goal.trim() : wf.name;
    lines.push('---');
    lines.push(`name: ${slug}`);
    lines.push(`description: ${goalLine}。使用顺序研究/分析工作流执行该目标，可导入 mobius 工作流模板运行。`);
    lines.push('---');
    lines.push('');
    lines.push(`# ${wf.name}`);
    lines.push('');
    if (wf.goal.trim() !== '') {
        lines.push('## 目标', '', wf.goal.trim(), '');
    }
    if (wf.eureka === true || wf.disableWebSearch === true || (wf.maxStageCount !== undefined && wf.maxStageCount > 0)) {
        lines.push('## 运行选项', '');
        if (wf.eureka === true)
            lines.push('- 尤里卡模式：运行中的步骤 agent 可主动发现新观点并调整后续步骤。');
        if (wf.disableWebSearch === true)
            lines.push('- 禁用网页搜索：步骤仅凭自身知识与记忆，不使用 web_search / web_fetch。');
        if (wf.maxStageCount !== undefined && wf.maxStageCount > 0)
            lines.push(`- 最大执行阶段数：最多 ${wf.maxStageCount} 个 stage。`);
        lines.push('');
    }
    if (wf.steps.length > 0) {
        lines.push('## 工作流步骤', '');
        wf.steps.forEach((s, i) => {
            const stageNote = s.stage !== undefined && s.stage.trim() !== '' ? `（阶段：${s.stage}）` : '';
            lines.push(`${i + 1}. **${s.title}**${stageNote}：${s.target}`);
        });
        lines.push('');
    }
    lines.push('## 使用方式', '');
    lines.push('将本目录中的 `workflow.json` 作为 mobius 工作流模板导入，即可按上述步骤顺序执行该研究/分析目标。', '');
    return lines.join('\n');
}
/** One step node within a stage: collapsed shows only a concise title; clicking
 *  expands to reveal the full target/output. Keeps the node list scannable. */
function StepRow({ step, ordinal }) {
    const [open, setOpen] = useState(false);
    const output = step.status === 'completed' && step.output !== undefined && step.output !== ''
        ? step.output
        : null;
    const expandable = (step.target !== '' && step.target !== undefined) || output !== null;
    return (_jsxs("li", { className: `${css.step} ${css[`is-${step.status}`]}`, "data-step-id": step.id, "data-status": step.status, "data-open": open || undefined, children: [_jsxs("button", { type: "button", className: css.stepHeader, onClick: () => { if (expandable)
                    setOpen((v) => !v); }, disabled: !expandable, "aria-expanded": open, children: [_jsx("span", { className: css.statusDot, "aria-hidden": true, children: step.status === 'completed' && _jsx(IconCheckOutline14, {}) }), _jsx("span", { className: css.stepOrdinal, children: ordinal }), _jsx("span", { className: css.stepName, children: step.title }), step.status === 'running' && _jsx("span", { className: css.runningTag, children: "\u8FD0\u884C\u4E2D" }), step.status === 'halted' && _jsx("span", { className: css.haltedTag, children: "\u5DF2\u4E2D\u65AD" }), step.status === 'failed' && _jsx("span", { className: css.failedTag, children: "\u5DF2\u5931\u8D25" }), expandable && (_jsx("span", { className: css.stepCaret, "aria-hidden": true, children: _jsx(IconChevronDownOutline14, {}) }))] }), (open && expandable) && (_jsxs("div", { className: css.stepBody, children: [step.target !== '' && step.target !== undefined && _jsx("div", { className: css.stepTarget, children: step.target }), output !== null && _jsx("div", { className: css.stepOutput, children: output })] }))] }));
}
/** Per-step edit fields shown while the staged plan is being edited in place.
 *  Nodes start collapsed (open = false) so the timeline stays scannable; each
 *  header row toggles the form open/closed. */
function StepEditorRow({ stepId, ordinal, values, onChange, onRemove }) {
    const [open, setOpen] = useState(false);
    return (_jsxs("li", { className: css.step, "data-step-id": stepId, "data-editing": true, "data-open": open || undefined, children: [_jsxs("button", { type: "button", className: css.editStepHeader, onClick: () => { setOpen((v) => !v); }, "aria-expanded": open, children: [_jsxs("span", { className: css.editStepId, children: [_jsxs("span", { className: css.editStepOrdinal, children: ["\u6B65\u9AA4 ", ordinal] }), _jsx("span", { className: css.editStepTitle, children: values.title.trim() !== '' ? values.title : stepId })] }), _jsx("span", { className: css.stepCaret, "aria-hidden": true, children: _jsx(IconChevronDownOutline14, {}) })] }), open && (_jsxs("div", { className: css.editBody, children: [_jsx("div", { className: css.editRemoveRow, children: _jsx("button", { type: "button", className: css.editRemoveBtn, onClick: () => { onRemove(stepId); }, title: "\u5220\u9664\u6B64\u6B65\u9AA4", "aria-label": "\u5220\u9664\u6B64\u6B65\u9AA4", children: "\u5220\u9664" }) }), _jsxs("label", { className: css.editField, children: [_jsx("span", { className: css.editFieldLabel, children: "\u6807\u9898" }), _jsx("input", { className: css.editInput, value: values.title, onChange: (e) => { onChange(stepId, 'title', e.target.value); } })] }), _jsxs("label", { className: css.editField, children: [_jsx("span", { className: css.editFieldLabel, children: "\u76EE\u6807" }), _jsx("textarea", { className: css.editInput, value: values.target, onChange: (e) => { onChange(stepId, 'target', e.target.value); }, rows: 2 })] }), _jsxs("label", { className: css.editField, children: [_jsx("span", { className: css.editFieldLabel, children: "\u9636\u6BB5" }), _jsx("input", { className: css.editInput, value: values.stage, onChange: (e) => { onChange(stepId, 'stage', e.target.value); }, placeholder: "\uFF08\u7559\u7A7A\u4E3A\u987A\u5E8F\u6267\u884C\uFF09" })] })] }))] }));
}
/** POST one staged-plan action to the host plan route. */
async function mutatePlan(payload) {
    const response = await fetch('/plugins/dsh-mobius/plan', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (response.ok)
        return;
    let message = `HTTP ${response.status}`;
    try {
        const body = await response.json();
        if (typeof body.error === 'string' && body.error.trim() !== '')
            message = body.error;
    }
    catch { }
    throw new Error(message);
}
/** One workflow card: goal + ordered step timeline + staged-plan review actions. */
function WorkflowCard({ workflow, captainSessionId }) {
    const done = workflow.steps.filter((s) => s.status === 'completed').length;
    const pct = workflow.steps.length === 0 ? 0 : Math.round((done / workflow.steps.length) * 100);
    const phaseLabel = workflow.phase === 'staged' ? '已规划' : workflow.phase === 'done' ? '已完成' : '进行中';
    const [busy, setBusy] = useState(false);
    const [discardArmed, setDiscardArmed] = useState(false);
    const [editing, setEditing] = useState(false);
    const [error, setError] = useState('');
    const [exportOpen, setExportOpen] = useState(false);
    const exportRef = useRef(null);
    // Optimistic mirror of the two staged toggles so the switch flips instantly
    // on click instead of waiting for the server round-trip + poll. Resynced
    // whenever the authoritative workflow prop settles.
    const [cardEureka, setCardEureka] = useState(workflow.eureka === true);
    const [cardWebSearchOn, setCardWebSearchOn] = useState(workflow.disableWebSearch !== true);
    useEffect(() => {
        setCardEureka(workflow.eureka === true);
        setCardWebSearchOn(workflow.disableWebSearch !== true);
    }, [workflow.eureka, workflow.disableWebSearch]);
    const staged = workflow.phase === 'staged';
    const running = workflow.phase === 'running';
    const runAction = async (action) => {
        if (busy)
            return;
        setBusy(true);
        setError('');
        try {
            await mutatePlan({ sessionId: captainSessionId, workflowId: workflow.id, action });
            setDiscardArmed(false);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setBusy(false);
        }
    };
    // In-place editing of the staged plan: goal + per-step title/target/context/stage,
    // plus adding/removing nodes. New (not-yet-persisted) steps carry a temporary
    // id prefixed `__new`; on save they are sent via `addSteps` and existing
    // steps via `steps` edits. Deleted steps are sent via `removeStepIds`.
    const [draftGoal, setDraftGoal] = useState(workflow.goal);
    const [draftTimeout, setDraftTimeout] = useState(workflow.timeoutMs !== undefined && workflow.timeoutMs > 0 ? String(workflow.timeoutMs) : '');
    const [draftEureka, setDraftEureka] = useState(workflow.eureka === true);
    const [draftDisableWebSearch, setDraftDisableWebSearch] = useState(workflow.disableWebSearch === true);
    const [draftMaxStageCount, setDraftMaxStageCount] = useState(workflow.maxStageCount !== undefined && workflow.maxStageCount > 0 ? String(workflow.maxStageCount) : '');
    const [draftStageTitles, setDraftStageTitles] = useState(() => ({ ...(workflow.stageTitles ?? {}) }));
    const [draftSteps, setDraftSteps] = useState(() => workflow.steps.map((step) => ({
        id: step.id,
        title: step.title,
        target: step.target,
        context: step.context ?? '',
        stage: step.stage ?? '',
    })));
    const newStepCounter = useRef(0);
    const addStepToStage = (stageKey) => {
        const tempId = `__new${++newStepCounter.current}`;
        setDraftSteps((prev) => [...prev, {
                id: tempId,
                title: '',
                target: '',
                context: '',
                stage: stageKey,
            }]);
    };
    const removeStep = (id) => {
        setDraftSteps((prev) => prev.filter((step) => step.id !== id));
    };
    const setStepField = (id, field, value) => {
        setDraftSteps((prev) => prev.map((step) => step.id === id ? { ...step, [field]: value } : step));
    };
    const beginEdit = () => {
        newStepCounter.current = 0;
        setDraftGoal(workflow.goal);
        setDraftTimeout(workflow.timeoutMs !== undefined && workflow.timeoutMs > 0 ? String(workflow.timeoutMs) : '');
        setDraftEureka(workflow.eureka === true);
        setDraftDisableWebSearch(workflow.disableWebSearch === true);
        setDraftMaxStageCount(workflow.maxStageCount !== undefined && workflow.maxStageCount > 0 ? String(workflow.maxStageCount) : '');
        setDraftStageTitles({ ...(workflow.stageTitles ?? {}) });
        setDraftSteps(workflow.steps.map((step) => ({
            id: step.id,
            title: step.title,
            target: step.target,
            context: step.context ?? '',
            stage: step.stage ?? '',
        })));
        setError('');
        setEditing(true);
    };
    const saveEdit = async () => {
        if (busy)
            return;
        setBusy(true);
        setError('');
        const timeoutNum = draftTimeout.trim() === '' ? undefined : Number(draftTimeout.trim());
        if (draftTimeout.trim() !== '' && (!Number.isFinite(timeoutNum) || timeoutNum <= 0)) {
            setError('超时时长必须为正整数（毫秒）');
            setBusy(false);
            return;
        }
        const maxStageNum = draftMaxStageCount.trim() === '' ? undefined : Number(draftMaxStageCount.trim());
        if (draftMaxStageCount.trim() !== '' && (!Number.isFinite(maxStageNum) || maxStageNum < 0)) {
            setError('最大 stage 数必须为非负整数（0 表示不限制）');
            setBusy(false);
            return;
        }
        const existingSteps = draftSteps.filter((step) => !step.id.startsWith('__new'));
        const newSteps = draftSteps.filter((step) => step.id.startsWith('__new'));
        const originalIds = new Set(workflow.steps.map((step) => step.id));
        const keptIds = new Set(existingSteps.map((step) => step.id));
        const removeStepIds = [...originalIds].filter((id) => !keptIds.has(id));
        // A newly added step must have a non-empty title+target to persist.
        for (const step of newSteps) {
            if (step.title.trim() === '' || step.target.trim() === '') {
                setError('新增步骤需要填写标题和目标');
                setBusy(false);
                return;
            }
        }
        try {
            await mutatePlan({
                sessionId: captainSessionId,
                workflowId: workflow.id,
                action: 'update',
                goal: draftGoal,
                timeoutMs: timeoutNum,
                eureka: draftEureka,
                disableWebSearch: draftDisableWebSearch,
                maxStageCount: maxStageNum,
                stageTitles: draftStageTitles,
                steps: existingSteps.map((step) => ({
                    id: step.id,
                    title: step.title,
                    target: step.target,
                    context: step.context,
                    stage: step.stage,
                })),
                addSteps: newSteps.map((step) => ({
                    title: step.title,
                    target: step.target,
                    context: step.context,
                    stage: step.stage,
                })),
                removeStepIds,
            });
            setEditing(false);
            setDiscardArmed(false);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setBusy(false);
        }
    };
    const toggleWebSearch = async () => {
        if (busy)
            return;
        const nextOn = !cardWebSearchOn;
        // Optimistic flip: reflect the new value immediately so the switch has no delay.
        setCardWebSearchOn(nextOn);
        setBusy(true);
        setError('');
        try {
            await mutatePlan({
                sessionId: captainSessionId,
                workflowId: workflow.id,
                action: 'update',
                disableWebSearch: !nextOn,
            });
        }
        catch (e) {
            // Revert on failure.
            setCardWebSearchOn(!nextOn);
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setBusy(false);
        }
    };
    const toggleEureka = async () => {
        if (busy)
            return;
        const nextOn = !cardEureka;
        // Optimistic flip.
        setCardEureka(nextOn);
        setBusy(true);
        setError('');
        try {
            await mutatePlan({
                sessionId: captainSessionId,
                workflowId: workflow.id,
                action: 'update',
                eureka: nextOn,
            });
        }
        catch (e) {
            setCardEureka(!nextOn);
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setBusy(false);
        }
    };
    const download = async () => {
        if (captainSessionId === '')
            return;
        try {
            const response = await fetch(`/plugins/dsh-mobius/export?sessionId=${encodeURIComponent(captainSessionId)}&workflowId=${encodeURIComponent(workflow.id)}`, { cache: 'no-store' });
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            const name = workflow.name.replace(/[^\w.-]+/g, '_') || 'workflow';
            const blob = new Blob([text], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `${name}.mobius.json`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };
    const downloadSkill = async () => {
        if (captainSessionId === '')
            return;
        try {
            const response = await fetch(`/plugins/dsh-mobius/export?sessionId=${encodeURIComponent(captainSessionId)}&workflowId=${encodeURIComponent(workflow.id)}`, { cache: 'no-store' });
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            const workflowJson = await response.text();
            const folder = workflow.name.replace(/[^\w.-]+/g, '_') || 'workflow';
            const zip = makeZip([
                { name: `${folder}/SKILL.md`, content: buildSkillMd(workflow) },
                { name: `${folder}/workflow.json`, content: workflowJson },
            ]);
            const url = URL.createObjectURL(zip);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `${folder}.skill.zip`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };
    return (_jsxs("section", { className: css.card, "data-workflow-id": workflow.id, "data-phase": workflow.phase, children: [_jsxs("header", { className: css.head, children: [_jsx("span", { className: css.name, title: workflow.name, children: workflow.name }), _jsx("span", { className: css.phase, children: phaseLabel }), _jsxs("span", { className: css.progress, title: `已完成 ${done} / ${workflow.steps.length} 步`, children: [done, "/", workflow.steps.length, " ", _jsxs("span", { className: css.progressPct, children: [pct, "%"] }, pct)] }), _jsxs("div", { className: css.exportWrap, ref: exportRef, children: [_jsx("button", { type: "button", className: `${css.exportButton} ${exportOpen ? css.exportButtonActive : ''}`, onClick: () => { setExportOpen((v) => !v); }, "aria-label": "\u5BFC\u51FA\u6216\u5236\u4F5C skill", title: "\u5BFC\u51FA\u5DE5\u4F5C\u6D41\u6216\u5236\u4F5C skill", "aria-haspopup": "menu", "aria-expanded": exportOpen, children: _jsx(IconDownloadOutline16, {}) }), exportOpen && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.exportBackdrop, onClick: () => { setExportOpen(false); } }), _jsxs("div", { className: css.exportMenu, role: "menu", children: [_jsxs("button", { type: "button", role: "menuitem", className: css.exportMenuItem, onClick: () => { setExportOpen(false); void download(); }, children: [_jsx("span", { className: css.exportMenuItemIcon, children: _jsx(IconDownloadOutline16, {}) }), _jsxs("span", { className: css.exportMenuItemText, children: [_jsx("span", { className: css.exportMenuItemTitle, children: "\u5BFC\u51FA\u5DE5\u4F5C\u6D41" }), _jsx("span", { className: css.exportMenuItemDesc, children: ".mobius.json \u6A21\u677F" })] })] }), _jsxs("button", { type: "button", role: "menuitem", className: css.exportMenuItem, onClick: () => { setExportOpen(false); void downloadSkill(); }, children: [_jsx("span", { className: css.exportMenuItemIcon, children: _jsx(IconSkillOutline16, {}) }), _jsxs("span", { className: css.exportMenuItemText, children: [_jsx("span", { className: css.exportMenuItemTitle, children: "\u5236\u4F5C skill" }), _jsx("span", { className: css.exportMenuItemDesc, children: "SKILL.md + workflow.json \u7684 zip" })] })] })] })] }))] })] }), staged && editing ? (_jsxs("div", { className: css.editBoard, children: [_jsxs("label", { className: css.editField, children: [_jsx("span", { className: css.editFieldLabel, children: "\u76EE\u6807" }), _jsx("textarea", { className: css.editInput, value: draftGoal, onChange: (e) => { setDraftGoal(e.target.value); }, rows: 2 })] }), _jsxs("label", { className: css.editField, children: [_jsx("span", { className: css.editFieldLabel, children: "\u5355\u6B65\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF0C\u7559\u7A7A\u7528\u5168\u5C40\u9ED8\u8BA4\uFF09" }), _jsx("input", { className: css.editInput, value: draftTimeout, onChange: (e) => { setDraftTimeout(e.target.value); }, inputMode: "numeric", placeholder: "\u4F8B\u5982 600000\uFF0810 \u5206\u949F\uFF09" })] }), _jsx("span", { className: css.timeoutHint, children: "\u6BCF\u4E2A\u6B65\u9AA4\u8D85\u8FC7\u6B64\u65F6\u957F\u672A\u5B8C\u6210\u5373\u5224\u5B9A\u5931\u8D25\u5E76\u505C\u6B62\u6D41\u6C34\u7EBF\uFF08\u4E0D\u81EA\u52A8\u91CD\u8BD5\uFF09\u3002" }), _jsxs("label", { className: css.editField, children: [_jsx("span", { className: css.editFieldLabel, children: "\u6700\u5927 stage \u6570\uFF08\u7559\u7A7A\u4E3A\u4E0D\u9650\u5236\uFF09" }), _jsx("input", { className: css.editInput, value: draftMaxStageCount, onChange: (e) => { setDraftMaxStageCount(e.target.value); }, inputMode: "numeric", placeholder: "\u4F8B\u5982 5\uFF080 \u6216\u7559\u7A7A\u8868\u793A\u4E0D\u9650\u5236\uFF09" })] }), _jsxs("label", { className: css.eurekaRow, children: [_jsx("input", { type: "checkbox", className: css.eurekaCheckbox, checked: draftEureka, onChange: (e) => { setDraftEureka(e.target.checked); } }), _jsxs("span", { className: css.eurekaText, children: [_jsx("span", { className: css.eurekaName, children: "\u5C24\u91CC\u5361\u6A21\u5F0F\uFF08Eureka\uFF09" }), _jsx("span", { className: css.eurekaDesc, children: "\u5F00\u542F\u540E\uFF0C\u8BA9\u6B63\u5728\u7814\u7A76\u7684\u6B65\u9AA4 agent \u80FD\u4E3B\u52A8\u53D1\u73B0\u65B0\u95EE\u9898\u3001\u65B0\u589E\u6216\u8C03\u6574\u540E\u9762\u8FD8\u6CA1\u5F00\u59CB\u7684\u6B65\u9AA4\uFF0C\u9002\u5408\u5F00\u653E\u5F0F\u3001\u9700\u8981\u7075\u6D3B\u6DF1\u6316\u7684\u7814\u7A76\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF09" })] })] }), _jsxs("label", { className: css.eurekaRow, children: [_jsx("input", { type: "checkbox", className: css.eurekaCheckbox, checked: !draftDisableWebSearch, onChange: (e) => { setDraftDisableWebSearch(!e.target.checked); } }), _jsxs("span", { className: css.eurekaText, children: [_jsx("span", { className: css.eurekaName, children: "\u542F\u7528\u7F51\u9875\u641C\u7D22" }), _jsx("span", { className: css.eurekaDesc, children: "\u6B65\u9AA4 agent \u53EF\u4F7F\u7528 web_search / web_fetch \u8054\u7F51\u68C0\u7D22\u6700\u65B0\u4FE1\u606F" })] })] })] })) : (_jsxs(_Fragment, { children: [workflow.goal !== '' && _jsx("div", { className: css.goal, children: workflow.goal }), workflow.timeoutMs !== undefined && workflow.timeoutMs > 0 && (_jsxs("div", { className: css.timeoutBadge, title: `每个步骤 ${durationLabel(workflow.timeoutMs)} 未完成即失败`, children: ["\u5355\u6B65\u8D85\u65F6 ", durationLabel(workflow.timeoutMs)] })), workflow.maxStageCount !== undefined && workflow.maxStageCount > 0 && (_jsxs("div", { className: css.timeoutBadge, title: `整个工作流最多 ${workflow.maxStageCount} 个执行阶段`, children: ["\u6700\u591A ", workflow.maxStageCount, " \u4E2A stage"] })), staged ? (_jsxs("div", { className: css.optionToggles, children: [_jsxs("label", { className: css.eurekaToggle, title: "\u5C24\u91CC\u5361\u6A21\u5F0F\uFF1A\u8BA9\u6B63\u5728\u7814\u7A76\u7684\u6B65\u9AA4 agent \u80FD\u4E3B\u52A8\u53D1\u73B0\u65B0\u95EE\u9898\u3001\u65B0\u589E\u6216\u8C03\u6574\u540E\u9762\u8FD8\u6CA1\u5F00\u59CB\u7684\u6B65\u9AA4\uFF0C\u9002\u5408\u5F00\u653E\u5F0F\u7814\u7A76", children: [_jsxs("span", { className: css.eurekaToggleLabel, children: [_jsx("span", { children: "\u5C24\u91CC\u5361\u6A21\u5F0F" }), _jsx("span", { className: css.eurekaToggleSub, children: cardEureka ? '启用中：agent 可自动调整后续步骤' : '已关闭：按预定步骤顺序执行' })] }), _jsx("button", { type: "button", role: "switch", "aria-checked": cardEureka, className: css.eurekaSwitch, "data-on": cardEureka || undefined, disabled: busy, onClick: () => { void toggleEureka(); }, children: _jsx("span", { className: css.eurekaKnob }) })] }), _jsxs("label", { className: css.eurekaToggle, title: "\u542F\u7528\u7F51\u9875\u641C\u7D22\uFF1A\u6B65\u9AA4 agent \u53EF\u4F7F\u7528 web_search / web_fetch \u8054\u7F51\u68C0\u7D22", children: [_jsxs("span", { className: css.eurekaToggleLabel, children: [_jsx("span", { children: "\u542F\u7528\u7F51\u9875\u641C\u7D22" }), _jsx("span", { className: css.eurekaToggleSub, children: cardWebSearchOn ? '步骤可使用 web_search / web_fetch' : '步骤仅凭自身知识与记忆' })] }), _jsx("button", { type: "button", role: "switch", "aria-checked": cardWebSearchOn, className: css.eurekaSwitch, "data-on": cardWebSearchOn || undefined, disabled: busy, onClick: () => { void toggleWebSearch(); }, children: _jsx("span", { className: css.eurekaKnob }) })] })] })) : workflow.eureka === true && (_jsxs("div", { className: css.eurekaBadge, title: "\u5C24\u91CC\u5361\u6A21\u5F0F\u5DF2\u5F00\u542F\uFF1A\u8FD0\u884C\u4E2D\u7684\u6B65\u9AA4 agent \u53EF\u4E3B\u52A8\u586B\u8865\u9057\u6F0F\u3001\u5206\u5272\u6216\u7CBE\u7B80\u5C1A\u672A\u5F00\u59CB\u7684\u540E\u7EED\u6B65\u9AA4", children: [_jsx("span", { className: css.eurekaBadgeOn, children: "\u5C24\u91CC\u5361\u6A21\u5F0F\u542F\u7528\u4E2D" }), _jsx("span", { className: css.eurekaBadgeZh, children: "\u00B7 \u6B65\u9AA4\u4F1A\u968F\u7814\u7A76\u63A8\u8FDB\u81EA\u52A8\u4F18\u5316" })] }))] })), _jsx("div", { className: css.bar, role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuetext": `${pct}%`, children: _jsx("div", { className: css.barFill, style: { width: `${pct}%` }, children: _jsx("span", { className: css.barShimmer }) }) }), (workflow.steps.length > 0 || (staged && editing)) && (() => {
                const groups = staged && editing ? groupDraftSteps(draftSteps) : groupStepsByStage(workflow.steps);
                return (_jsx("ol", { className: css.stages, children: groups.flatMap((group, groupIndex) => {
                        const first = group[0];
                        const hasStageName = first?.stage !== undefined && first.stage.trim() !== '';
                        const stageKey = hasStageName
                            ? first.stage.trim()
                            : (first?.id !== undefined ? `@${first.id}` : '');
                        // Display fallback heading when no stage summary name is set.
                        const fallbackName = hasStageName
                            ? first.stage.trim()
                            : `阶段 ${groupIndex + 1}`;
                        const summary = (staged && editing ? draftStageTitles : workflow.stageTitles)?.[stageKey] ?? '';
                        const stageName = summary !== '' ? summary : fallbackName;
                        const parallel = group.length > 1;
                        const editingThis = staged && editing;
                        const stage = (_jsxs("li", { className: css.stageBlock, "data-stage": first?.stage, children: [_jsxs("div", { className: css.stageBlockHead, children: [_jsx("span", { className: css.stageBlockIndex, children: groupIndex + 1 }), editingThis ? (_jsx("input", { className: css.stageNameEdit, value: summary, placeholder: fallbackName, onChange: (e) => {
                                                const value = e.target.value;
                                                setDraftStageTitles((prev) => {
                                                    const next = { ...prev };
                                                    if (value.trim() === '')
                                                        delete next[stageKey];
                                                    else
                                                        next[stageKey] = value;
                                                    return next;
                                                });
                                            }, "aria-label": `阶段 ${groupIndex + 1} 概括名` })) : (_jsx("span", { className: css.stageBlockName, children: stageName })), parallel ? _jsxs("span", { className: css.stageBlockParallel, children: [group.length, " \u6B65\u5E76\u884C"] }) : _jsx("span", { className: css.stageBlockSerial, children: "\u5355\u6B65" })] }), _jsx("ol", { className: css.stageSteps, children: group.map((step, stepIndex) => editingThis
                                        ? _jsx(StepEditorRow, { stepId: step.id, ordinal: stepIndex + 1, values: step, onChange: setStepField, onRemove: removeStep }, step.id)
                                        : _jsx(StepRow, { step: step, ordinal: stepIndex + 1 }, step.id)) }), editingThis && (_jsx("button", { type: "button", className: css.addStepBtn, onClick: () => { addStepToStage(stageKey); }, children: "\uFF0B \u6DFB\u52A0\u6B65\u9AA4" }))] }, `stage${groupIndex}`));
                        return groupIndex === 0
                            ? [stage]
                            : [_jsx("li", { className: css.stageConnector, "aria-hidden": true }, `conn${groupIndex}`), stage];
                    }) }));
            })(), workflow.review !== undefined && workflow.review.status === 'needs_revision' && (_jsx("div", { className: css.reviewBanner, "data-rejected": true, children: _jsxs("div", { className: css.reviewText, children: [_jsxs("span", { className: css.reviewRound, children: ["\u7B2C ", workflow.review.round, " \u8F6E\u5BA1\u6838\u672A\u901A\u8FC7"] }), _jsx("span", { className: css.reviewFindings, children: workflow.review.findings })] }) })), workflow.review !== undefined && workflow.review.status === 'awaiting_review' && workflow.phase === 'running' && (_jsx("div", { className: css.reviewBanner, "data-pending": true, children: _jsxs("span", { className: css.reviewRound, children: ["\u5BA1\u6838\u4E2D\uFF08\u7B2C ", workflow.review.round, " \u8F6E\uFF09"] }) })), workflow.review !== undefined && workflow.review.status === 'passed' && (_jsx("div", { className: css.reviewBanner, "data-passed": true, children: _jsx("span", { className: css.reviewRound, children: "\u6700\u7EC8\u7ED3\u8BBA\u5BA1\u6838\u901A\u8FC7" }) })), workflow.conclusion !== undefined && workflow.conclusion !== '' && workflow.phase === 'done' && (_jsxs("details", { className: css.conclusion, children: [_jsx("summary", { children: "\u6700\u7EC8\u7ED3\u8BBA" }), _jsx("div", { className: css.conclusionBody, children: workflow.conclusion })] })), staged && (_jsxs("div", { className: css.planActions, "data-armed": discardArmed || undefined, children: [discardArmed ? (_jsxs(_Fragment, { children: [_jsx("span", { className: css.planConfirm, children: "\u786E\u8BA4\u4E22\u5F03\u8FD9\u4E2A\u8BA1\u5212\uFF1F" }), _jsx("button", { type: "button", className: css.planBtn, disabled: busy, onClick: () => { setDiscardArmed(false); }, children: "\u53D6\u6D88" }), _jsx("button", { type: "button", className: css.planBtnDanger, disabled: busy, onClick: () => { void runAction('discard'); }, children: busy ? '丢弃中…' : '确认丢弃' })] })) : editing ? (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: css.planBtnPrimary, disabled: busy, onClick: () => { void saveEdit(); }, children: busy ? '保存中…' : '保存修改' }), _jsx("button", { type: "button", className: css.planBtn, disabled: busy, onClick: () => { setEditing(false); setError(''); }, children: "\u53D6\u6D88" })] })) : (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: css.planBtnPrimary, disabled: busy, onClick: () => { void runAction('approve'); }, children: busy ? '启动中…' : '启动' }), _jsx("button", { type: "button", className: css.planBtn, disabled: busy, onClick: () => { beginEdit(); }, children: "\u7F16\u8F91\u8BA1\u5212" }), _jsx("button", { type: "button", className: css.planBtn, disabled: busy, onClick: () => { void runAction('continue'); }, children: "\u8FD4\u56DE\u5BF9\u8BDD\u91CD\u65B0\u89C4\u5212" }), _jsx("button", { type: "button", className: css.planBtnDanger, disabled: busy, onClick: () => { setDiscardArmed(true); setError(''); }, children: "\u4E22\u5F03" })] })), error !== '' && _jsx("span", { className: css.planError, children: error })] })), running && error !== '' && _jsx("span", { className: css.planError, children: error })] }));
}
export function MobiusActivityPanel({ sessionsList }) {
    const [open, setOpen] = useState(false);
    const [openOwner, setOpenOwner] = useState();
    const [autoOpened, setAutoOpened] = useState(false);
    const [wasActive, setWasActive] = useState(false);
    const [layout, setLayout] = useState(initialPanelLayout);
    const [badgeOffset, setBadgeOffset] = useState(() => parseBadgeOffset(window.localStorage.getItem(PANEL_BADGE_OFFSET_STORAGE_KEY)));
    const [badgeDragging, setBadgeDragging] = useState(false);
    const [bounds, setBounds] = useState(initialPanelBounds);
    const [interaction, setInteraction] = useState(null);
    const panelRef = useRef(null);
    const boundsRef = useRef(bounds);
    const gestureRef = useRef(null);
    const frameRef = useRef(null);
    const pendingLayoutRef = useRef(null);
    const current = useSyncExternalStore(sessionsList.subscribe, sessionsList.getSnapshot).current;
    const autoOpenTrackerRef = useRef({ sessionId: current, restoreComplete: false, liveWorkflowIds: new Set() });
    const monitorTargets = useSyncExternalStore(subscribeMobiusMonitorTargets, getMobiusMonitorTargetsSnapshot);
    const { workflows } = useSyncExternalStore(subscribeMobiusSnapshots, getMobiusSnapshotsSnapshot);
    const currentTargets = useMemo(() => current === undefined ? [] : monitorTargets.filter((target) => target.sessionId === current), [current, monitorTargets]);
    const currentRef = useRef(current);
    useEffect(() => { currentRef.current = current; }, [current]);
    // The in-conversation card's "open activity panel" button re-activates this
    // floater via a window event, even after it was closed or when an old
    // session is reopened for review.
    useEffect(() => {
        const onOpenPanel = (event) => {
            const activeSession = currentRef.current;
            if (activeSession === undefined)
                return;
            setOpenOwner(activeSession);
            setOpen(true);
        };
        window.addEventListener(OPEN_MOBIUS_PANEL_EVENT, onOpenPanel);
        return () => {
            window.removeEventListener(OPEN_MOBIUS_PANEL_EVENT, onOpenPanel);
        };
    }, []);
    const mountedAtRef = useRef(performance.now());
    const expanded = mobiusPanelExpandedForSession(open, openOwner, current);
    const geometry = useMemo(() => resolvePanelGeometry(layout, bounds), [layout, bounds]);
    const compact = compactPanelForBounds(bounds);
    const commitLayout = useCallback((next) => {
        setLayout(next);
    }, []);
    useEffect(() => {
        window.localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    }, [layout]);
    const handleBadgeDrag = useCallback((delta) => {
        setBadgeDragging(true);
        setBadgeOffset(delta);
    }, []);
    const handleBadgeDragEnd = useCallback(() => {
        setBadgeDragging(false);
        // Persist the settled offset on gesture end (not during drag) so partial
        // movement never corrupts the stored position.
        setBadgeOffset((current) => {
            window.localStorage.setItem(PANEL_BADGE_OFFSET_STORAGE_KEY, JSON.stringify(current));
            return current;
        });
    }, []);
    // The slot sits inside AppFrame, so all geometry is measured against the
    // shell overlay rather than the browser viewport. The conversation's real
    // right edge is the dock anchor and naturally follows sidebar/details
    // concessions without importing their hashed implementation classes.
    useLayoutEffect(() => {
        const overlay = document.querySelector('[data-shell-overlay]');
        if (overlay === null)
            return;
        const conversation = document.querySelector("[data-phase='active']");
        let frame = null;
        const measure = () => {
            frame = null;
            const overlayRect = overlay.getBoundingClientRect();
            const conversationRect = conversation?.getBoundingClientRect();
            const next = {
                width: overlayRect.width,
                height: overlayRect.height,
                anchorRight: conversationRect === undefined
                    ? overlayRect.width
                    : Math.min(Math.max(conversationRect.right - overlayRect.left, 0), overlayRect.width),
            };
            const previous = boundsRef.current;
            if (previous.width === next.width
                && previous.height === next.height
                && previous.anchorRight === next.anchorRight)
                return;
            boundsRef.current = next;
            setBounds(next);
        };
        const scheduleMeasure = () => {
            frame ??= requestAnimationFrame(measure);
        };
        measure();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
        observer?.observe(overlay);
        if (conversation !== null)
            observer?.observe(conversation);
        window.addEventListener('resize', scheduleMeasure);
        return () => {
            if (frame !== null)
                cancelAnimationFrame(frame);
            observer?.disconnect();
            window.removeEventListener('resize', scheduleMeasure);
        };
    }, [current]);
    // This shell overlay survives conversation route changes. Gate expansion by
    // its owning session during render, then clear stale state before paint.
    // This removes the old panel immediately instead of waiting for the
    // no-workflow autoclose grace period on the destination page.
    useLayoutEffect(() => {
        const tracker = autoOpenTrackerRef.current;
        if (tracker.sessionId !== current) {
            tracker.sessionId = current;
            tracker.restoreComplete = false;
            tracker.liveWorkflowIds = new Set();
            setWasActive(false);
            setAutoOpened(false);
        }
        if (openOwner === undefined || openOwner === current)
            return;
        setOpen(false);
        setOpenOwner(undefined);
    }, [current, openOwner]);
    // Only the wide docked mode asks the conversation column to yield. Floating
    // and compact modes are intentionally true overlays.
    useLayoutEffect(() => {
        const root = document.documentElement;
        const shouldYield = expanded && geometry.mode === 'docked' && !compact;
        if (shouldYield) {
            root.setAttribute(PANEL_OPEN_ATTRIBUTE, '');
            root.style.setProperty(PANEL_SHIFT_PROPERTY, `${geometry.width + PANEL_CONVERSATION_GAP + 18}px`);
        }
        else {
            root.removeAttribute(PANEL_OPEN_ATTRIBUTE);
            root.style.removeProperty(PANEL_SHIFT_PROPERTY);
        }
        return () => {
            root.removeAttribute(PANEL_OPEN_ATTRIBUTE);
            root.style.removeProperty(PANEL_SHIFT_PROPERTY);
        };
    }, [compact, expanded, geometry.mode, geometry.width]);
    useEffect(() => {
        if (current === undefined)
            return;
        // The current-session scope performs one cold-start discovery pass so
        // workflows survive a browser or `dsh web` restart.
        const controller = startMobiusPolling(currentTargets, { discoverySessionId: current });
        let active = true;
        const tracker = autoOpenTrackerRef.current;
        if (tracker.sessionId === current && !tracker.restoreComplete) {
            void controller.firstTick.then(() => {
                const latest = autoOpenTrackerRef.current;
                if (!active || latest.sessionId !== current || latest.restoreComplete)
                    return;
                latest.liveWorkflowIds = new Set(getMobiusSnapshotsSnapshot().workflows
                    .filter((workflow) => workflow.captainSessionId === current)
                    .map((workflow) => workflow.id));
                latest.restoreComplete = true;
            });
        }
        return () => {
            active = false;
            controller.stop();
        };
    }, [current, currentTargets]);
    // Workflows follow the current session: snapshots are visible only while
    // their captain session is current.
    const visibleWorkflows = useMemo(
    // No current session (initial load): show nothing until one is picked,
    // so cross-session workflows never leak into the floater.
    () => (current === undefined ? [] : workflows.filter((workflow) => workflow.captainSessionId === current)), [workflows, current]);
    const visibleCount = visibleWorkflows.length;
    const visibleLiveWorkflowIds = useMemo(() => visibleWorkflows.map((workflow) => workflow.id).sort(), [visibleWorkflows]);
    const visibleLiveWorkflowKey = visibleLiveWorkflowIds.join('\u0000');
    useEffect(() => {
        const tracker = autoOpenTrackerRef.current;
        const settled = performance.now() - mountedAtRef.current >= AUTO_OPEN_SETTLE_MS;
        const shouldAutoExpand = tracker.sessionId === current && mobiusPanelShouldAutoExpand({
            alreadyAutoOpened: autoOpened,
            pageSettled: settled,
            restoreComplete: tracker.restoreComplete,
            previousLiveWorkflowIds: tracker.liveWorkflowIds,
            currentLiveWorkflowIds: visibleLiveWorkflowIds,
        });
        if (tracker.sessionId === current && tracker.restoreComplete) {
            tracker.liveWorkflowIds = new Set(visibleLiveWorkflowIds);
        }
        if (visibleCount > 0) {
            setWasActive(true);
            // Existing state restored for a reopened conversation stays collapsed.
            // Only a workflow that appears after the restore pass may auto-expand.
            if (shouldAutoExpand) {
                setOpenOwner(current);
                setOpen(true);
                setAutoOpened(true);
            }
            return;
        }
        if (!wasActive)
            return;
        const timer = setTimeout(() => {
            setOpen(false);
            setOpenOwner(undefined);
            setWasActive(false);
            // Re-arm auto-expand: later activity (new workflow, new session) may
            // open the panel on its own again.
            setAutoOpened(false);
        }, AUTOCLOSE_GRACE_MS);
        return () => { clearTimeout(timer); };
    }, [visibleCount, visibleLiveWorkflowKey, autoOpened, wasActive, current]);
    const busy = useMemo(() => visibleWorkflows.some((workflow) => workflow.steps.some((step) => step.status === 'running')), [visibleWorkflows]);
    const hasWorkflows = visibleCount > 0;
    const phase = useMemo(() => mobiusPanelPhaseOf(visibleWorkflows), [visibleWorkflows]);
    const activePhase = phase === 'idle' ? 'running' : phase;
    const runsWater = mobiusRunsWater(phase);
    // Panel-level interrupt: the header's stop button (top-right) interrupts
    // every running workflow of the current session at once.
    const [panelHalting, setPanelHalting] = useState(false);
    const [panelError, setPanelError] = useState('');
    const runningWorkflows = useMemo(() => visibleWorkflows.filter((workflow) => workflow.phase === 'running'), [visibleWorkflows]);
    const runningWorkflowIds = runningWorkflows.map((workflow) => workflow.id).join('\u0000');
    const panelHalt = useCallback(async () => {
        if (panelHalting)
            return;
        const sessionId = currentRef.current;
        if (sessionId === undefined)
            return;
        const targets = runningWorkflows.filter((workflow) => workflow.phase === 'running');
        if (targets.length === 0)
            return;
        setPanelHalting(true);
        setPanelError('');
        try {
            await Promise.all(targets.map(async (workflow) => {
                const response = await fetch('/plugins/dsh-mobius/halt', {
                    method: 'POST',
                    cache: 'no-store',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ sessionId, workflowId: workflow.id }),
                });
                if (!response.ok)
                    throw new Error(`HTTP ${response.status}`);
            }));
        }
        catch (error) {
            setPanelError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setPanelHalting(false);
        }
    }, [panelHalting, runningWorkflowIds]);
    // Auto-height panels do not store their live content height. Capture the
    // rendered box when a pointer gesture starts so movement and a first manual
    // resize clamp against what the user actually sees.
    const panelGeometryForGesture = useCallback(() => {
        const measuredHeight = panelRef.current?.getBoundingClientRect().height;
        if (measuredHeight === undefined || measuredHeight <= 0)
            return geometry;
        return { ...geometry, height: measuredHeight };
    }, [geometry]);
    const flushScheduledLayout = useCallback(() => {
        if (frameRef.current !== null) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        }
        const pending = pendingLayoutRef.current;
        pendingLayoutRef.current = null;
        if (pending !== null)
            commitLayout(pending);
    }, [commitLayout]);
    const scheduleLayout = useCallback((next) => {
        pendingLayoutRef.current = next;
        frameRef.current ??= requestAnimationFrame(() => {
            frameRef.current = null;
            const pending = pendingLayoutRef.current;
            pendingLayoutRef.current = null;
            if (pending !== null)
                commitLayout(pending);
        });
    }, [commitLayout]);
    useEffect(() => () => {
        if (frameRef.current !== null)
            cancelAnimationFrame(frameRef.current);
    }, []);
    const beginMove = useCallback((event) => {
        if (compact || event.button !== 0 || event.target.closest('button') !== null)
            return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        gestureRef.current = {
            kind: 'move',
            pointerId: event.pointerId,
            originX: event.clientX,
            originY: event.clientY,
            start: panelGeometryForGesture(),
            activated: false,
        };
    }, [compact, panelGeometryForGesture]);
    const beginResize = useCallback((edge, event) => {
        if (compact || event.button !== 0 || (geometry.mode === 'docked' && edge !== 'left'))
            return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        gestureRef.current = {
            kind: 'resize',
            edge,
            pointerId: event.pointerId,
            originX: event.clientX,
            originY: event.clientY,
            start: panelGeometryForGesture(),
            activated: true,
        };
        setInteraction('resizing');
    }, [compact, geometry.mode, panelGeometryForGesture]);
    const updateGesture = useCallback((event) => {
        const gesture = gestureRef.current;
        if (gesture === null || gesture.pointerId !== event.pointerId
            || !event.currentTarget.hasPointerCapture(event.pointerId))
            return;
        const dx = event.clientX - gesture.originX;
        const dy = event.clientY - gesture.originY;
        const activeBounds = boundsRef.current;
        if (gesture.kind === 'move') {
            if (!gesture.activated && Math.hypot(dx, dy) < MOVE_THRESHOLD)
                return;
            if (!gesture.activated) {
                gesture.activated = true;
                setInteraction('dragging');
            }
            scheduleLayout(movePanelLayout(floatPanelLayout(gesture.start, activeBounds), dx, dy, activeBounds));
            return;
        }
        scheduleLayout(resizePanelLayout(gesture.start, gesture.edge ?? 'left', dx, dy, activeBounds));
    }, [scheduleLayout]);
    const endGesture = useCallback((event) => {
        const gesture = gestureRef.current;
        if (gesture === null || gesture.pointerId !== event.pointerId)
            return;
        updateGesture(event);
        flushScheduledLayout();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        gestureRef.current = null;
        setInteraction(null);
    }, [flushScheduledLayout, updateGesture]);
    const cancelGesture = useCallback((event) => {
        const gesture = gestureRef.current;
        if (gesture === null || gesture.pointerId !== event.pointerId)
            return;
        flushScheduledLayout();
        gestureRef.current = null;
        setInteraction(null);
    }, [flushScheduledLayout]);
    const toggleDock = useCallback(() => {
        const liveGeometry = panelGeometryForGesture();
        commitLayout(liveGeometry.mode === 'docked'
            ? floatPanelLayout(liveGeometry, boundsRef.current)
            : dockPanelLayout(liveGeometry, boundsRef.current));
    }, [commitLayout, panelGeometryForGesture]);
    const autoHeight = panelUsesAutoHeight(geometry, bounds);
    const panelStyle = {
        width: geometry.width,
        height: autoHeight ? 'auto' : geometry.height,
        maxHeight: panelMaximumHeight(geometry, bounds),
        transform: `translate3d(${geometry.x}px, ${geometry.y}px, 0)`,
    };
    if (!hasWorkflows && !expanded)
        return null;
    return (_jsxs(_Fragment, { children: [!expanded && (_jsx(CollapsedBadge, { count: visibleCount, phase: activePhase, busy: busy, offset: badgeOffset, onDrag: handleBadgeDrag, onDragEnd: handleBadgeDragEnd, dragging: badgeDragging, onClick: () => {
                    if (current === undefined)
                        return;
                    setOpenOwner(current);
                    setOpen(true);
                } })), expanded && (_jsxs("aside", { ref: panelRef, className: css.panel, style: panelStyle, "data-mobius-activity": true, "data-phase": activePhase, "data-panel-mode": geometry.mode, "data-height-mode": autoHeight ? 'auto' : 'manual', "data-compact": compact || undefined, "data-dragging": interaction === 'dragging' || undefined, "data-resizing": interaction === 'resizing' || undefined, "aria-label": "Mobius \u7814\u7A76\u5DE5\u4F5C\u6D41", children: [_jsxs("header", { className: css.panelHead, onPointerDown: beginMove, onPointerMove: updateGesture, onPointerUp: endGesture, onPointerCancel: cancelGesture, "data-drag-handle": !compact || undefined, children: [_jsxs("span", { className: css.panelTitle, children: [_jsxs("span", { children: ["Mobius ", phaseLabel(activePhase)] }), _jsx("span", { className: css.panelDot, "data-busy": busy, "aria-hidden": true })] }), _jsxs("span", { className: css.panelControls, children: [runningWorkflows.length > 0 && (_jsx("button", { type: "button", className: css.iconButton, "data-control": "halt", onClick: () => { void panelHalt(); }, disabled: panelHalting, "aria-label": panelHalting ? '正在停止…' : '强制中断', title: panelHalting ? '正在停止…' : '强制中断', children: _jsx(IconStopFill16, {}) })), !compact && (_jsx("button", { type: "button", className: css.iconButton, "data-control": "dock", "data-mode": geometry.mode, onClick: toggleDock, "aria-label": geometry.mode === 'docked' ? '浮动窗口' : '停靠右侧', title: geometry.mode === 'docked' ? '浮动窗口' : '停靠右侧', children: _jsx(IconPanelLeftOutline16, {}) })), _jsx("button", { type: "button", className: css.iconButton, "data-control": "collapse", onClick: () => {
                                            setOpen(false);
                                            setOpenOwner(undefined);
                                        }, "aria-label": "\u6298\u53E0", title: "\u6298\u53E0", children: _jsx(IconChevronDownOutline14, {}) })] })] }), _jsx("div", { className: css.waterWaves, "data-active": runsWater || undefined, "aria-hidden": true }), _jsxs("div", { className: css.workflows, children: [visibleCount === 0
                                ? _jsx("span", { className: css.emptyHint, children: "\u6682\u65E0\u7814\u7A76\u5DE5\u4F5C\u6D41\u3002\u5BF9\u6211\u8BF4\u201C\u6211\u8981\u7814\u7A76 xxx\u201D\u3002" })
                                : visibleWorkflows.map((workflow) => _jsx(WorkflowCard, { workflow: workflow, captainSessionId: current ?? '' }, workflow.id)), panelError !== '' && _jsx("span", { className: css.planError, children: panelError })] }), !compact && (_jsx("div", { className: css.resizeHandle, "data-resize-edge": "left", onPointerDown: (event) => { beginResize('left', event); }, onPointerMove: updateGesture, onPointerUp: endGesture, onPointerCancel: cancelGesture, "aria-hidden": true })), !compact && geometry.mode === 'floating' && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.resizeHandle, "data-resize-edge": "bottom", onPointerDown: (event) => { beginResize('bottom', event); }, onPointerMove: updateGesture, onPointerUp: endGesture, onPointerCancel: cancelGesture, "aria-hidden": true }), _jsx("div", { className: css.resizeHandle, "data-resize-edge": "corner", onPointerDown: (event) => { beginResize('corner', event); }, onPointerMove: updateGesture, onPointerUp: endGesture, onPointerCancel: cancelGesture, "aria-hidden": true })] }))] }))] }));
}
