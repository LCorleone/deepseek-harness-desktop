import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * The DAI notebook global floating capsule.
 *
 * A single collapsed pill (bottom-right) that expands into a minimalist panel
 * organized like a file browser: a folder sidebar on the left, and the note
 * list of the selected folder (or all notes) on the right, plus a notepad-style
 * Markdown editor. Pure notes, no tasks. All data flows through the host HTTP
 * routes so it is durable and shared with the chat notebook_* tools.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, } from 'react';
import { createPortal } from 'react-dom';
import { IconChevronDownOutline14, IconDownloadOutline16, IconListPenOutline16, IconPlusOutline16, IconTrashOutline16, } from '@deepseek-ai/dsh-client-ui-primitives';
import { getNotebookSnapshot, mutateNotebook, selectWorkspace, startNotebookPolling, subscribeNotebookSnapshot, } from "./notebook-api.js";
import { anchorPanel, clampPanelSize, clampPosition, dragPosition, parseCapsulePosition, parsePanelSize, PANEL_WIDTH, PANEL_MAX_HEIGHT, PANEL_MIN_WIDTH, PANEL_MIN_HEIGHT, CAPSULE_STORAGE_KEY, PANEL_SIZE_KEY, } from "./panel-geometry.js";
import css from './NotebookCapsule.module.css';
/** Folder icon (simple folder glyph). */
function FolderGlyph({ size = 14 }) {
    return (_jsx("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": true, children: _jsx("path", { d: "M2 3.5A1.5 1.5 0 0 1 3.5 2h3l1.6 2H12.5A1.5 1.5 0 0 1 14 5.5v6A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-8Z" }) }));
}
/** CRC-32 (IEEE) — table-free bitwise loop, for storing zip entries un-compressed. */
function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i] ?? 0;
        for (let k = 0; k < 8; k++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}
/** Assemble a minimal STORE-method ZIP (UTF-8 names) from name→bytes entries. */
function buildZip(entries) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (Math.floor(now.getSeconds() / 2))) & 0xffff;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
    for (const entry of entries) {
        const nameBytes = encoder.encode(entry.name);
        const crc = crc32(entry.data);
        const size = entry.data.length;
        // Local file header + name + data.
        const local = new Uint8Array(30 + nameBytes.length + size);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true); // UTF-8 flag
        lv.setUint16(8, 0, true); // method = store
        lv.setUint16(10, dosTime, true);
        lv.setUint16(12, dosDate, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, size, true);
        lv.setUint32(22, size, true);
        lv.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);
        local.set(entry.data, 30 + nameBytes.length);
        parts.push(local);
        // Central directory entry.
        const cd = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, dosTime, true);
        cv.setUint16(14, dosDate, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, size, true);
        cv.setUint32(24, size, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint32(42, offset, true);
        cd.set(nameBytes, 46);
        central.push(cd);
        offset += local.length;
    }
    const cdStart = parts.reduce((a, b) => a + b.length, 0);
    let cdSize = 0;
    for (const c of central)
        cdSize += c.length;
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    // Concatenate into one buffer so the Blob accepts a single ArrayBuffer view.
    const total = parts.reduce((a, b) => a + b.length, 0) + cdSize + eocd.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const chunk of [...parts, ...central, eocd]) {
        out.set(chunk, pos);
        pos += chunk.length;
    }
    return new Blob([out.buffer], { type: 'application/zip' });
}
/** Download the whole notebook as a ZIP: `<folder-name>/<note-title>.md` per note. */
function exportNotebook(snapshot) {
    if (snapshot === undefined)
        return;
    const encoder = new TextEncoder();
    const entries = [];
    for (const folder of snapshot.folders) {
        const folderNotes = snapshot.notes.filter((n) => n.folderId === folder.id);
        const dirName = sanitizeName(folder.name);
        if (folderNotes.length === 0) {
            entries.push({ name: `${dirName}/`, data: new Uint8Array(0) });
            continue;
        }
        for (const note of folderNotes) {
            const noteName = `${sanitizeName(note.title || '无标题')}.md`;
            const md = `# ${note.title || '（无标题）'}\n\n${note.body.trim()}\n`;
            entries.push({ name: `${dirName}/${noteName}`, data: encoder.encode(md) });
        }
    }
    const blob = buildZip(entries);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dai-notebook-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
/** Strip characters unsafe in file/folder names across common filesystems. */
function sanitizeName(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '未命名';
}
export function NotebookCapsule({ sessionsList }) {
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState(() => parseCapsulePosition(window.localStorage.getItem(CAPSULE_STORAGE_KEY)));
    // The panel can be resized (whole panel) and that size is remembered.
    const [panelSize, setPanelSize] = useState(() => parsePanelSize(window.localStorage.getItem(PANEL_SIZE_KEY)) ?? { width: PANEL_WIDTH, height: PANEL_MAX_HEIGHT });
    const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
    const sessions = useSyncExternalStore(sessionsList.subscribe, sessionsList.getSnapshot);
    const currentId = sessions.current;
    const currentCwd = currentId === undefined ? undefined : sessions.byId[currentId]?.cwd;
    const notebooks = useSyncExternalStore(subscribeNotebookSnapshot, getNotebookSnapshot).notebooks;
    const notebook = selectWorkspace(notebooks, currentCwd);
    // Lightweight polling.
    useEffect(() => {
        const stop = startNotebookPolling(1500);
        return stop;
    }, []);
    // Persist and clamp position.
    useEffect(() => {
        window.localStorage.setItem(CAPSULE_STORAGE_KEY, JSON.stringify(position));
    }, [position]);
    // Persist panel size (whole-panel stretch).
    useEffect(() => {
        window.localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(panelSize));
    }, [panelSize]);
    const onWindowResize = useCallback(() => {
        setViewport({ width: window.innerWidth, height: window.innerHeight });
    }, []);
    useEffect(() => {
        window.addEventListener('resize', onWindowResize);
        return () => window.removeEventListener('resize', onWindowResize);
    }, [onWindowResize]);
    // Collapse on session change.
    useEffect(() => { setOpen(false); }, [currentId]);
    const clamps = useMemo(() => clampPosition(position, viewport), [position, viewport]);
    const panelSizeClamped = useMemo(() => clampPanelSize(panelSize, viewport), [panelSize, viewport]);
    const anchor = useMemo(() => anchorPanel(clamps, viewport, panelSizeClamped), [clamps, viewport, panelSizeClamped]);
    const panelPosClamped = anchor;
    // Both the capsule and the panel header drag move the same capsule origin:
    // the panel always anchors to the capsule, so "胶囊在哪面板就在哪".
    const MOVE_THRESHOLD = 4;
    const dragRef = useRef(null);
    const startDrag = (event) => {
        if (event.button !== 0)
            return;
        dragRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            originX: clamps.x,
            originY: clamps.y,
            moved: false,
        };
    };
    const clampsRef = useRef(clamps);
    clampsRef.current = clamps;
    const viewportRef = useRef(viewport);
    viewportRef.current = viewport;
    useEffect(() => {
        const onMove = (event) => {
            const drag = dragRef.current;
            if (drag === null)
                return;
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            if (!drag.moved && Math.hypot(dx, dy) < MOVE_THRESHOLD)
                return;
            drag.moved = true;
            setPosition(dragPosition({ x: drag.originX, y: drag.originY }, dx, dy, viewportRef.current));
        };
        const onUp = () => {
            const drag = dragRef.current;
            dragRef.current = null;
            wasDragRef.current = drag?.moved === true;
        };
        const onCancel = () => { dragRef.current = null; };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        window.addEventListener('blur', onCancel);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onCancel);
            window.removeEventListener('blur', onCancel);
        };
    }, []);
    // Suppress the toggle click after a real drag.
    const wasDragRef = useRef(false);
    // Whole-panel resize (bottom-right handle) through the same window-level
    // pointer pattern, but writing width/height instead of position.
    const resizeRef = useRef(null);
    const panelSizeRef = useRef(panelSizeClamped);
    panelSizeRef.current = panelSizeClamped;
    const startPanelResize = (event) => {
        if (event.button !== 0)
            return;
        event.stopPropagation();
        resizeRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            originWidth: panelSizeRef.current.width,
            originHeight: panelSizeRef.current.height,
        };
    };
    useEffect(() => {
        const onResizeMove = (event) => {
            const resize = resizeRef.current;
            if (resize === null)
                return;
            const dx = event.clientX - resize.startX;
            const dy = event.clientY - resize.startY;
            setPanelSize({
                width: Math.max(PANEL_MIN_WIDTH, resize.originWidth + dx),
                height: Math.max(PANEL_MIN_HEIGHT, resize.originHeight + dy),
            });
        };
        const onResizeUp = () => {
            if (resizeRef.current !== null)
                wasDragRef.current = true;
            resizeRef.current = null;
        };
        const onResizeCancel = () => { resizeRef.current = null; };
        window.addEventListener('pointermove', onResizeMove);
        window.addEventListener('pointerup', onResizeUp);
        window.addEventListener('pointercancel', onResizeCancel);
        window.addEventListener('blur', onResizeCancel);
        return () => {
            window.removeEventListener('pointermove', onResizeMove);
            window.removeEventListener('pointerup', onResizeUp);
            window.removeEventListener('pointercancel', onResizeCancel);
            window.removeEventListener('blur', onResizeCancel);
        };
    }, []);
    // Close the panel when the user interacts with the page outside it.
    useEffect(() => {
        if (!open)
            return;
        const onPointerDown = (event) => {
            const target = event.target;
            if (target === null)
                return;
            if (target && target.closest?.('[data-dai-notebook]'))
                return;
            if (target && target.closest?.('[data-dai-capsule]'))
                return;
            // The folder right-click menu is portaled to <body>; ignore clicks on it
            // so clicking a menu item doesn't collapse the whole panel.
            if (target && target.closest?.('[data-dai-ctxmenu]'))
                return;
            setOpen(false);
        };
        const root = document;
        root.addEventListener('pointerdown', onPointerDown, true);
        return () => root.removeEventListener('pointerdown', onPointerDown, true);
    }, [open]);
    return (_jsxs(_Fragment, { children: [!open && (_jsx("button", { type: "button", className: css.capsule, "data-dai-capsule": true, style: { right: clamps.x, bottom: clamps.y }, "data-open": open || undefined, onClick: () => { if (wasDragRef.current) {
                    wasDragRef.current = false;
                    return;
                } setOpen((v) => !v); }, onPointerDown: (e) => startDrag(e), "aria-label": "DAI \u8BB0\u4E8B\u672C", title: "DAI \u8BB0\u4E8B\u672C", children: _jsx(IconListPenOutline16, {}) })), open && (_jsxs("div", { className: css.wrap, style: { width: panelSizeClamped.width, height: panelSizeClamped.height, left: panelPosClamped.left, top: panelPosClamped.top }, "data-dai-notebook": true, "aria-label": "DAI \u8BB0\u4E8B\u672C", children: [_jsxs("header", { className: css.panelHead, onPointerDown: (e) => startDrag(e), children: [_jsxs("span", { className: css.panelTitle, children: [_jsx(IconListPenOutline16, {}), _jsx("span", { children: "\u8BB0\u4E8B\u672C" }), notebook === undefined && _jsx("span", { className: css.offline, children: "\u672A\u8FDE\u63A5\u5DE5\u4F5C\u533A" })] }), _jsx("span", { className: css.panelControls, children: _jsx("button", { type: "button", className: css.iconButton, onClick: () => setOpen(false), "aria-label": "\u6536\u8D77", title: "\u6536\u8D77", children: _jsx(IconChevronDownOutline14, {}) }) })] }), _jsx(NotebookPanel, { folders: notebook?.snapshot.folders ?? [], notes: notebook?.snapshot.notes ?? [], summaries: notebook?.snapshot.summaries ?? [], sessionId: currentId, hasWorkspace: notebook !== undefined, onExport: () => exportNotebook(notebook?.snapshot) }), _jsx("div", { className: css.resizeHandle, onPointerDown: startPanelResize, "aria-hidden": "true" })] }))] }));
}
function NotebookPanel({ folders, notes, summaries, sessionId, hasWorkspace, onExport, }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [activeFolderId, setActiveFolderId] = useState(null);
    const [newFolderName, setNewFolderName] = useState('');
    const [creatingFolder, setCreatingFolder] = useState(false);
    // Show the folder sidebar while editing (toggled by the drag/click rail).
    const [editingSidebarOpen, setEditingSidebarOpen] = useState(false);
    // In browse mode the left folder sidebar also collapses once a folder is
    // chosen, so the note list takes the full clean width (toggle by rail).
    const [browseSidebarOpen, setBrowseSidebarOpen] = useState(true);
    // Resizable width of the editing folder sidebar (px), user-dragged.
    const [sidebarWidth, setSidebarWidth] = useState(150);
    // Note Markdown editor.
    const [noteEditing, setNoteEditing] = useState(null);
    // Right-click context menu on a folder: { left, top, folderId, folderName }.
    const [ctxMenu, setCtxMenu] = useState(null);
    // Second click on the delete action confirms deletion (avoid mis-clicks).
    const [confirmDelete, setConfirmDelete] = useState(false);
    const mutate = useCallback(async (op, payload) => {
        if (sessionId === undefined)
            return;
        setBusy(true);
        setError('');
        try {
            await mutateNotebook(sessionId, op, payload);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : '操作失败');
        }
        finally {
            setBusy(false);
        }
    }, [sessionId]);
    // Keep a valid folder selected: default to the first folder so the pane
    // title always shows a real folder (there is no "all notes" entry anymore).
    useEffect(() => {
        setActiveFolderId((cur) => {
            if (cur !== null && folders.some((f) => f.id === cur))
                return cur;
            return folders[0]?.id ?? null;
        });
    }, [folders]);
    // Filter notes: a selected folder shows only its notes, else all notes.
    const filteredNotes = useMemo(() => activeFolderId === null ? notes : notes.filter((n) => n.folderId === activeFolderId), [notes, activeFolderId]);
    const pinnedNotes = useMemo(() => filteredNotes.filter((n) => n.pinned), [filteredNotes]);
    const regularNotes = useMemo(() => filteredNotes.filter((n) => !n.pinned), [filteredNotes]);
    const addFolder = async (nameToUse) => {
        const name = (nameToUse ?? newFolderName).trim();
        if (name === '')
            return;
        setNewFolderName('');
        setCreatingFolder(false);
        await mutate('create_folder', { name });
    };
    const startNoteEdit = (note) => {
        if (note !== undefined) {
            setNoteEditing({ id: note.id, title: note.title, body: note.body, folderId: note.folderId });
        }
        else {
            setNoteEditing({
                id: '__new__', title: '', body: '',
                folderId: activeFolderId ?? folders[0]?.id ?? '',
            });
        }
    };
    const saveNoteEdit = async () => {
        const editing = noteEditing;
        if (editing === null)
            return;
        const title = editing.title.trim();
        if (title === '')
            return;
        if (editing.id === '__new__') {
            await mutate('create', { title, body: editing.body, folderId: editing.folderId, pinned: false });
        }
        else {
            await mutate('update', { id: editing.id, title, body: editing.body, folderId: editing.folderId });
        }
        setNoteEditing(null);
    };
    const deleteEditing = async () => {
        const editing = noteEditing;
        if (editing === null || editing.id === '__new__')
            return;
        await mutate('delete', { id: editing.id });
        setNoteEditing(null);
    };
    // Prevent the browser's native menu and show our own at the pointer position.
    const openFolderMenu = (e, folder) => {
        e.preventDefault();
        e.stopPropagation();
        setCtxMenu({ left: e.clientX, top: e.clientY, folderId: folder.id, folderName: folder.name });
        setConfirmDelete(false);
    };
    // Delete a folder from its right-click context menu. Removing a folder also
    // drops every note inside it (mirrors the host `delete_folder` op).
    const deleteFolderFromMenu = async (folderId) => {
        await mutate('delete_folder', { id: folderId });
        setCtxMenu(null);
        setConfirmDelete(false);
        if (activeFolderId === folderId)
            setActiveFolderId(null);
    };
    // Close the context menu on outside click / Escape / resize.  Use the bubble
    // phase and ignore pointerdowns that land inside the menu itself, so a click
    // on a menu item is never stolen by the close handler (which would unmount
    // the menu before the item's click fires).
    useEffect(() => {
        if (ctxMenu === null)
            return;
        const onPointerDown = (e) => {
            const target = e.target;
            if (target !== null && target.closest?.('[data-dai-ctxmenu]'))
                return;
            setCtxMenu(null);
        };
        const onKey = (e) => { if (e.key === 'Escape')
            setCtxMenu(null); };
        document.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('resize', () => setCtxMenu(null));
        window.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('resize', () => setCtxMenu(null));
            window.removeEventListener('keydown', onKey);
        };
    }, [ctxMenu !== null]); // eslint-disable-line react-hooks/exhaustive-deps
    // Drag-to-resize the editing folder sidebar (min 100 / max 280 px).
    const resizeRef = useRef(null);
    // Set when the rail was really dragged, to suppress the collapse toggle click.
    const railDraggedRef = useRef(false);
    const startResize = (event) => {
        event.preventDefault();
        resizeRef.current = { startX: event.clientX, startWidth: sidebarWidth };
        railDraggedRef.current = false;
    };
    useEffect(() => {
        const onMove = (event) => {
            const r = resizeRef.current;
            if (r === null)
                return;
            if (Math.abs(event.clientX - r.startX) > 3)
                railDraggedRef.current = true;
            const next = Math.min(280, Math.max(100, r.startWidth + (event.clientX - r.startX)));
            setSidebarWidth(next);
        };
        const onUp = () => { resizeRef.current = null; };
        const onCancel = () => { resizeRef.current = null; railDraggedRef.current = false; };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onCancel);
        };
    }, []);
    // While editing, keep a slim rail on the left that can slide the folder
    // sidebar in/out; the user can also switch the open note's folder there.
    if (noteEditing !== null) {
        return (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.editLayout, children: [_jsx("aside", { className: css.editingSidebar, "data-open": editingSidebarOpen || undefined, style: { width: editingSidebarOpen ? sidebarWidth : 0 }, children: _jsxs("div", { className: css.editingSidebarInner, children: [_jsx("div", { className: css.folderHead, children: _jsx("span", { className: css.folderHeadLabel, children: "\u6587\u4EF6\u5939" }) }), folders.map((folder) => (_jsxs("button", { type: "button", className: css.folderItem, "data-active": noteEditing.folderId === folder.id || undefined, onContextMenu: (e) => openFolderMenu(e, folder), onClick: () => {
                                            if (noteEditing.folderId !== folder.id) {
                                                setNoteEditing((cur) => cur === null ? cur : { ...cur, folderId: folder.id });
                                            }
                                        }, children: [_jsx("span", { className: css.folderIcon, children: _jsx(FolderGlyph, {}) }), _jsx("span", { className: css.folderName, title: folder.name, children: folder.name })] }, folder.id)))] }) }), _jsx("button", { type: "button", className: css.railToggle, "data-open": editingSidebarOpen || undefined, onPointerDown: startResize, onClick: () => {
                                if (railDraggedRef.current) {
                                    railDraggedRef.current = false;
                                    return;
                                }
                                setEditingSidebarOpen((v) => !v);
                            }, "aria-label": editingSidebarOpen ? '隐藏文件夹' : '显示文件夹', title: "\u62D6\u52A8\u8C03\u6574\u5BBD\u5EA6\uFF0C\u70B9\u51FB\u5C55\u5F00/\u6536\u8D77", children: _jsx(IconChevronDownOutline14, {}) }), _jsxs("div", { className: css.editorPane, children: [busy && _jsx("div", { className: css.saving, children: "\u4FDD\u5B58\u4E2D\u2026" }), error !== '' && _jsx("div", { className: css.error, children: error }), _jsx(NoteEditor, { editing: noteEditing, onChange: (patch) => setNoteEditing((cur) => cur === null ? cur : { ...cur, ...patch }), onSave: () => void saveNoteEdit(), onDelete: () => void deleteEditing() })] })] }), ctxMenu !== null && createPortal(_jsx(FolderContextMenu, { left: ctxMenu.left, top: ctxMenu.top, folderName: ctxMenu.folderName, confirm: confirmDelete, onRequestDelete: () => {
                        if (!confirmDelete) {
                            setConfirmDelete(true);
                            return;
                        }
                        void deleteFolderFromMenu(ctxMenu.folderId);
                    }, onClose: () => setCtxMenu(null) }), document.body)] }));
    }
    return (_jsxs("div", { className: css.body, children: [_jsx("aside", { className: css.folderSidebar, "data-open": browseSidebarOpen || undefined, style: { width: browseSidebarOpen ? sidebarWidth : 0 }, children: _jsxs("div", { className: css.folderSidebarInner, children: [_jsxs("div", { className: css.folderHead, children: [_jsx("span", { className: css.folderHeadLabel, children: "\u6587\u4EF6\u5939" }), _jsx("button", { type: "button", className: css.addButton, onClick: () => setCreatingFolder(true), "aria-label": "\u65B0\u5EFA\u6587\u4EF6\u5939", title: "\u65B0\u5EFA\u6587\u4EF6\u5939", children: _jsx(IconPlusOutline16, {}) })] }), creatingFolder && (_jsx("div", { className: css.folderAdd, children: _jsx("input", { autoFocus: true, value: newFolderName, onChange: (e) => setNewFolderName(e.target.value), onKeyDown: (e) => {
                                    if (e.key === 'Enter')
                                        void addFolder();
                                    if (e.key === 'Escape') {
                                        setCreatingFolder(false);
                                        setNewFolderName('');
                                    }
                                }, onBlur: () => { if (newFolderName.trim() === '')
                                    setCreatingFolder(false); }, placeholder: "\u6587\u4EF6\u5939\u540D\u2026", className: css.folderInput }) })), folders.map((folder) => (_jsxs("button", { type: "button", className: css.folderItem, "data-active": activeFolderId === folder.id || undefined, onContextMenu: (e) => openFolderMenu(e, folder), onClick: () => {
                                setActiveFolderId(folder.id);
                                setBrowseSidebarOpen(false);
                            }, children: [_jsx("span", { className: css.folderIcon, children: _jsx(FolderGlyph, {}) }), _jsx("span", { className: css.folderName, title: folder.name, children: folder.name }), _jsx("span", { className: css.folderCount, children: folder.noteCount })] }, folder.id))), _jsxs("button", { type: "button", className: css.sidebarExport, onClick: onExport, "aria-label": "\u5BFC\u51FA", title: "\u5BFC\u51FA\u5168\u90E8\u7B14\u8BB0", children: [_jsx(IconDownloadOutline16, {}), _jsx("span", { children: "\u5BFC\u51FA" })] })] }) }), _jsx("button", { type: "button", className: css.railToggle, "data-open": browseSidebarOpen || undefined, onPointerDown: startResize, onClick: () => {
                    if (railDraggedRef.current) {
                        railDraggedRef.current = false;
                        return;
                    }
                    setBrowseSidebarOpen((v) => !v);
                }, "aria-label": browseSidebarOpen ? '隐藏文件夹' : '显示文件夹', title: "\u62D6\u52A8\u8C03\u6574\u5BBD\u5EA6\uFF0C\u70B9\u51FB\u5C55\u5F00/\u6536\u8D77", children: _jsx(IconChevronDownOutline14, {}) }), _jsxs("div", { className: css.notesPane, children: [_jsxs("div", { className: css.notesToolbar, children: [_jsx("span", { className: css.paneLabel, children: activeFolderId === null ? '笔记' : (folders.find((f) => f.id === activeFolderId)?.name ?? '笔记') }), _jsx("div", { className: css.paneActions, children: _jsx("button", { type: "button", className: css.addButton, onClick: () => startNoteEdit(), disabled: folders.length === 0, "aria-label": "\u65B0\u5EFA\u7B14\u8BB0", title: "\u65B0\u5EFA\u7B14\u8BB0", children: _jsx(IconPlusOutline16, {}) }) })] }), busy && _jsx("div", { className: css.saving, children: "\u4FDD\u5B58\u4E2D\u2026" }), error !== '' && _jsx("div", { className: css.error, children: error }), _jsxs("div", { className: css.notesContent, children: [folders.length === 0 && _jsx("div", { className: css.emptyHint, children: "\u5148\u5728\u5DE6\u4FA7\u65B0\u5EFA\u4E00\u4E2A\u6587\u4EF6\u5939\u3002" }), filteredNotes.length === 0 && folders.length > 0 && _jsx("div", { className: css.emptyHint, children: "\u8FD9\u4E2A\u6587\u4EF6\u5939\u8FD8\u6CA1\u6709\u7B14\u8BB0\u3002" }), _jsx(NoteList, { notes: regularNotes, pinned: pinnedNotes, onEdit: startNoteEdit })] })] }), ctxMenu !== null && createPortal(_jsx(FolderContextMenu, { left: ctxMenu.left, top: ctxMenu.top, folderName: ctxMenu.folderName, confirm: confirmDelete, onRequestDelete: () => {
                    if (!confirmDelete) {
                        setConfirmDelete(true);
                        return;
                    }
                    void deleteFolderFromMenu(ctxMenu.folderId);
                }, onClose: () => setCtxMenu(null) }), document.body)] }));
}
function NoteList({ notes, pinned, onEdit }) {
    const all = useMemo(() => [...pinned, ...notes], [pinned, notes]);
    return (_jsx("ul", { className: css.noteList, children: all.map((note) => (_jsxs("li", { className: css.noteRow, "data-pinned": note.pinned || undefined, onClick: () => onEdit(note), title: "\u70B9\u51FB\u7F16\u8F91", children: [_jsx("div", { className: css.noteTitle, children: note.title }), note.body !== '' && _jsx("div", { className: css.noteBody, children: note.body })] }, note.id))) }));
}
function NoteEditor({ editing, onChange, onSave, onDelete }) {
    return (_jsxs("div", { className: css.noteEditorWrap, children: [_jsxs("div", { className: css.noteEditorHead, children: [_jsx("input", { autoFocus: true, value: editing.title, onChange: (e) => onChange({ title: e.target.value }), placeholder: "\u6807\u9898", className: css.noteTitleInput }), _jsxs("span", { className: css.itemActions, children: [_jsx("button", { type: "button", className: `${css.miniBtn} ${css.saveBtn}`, onClick: onSave, children: "\u4FDD\u5B58" }), editing.id !== '__new__' && (_jsx("button", { type: "button", className: `${css.miniBtn} ${css.deleteBtn}`, onClick: onDelete, "aria-label": "\u5220\u9664", title: "\u5220\u9664", children: _jsx(IconTrashOutline16, {}) }))] })] }), _jsx("textarea", { value: editing.body, onChange: (e) => onChange({ body: e.target.value }), placeholder: '在这里用 Markdown 写正文…', className: css.noteBodyEditor, spellCheck: true })] }));
}
/** Right-click context menu for a folder, rendered via a portal to <body>. */
function FolderContextMenu({ left, top, folderName, confirm, onRequestDelete, onClose }) {
    // Clamp so the menu never runs off the viewport.
    const MENU_W = 168;
    const MENU_H = 108;
    const x = Math.min(left, window.innerWidth - MENU_W - 8);
    const y = Math.min(top, window.innerHeight - MENU_H - 8);
    return (_jsxs("div", { className: css.ctxMenu, style: { left: x, top: y }, role: "menu", "data-dai-ctxmenu": true, onContextMenu: (e) => e.preventDefault(), children: [_jsx("div", { className: css.ctxMenuTitle, title: folderName, children: folderName }), _jsx("button", { type: "button", className: `${css.ctxMenuItem} ${css.ctxMenuDanger}`, role: "menuitem", onClick: (e) => {
                    e.stopPropagation();
                    onRequestDelete();
                }, children: confirm ? '确认删除？' : '删除文件夹' }), _jsx("button", { type: "button", className: css.ctxMenuClose, role: "menuitem", onClick: (e) => { e.stopPropagation(); onClose(); }, children: "\u53D6\u6D88" })] }));
}
