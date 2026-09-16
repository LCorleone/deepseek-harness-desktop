/**
 * Pure persisted geometry rules for the DAI notebook floating capsule.
 *
 * A single collapsed pill docked to the viewport edge, draggable to a
 * remembered position, expanding into a small attached panel. Unlike the
 * agent-teams/mobius panels (which dock beside the conversation column), the
 * capsule is intentionally lightweight and global: it floats at the bottom
 * right, near the composer, without conceding the conversation column.
 */
export declare const CAPSULE_STORAGE_KEY = "dsh-dai-notebook:capsule:v1";
export declare const PANEL_STORAGE_KEY = "dsh-dai-notebook:panel:v1";
export declare const PANEL_SIZE_KEY = "dsh-dai-notebook:panel-size:v1";
export declare const CAPSULE_SIZE = 44;
export declare const PANEL_WIDTH = 480;
export declare const PANEL_MAX_HEIGHT = 560;
export declare const PANEL_MIN_WIDTH = 320;
export declare const PANEL_MIN_HEIGHT = 300;
export declare const EDGE_MARGIN = 16;
/** Persisted, user-resizable panel size (px). */
export interface PanelSize {
    readonly width: number;
    readonly height: number;
}
export declare function parsePanelSize(value: string | null): PanelSize | null;
/** Clamp a panel size into the visible viewport (stays near bottom-right). */
export declare function clampPanelSize(size: PanelSize, viewport: Viewport): PanelSize;
/** User-owned capsule position persisted between sessions. */
export interface CapsulePosition {
    readonly x: number;
    readonly y: number;
}
export interface Viewport {
    readonly width: number;
    readonly height: number;
}
export declare const DEFAULT_POSITION: CapsulePosition;
export declare function parseCapsulePosition(value: string | null): CapsulePosition;
/** Clamp the bottom-right capsule position into the visible viewport. */
export declare function clampPosition(pos: CapsulePosition, viewport: Viewport): CapsulePosition;
/** The panel pops above the capsule, right-aligned to the capsule's right edge. */
export interface PanelAnchor {
    readonly top: number;
    readonly left: number;
}
/**
 * Position and drag use the same frame as the capsule's CSS: `x` = right
 * offset, `y` = bottom offset (distance from the viewport's right/bottom edge).
 * Dragging the pointer right/down therefore *decreases* the offset, so the
 * mouse delta must be subtracted from the origin.
 */
export declare function anchorPanel(capsule: CapsulePosition, viewport: Viewport, size?: PanelSize): PanelAnchor;
export declare function dragPosition(start: CapsulePosition, dx: number, dy: number, viewport: Viewport): CapsulePosition;
/** The panel's own draggable position, in CSS `left`/`top` pixels. */
export interface PanelPosition {
    readonly left: number;
    readonly top: number;
}
export declare function parsePanelPosition(value: string | null): PanelPosition | null;
/** Clamp a panel position (left/top) into the visible viewport. */
export declare function clampPanelPosition(pos: PanelPosition, viewport: Viewport, size?: PanelSize): PanelPosition;
/** Drag the panel in left/top frame: pointer right/down increases offsets. */
export declare function dragPanelPosition(start: PanelPosition, dx: number, dy: number, viewport: Viewport, size?: PanelSize): PanelPosition;
