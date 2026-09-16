/**
 * Pure persisted geometry rules for the DAI notebook floating capsule.
 *
 * A single collapsed pill docked to the viewport edge, draggable to a
 * remembered position, expanding into a small attached panel. Unlike the
 * agent-teams/mobius panels (which dock beside the conversation column), the
 * capsule is intentionally lightweight and global: it floats at the bottom
 * right, near the composer, without conceding the conversation column.
 */
export const CAPSULE_STORAGE_KEY = 'dsh-dai-notebook:capsule:v1';
export const PANEL_STORAGE_KEY = 'dsh-dai-notebook:panel:v1';
export const PANEL_SIZE_KEY = 'dsh-dai-notebook:panel-size:v1';
export const CAPSULE_SIZE = 44;
export const PANEL_WIDTH = 480;
export const PANEL_MAX_HEIGHT = 560;
export const PANEL_MIN_WIDTH = 320;
export const PANEL_MIN_HEIGHT = 300;
export const EDGE_MARGIN = 16;
export function parsePanelSize(value) {
    if (value === null)
        return null;
    try {
        const parsed = JSON.parse(value);
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const record = parsed;
        if (!finite(record.width) || !finite(record.height))
            return null;
        return { width: record.width, height: record.height };
    }
    catch {
        return null;
    }
}
/** Clamp a panel size into the visible viewport (stays near bottom-right). */
export function clampPanelSize(size, viewport) {
    const maxW = Math.max(PANEL_MIN_WIDTH, viewport.width - 24);
    const maxH = Math.max(PANEL_MIN_HEIGHT, viewport.height - 24);
    return {
        width: Math.min(Math.max(size.width, PANEL_MIN_WIDTH), maxW),
        height: Math.min(Math.max(size.height, PANEL_MIN_HEIGHT), maxH),
    };
}
export const DEFAULT_POSITION = Object.freeze({
    x: 16,
    y: 16,
});
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
export function parseCapsulePosition(value) {
    if (value === null)
        return DEFAULT_POSITION;
    try {
        const parsed = JSON.parse(value);
        if (typeof parsed !== 'object' || parsed === null)
            return DEFAULT_POSITION;
        const record = parsed;
        if (!finite(record.x) || !finite(record.y))
            return DEFAULT_POSITION;
        return { x: record.x, y: record.y };
    }
    catch {
        return DEFAULT_POSITION;
    }
}
/** Clamp the bottom-right capsule position into the visible viewport. */
export function clampPosition(pos, viewport) {
    const maxX = Math.max(EDGE_MARGIN, viewport.width - CAPSULE_SIZE - EDGE_MARGIN);
    const maxY = Math.max(EDGE_MARGIN, viewport.height - CAPSULE_SIZE - EDGE_MARGIN);
    return {
        x: Math.min(Math.max(pos.x, EDGE_MARGIN), maxX),
        y: Math.min(Math.max(pos.y, EDGE_MARGIN), maxY),
    };
}
/**
 * Position and drag use the same frame as the capsule's CSS: `x` = right
 * offset, `y` = bottom offset (distance from the viewport's right/bottom edge).
 * Dragging the pointer right/down therefore *decreases* the offset, so the
 * mouse delta must be subtracted from the origin.
 */
export function anchorPanel(capsule, viewport, size) {
    const width = size?.width ?? PANEL_WIDTH;
    const height = size?.height ?? PANEL_MAX_HEIGHT;
    const left = Math.min(Math.max(viewport.width - capsule.x - width, 12), Math.max(12, viewport.width - width - 12));
    // The capsule sits at the bottom-right; the panel pops up above it. In the
    // right/bottom frame, the capsule's top edge is at
    // `viewport.height - capsule.y - CAPSULE_SIZE`, so panel top = that minus the
    // panel height and a small gap (clamped to the top margin).
    const top = Math.max(12, viewport.height - capsule.y - CAPSULE_SIZE - 10 - height);
    return { top, left };
}
export function dragPosition(start, dx, dy, viewport) {
    // right/bottom frame: moving the pointer right/down shrinks the offset.
    return clampPosition({ x: start.x - dx, y: start.y - dy }, viewport);
}
export function parsePanelPosition(value) {
    if (value === null)
        return null;
    try {
        const parsed = JSON.parse(value);
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const record = parsed;
        if (!finite(record.left) || !finite(record.top))
            return null;
        return { left: record.left, top: record.top };
    }
    catch {
        return null;
    }
}
/** Clamp a panel position (left/top) into the visible viewport. */
export function clampPanelPosition(pos, viewport, size) {
    const width = size?.width ?? PANEL_WIDTH;
    const height = size?.height ?? PANEL_MAX_HEIGHT;
    const maxLeft = Math.max(12, viewport.width - width - 12);
    const maxTop = Math.max(12, viewport.height - height - 12);
    return {
        left: Math.min(Math.max(pos.left, 12), maxLeft),
        top: Math.min(Math.max(pos.top, 12), maxTop),
    };
}
/** Drag the panel in left/top frame: pointer right/down increases offsets. */
export function dragPanelPosition(start, dx, dy, viewport, size) {
    return clampPanelPosition({ left: start.left + dx, top: start.top + dy }, viewport, size);
}
