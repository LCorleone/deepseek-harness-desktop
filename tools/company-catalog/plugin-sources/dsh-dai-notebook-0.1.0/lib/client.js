window.__ModuleLoader__.load({
	id: "dsh-dai-notebook",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let react_dom = require("react-dom");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/client/notebook-api.js
		/**
		* Browser-side API + shared polled state for the DAI notebook capsule.
		*
		* The capsule is a global floating entry. It reads the workspace-scoped
		* notebook snapshots from the host and issues mutations through the same host,
		* so anything typed here is immediately visible to (and editable by) the
		* notebook_* tools in the chat.
		*/
		const STATE_URL = "/plugins/dsh-dai-notebook/state";
		const MUTATE_URL = "/plugins/dsh-dai-notebook/mutate";
		const listeners = /* @__PURE__ */ new Set();
		let shared = { notebooks: [] };
		function subscribeNotebookSnapshot(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
		function getNotebookSnapshot() {
			return shared;
		}
		function publish(next) {
			shared = next;
			for (const listener of listeners) listener();
		}
		/** In-flight guard so overlapping polls never reorder the snapshot. */
		let polling = false;
		async function fetchJson(url, init) {
			return fetch(url, init);
		}
		async function refreshNotebookState() {
			if (polling) return;
			polling = true;
			try {
				const response = await fetchJson(STATE_URL, {
					cache: "no-store",
					signal: AbortSignal.timeout(8e3)
				});
				if (!response.ok) return;
				const body = await response.json();
				if (!isStateResponse(body)) return;
				publish({ notebooks: body.notebooks });
			} catch {} finally {
				polling = false;
			}
		}
		/** Start a lightweight polling loop; returns a stop function. */
		function startNotebookPolling(intervalMs = 2e3) {
			let timer;
			const tick = () => {
				refreshNotebookState();
			};
			refreshNotebookState();
			timer = setInterval(tick, intervalMs);
			return () => {
				if (timer !== void 0) clearInterval(timer);
			};
		}
		/** Pick the workspace notebook for a given cwd (path), else the first. */
		function selectWorkspace(notebooks, cwd) {
			if (notebooks.length === 0) return void 0;
			if (cwd !== void 0) {
				const found = notebooks.find((n) => n.workspace === cwd);
				if (found !== void 0) return found;
			}
			return notebooks[0];
		}
		/** Issue one mutation and refresh the shared snapshot from the result. */
		async function mutateNotebook(sessionId, op, payload = {}) {
			const response = await fetch(MUTATE_URL, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sessionId,
					op,
					...payload
				}),
				cache: "no-store",
				signal: AbortSignal.timeout(8e3)
			});
			if (!response.ok) {
				let message = `mutation failed (${response.status})`;
				try {
					const body = await response.json();
					if (typeof body.error === "string") message = body.error;
				} catch {}
				throw new Error(message);
			}
			const snapshot = await response.json();
			await refreshNotebookState();
			return snapshot;
		}
		function isStateResponse(value) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
			const record = value;
			if (!Array.isArray(record.notebooks)) return false;
			return record.notebooks.every((n) => n !== null && typeof n === "object" && typeof n.workspace === "string" && typeof n.snapshot === "object");
		}
		//#endregion
		//#region lib/client/panel-geometry.js
		/**
		* Pure persisted geometry rules for the DAI notebook floating capsule.
		*
		* A single collapsed pill docked to the viewport edge, draggable to a
		* remembered position, expanding into a small attached panel. Unlike the
		* agent-teams/mobius panels (which dock beside the conversation column), the
		* capsule is intentionally lightweight and global: it floats at the bottom
		* right, near the composer, without conceding the conversation column.
		*/
		const CAPSULE_STORAGE_KEY = "dsh-dai-notebook:capsule:v1";
		const PANEL_SIZE_KEY = "dsh-dai-notebook:panel-size:v1";
		function parsePanelSize(value) {
			if (value === null) return null;
			try {
				const parsed = JSON.parse(value);
				if (typeof parsed !== "object" || parsed === null) return null;
				const record = parsed;
				if (!finite(record.width) || !finite(record.height)) return null;
				return {
					width: record.width,
					height: record.height
				};
			} catch {
				return null;
			}
		}
		/** Clamp a panel size into the visible viewport (stays near bottom-right). */
		function clampPanelSize(size, viewport) {
			const maxW = Math.max(320, viewport.width - 24);
			const maxH = Math.max(300, viewport.height - 24);
			return {
				width: Math.min(Math.max(size.width, 320), maxW),
				height: Math.min(Math.max(size.height, 300), maxH)
			};
		}
		const DEFAULT_POSITION = Object.freeze({
			x: 16,
			y: 16
		});
		function finite(value) {
			return typeof value === "number" && Number.isFinite(value);
		}
		function parseCapsulePosition(value) {
			if (value === null) return DEFAULT_POSITION;
			try {
				const parsed = JSON.parse(value);
				if (typeof parsed !== "object" || parsed === null) return DEFAULT_POSITION;
				const record = parsed;
				if (!finite(record.x) || !finite(record.y)) return DEFAULT_POSITION;
				return {
					x: record.x,
					y: record.y
				};
			} catch {
				return DEFAULT_POSITION;
			}
		}
		/** Clamp the bottom-right capsule position into the visible viewport. */
		function clampPosition(pos, viewport) {
			const maxX = Math.max(16, viewport.width - 44 - 16);
			const maxY = Math.max(16, viewport.height - 44 - 16);
			return {
				x: Math.min(Math.max(pos.x, 16), maxX),
				y: Math.min(Math.max(pos.y, 16), maxY)
			};
		}
		/**
		* Position and drag use the same frame as the capsule's CSS: `x` = right
		* offset, `y` = bottom offset (distance from the viewport's right/bottom edge).
		* Dragging the pointer right/down therefore *decreases* the offset, so the
		* mouse delta must be subtracted from the origin.
		*/
		function anchorPanel(capsule, viewport, size) {
			const width = size?.width ?? 480;
			const height = size?.height ?? 560;
			const left = Math.min(Math.max(viewport.width - capsule.x - width, 12), Math.max(12, viewport.width - width - 12));
			return {
				top: Math.max(12, viewport.height - capsule.y - 44 - 10 - height),
				left
			};
		}
		function dragPosition(start, dx, dy, viewport) {
			return clampPosition({
				x: start.x - dx,
				y: start.y - dy
			}, viewport);
		}
		//#endregion
		//#region \0dsh-css:/opt/dsh-plugins/dsh-dai-notebook/src/client/NotebookCapsule.module.css.mjs
		const css = ".tLyroq_capsule,.tLyroq_wrap{--dsw-alias-line-normal:var(--dsw-static-neutral-bluish-150,#e7e9ee);--dsw-alias-line-strong:color-mix(in srgb, var(--dsw-static-neutral-bluish-200,#e1e5ee) 50%, var(--dsw-static-neutral-bluish-300,#cfd3d6));--dsw-alias-bg-module:var(--dsw-alias-bg-layer-1,#fff);--dsw-alias-bg-fill-neutral:var(--dsw-static-neutral-bluish-100,#eef0f4);--dsw-alias-state-business-primary:var(--dsh-brand-primary,#4d6bfe);--dsw-alias-bg-fill-business:var(--dsw-alias-state-business-primary,#4d6bfe);--dsw-alias-label-primary:var(--dsw-alias-label-primary,#1f2329);--dsw-alias-label-secondary:var(--dsw-alias-label-secondary,#5f6672);--dsw-alias-label-tertiary:var(--dsw-alias-label-tertiary,#9aa3ac)}.tLyroq_capsule{box-sizing:border-box;border:1px solid color-mix(in srgb, var(--dsw-alias-line-normal) 80%, transparent);background:color-mix(in srgb, var(--dsw-alias-bg-module) 88%, transparent);backdrop-filter:blur(18px)saturate(1.1);width:44px;height:44px;box-shadow:0 6px 20px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;z-index:60;touch-action:none;border-radius:14px;justify-content:center;align-items:center;transition:background-color .15s,border-color .15s,color .15s;display:inline-flex;position:fixed}.tLyroq_capsule:hover{background:var(--dsw-alias-bg-module);border-color:var(--dsw-alias-line-strong);color:var(--dsw-alias-label-primary)}.tLyroq_capsule[data-open=true]{color:#fff;background:var(--dsw-alias-state-business-primary);border-color:#0000}.tLyroq_capsule svg{width:20px;height:20px}.tLyroq_badge{box-sizing:border-box;background:var(--dsw-alias-state-danger-primary,#e5484d);color:#fff;font-variant-numeric:tabular-nums;pointer-events:none;border-radius:999px;justify-content:center;align-items:center;min-width:17px;height:17px;padding:0 4px;font-size:10px;font-weight:700;line-height:17px;display:inline-flex;position:absolute;top:-5px;right:-5px}.tLyroq_wrap{box-sizing:border-box;border:1px solid color-mix(in srgb, var(--dsw-alias-line-normal) 90%, transparent);background:color-mix(in srgb, var(--dsw-alias-bg-module) 97%, transparent);backdrop-filter:blur(22px)saturate(1.1);box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent), 0 16px 40px color-mix(in srgb, var(--dsw-alias-label-primary) 13%, transparent);z-index:61;cursor:default;border-radius:14px;flex-direction:column;animation:.16s ease-out tLyroq_panelIn;display:flex;position:fixed;overflow:hidden}@keyframes tLyroq_panelIn{0%{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}.tLyroq_sidebarExport{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:7px;flex:none;justify-content:center;align-items:center;gap:5px;margin-top:auto;padding:5px 7px;font-size:11px;font-weight:600;line-height:15px;transition:background-color .12s,color .12s,opacity .12s;display:inline-flex}.tLyroq_sidebarExport:hover:not(:disabled){background:var(--dsw-alias-bg-fill-neutral);color:var(--dsw-alias-label-primary)}.tLyroq_sidebarExport:disabled{opacity:.4;cursor:default}.tLyroq_sidebarExport svg{width:13px;height:13px}.tLyroq_resizeHandle{z-index:4;cursor:nwse-resize;touch-action:none;background-image:linear-gradient(135deg, transparent 42%, var(--dsw-alias-line-strong) 50%, transparent 60%), linear-gradient(135deg, transparent 62%, var(--dsw-alias-line-strong) 70%, transparent 80%);opacity:.55;background-repeat:no-repeat;width:16px;height:16px;transition:opacity .12s;position:absolute;bottom:3px;right:3px}.tLyroq_resizeHandle:hover{opacity:1}.tLyroq_panelHead{border-bottom:1px solid var(--dsw-alias-line-normal);cursor:grab;user-select:none;flex:none;justify-content:space-between;align-items:center;gap:8px;min-height:44px;padding:0 8px 0 14px;display:flex}.tLyroq_panelHead:active{cursor:grabbing}.tLyroq_panelTitle{min-width:0;color:var(--dsw-alias-label-primary);align-items:center;gap:7px;font-size:13px;font-weight:700;line-height:20px;display:inline-flex}.tLyroq_panelTitle svg{width:15px;height:15px;color:var(--dsw-alias-state-business-primary);flex:none}.tLyroq_panelControls{flex:none;align-items:center;gap:2px;display:inline-flex}.tLyroq_offline{background:var(--dsw-alias-bg-fill-neutral);color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:0 6px;font-size:9px;font-weight:600;line-height:16px}.tLyroq_body{flex:1;min-height:0;display:flex}.tLyroq_folderSidebar{box-sizing:border-box;border-right:1px solid var(--dsw-alias-line-normal);background:color-mix(in srgb, var(--dsw-alias-bg-fill-neutral) 24%, transparent);flex-direction:column;flex:none;min-width:0;min-height:0;transition:width .18s;display:flex;overflow:hidden}.tLyroq_folderSidebarInner{box-sizing:border-box;overscroll-behavior:contain;scrollbar-width:thin;flex-direction:column;flex:1;min-height:0;padding:8px 6px;display:flex;overflow-y:auto}.tLyroq_folderHead{flex:none;justify-content:space-between;align-items:center;padding:2px 4px 8px;display:flex}.tLyroq_folderHeadLabel{color:var(--dsw-alias-label-tertiary);letter-spacing:.04em;font-size:10px;font-weight:700;line-height:16px}.tLyroq_folderItem{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:8px;align-items:center;gap:6px;padding:6px 7px;font-size:11.5px;line-height:16px;transition:background-color .12s,color .12s;display:flex}.tLyroq_folderItem:hover{background:color-mix(in srgb, var(--dsw-alias-bg-fill-neutral) 80%, transparent);color:var(--dsw-alias-label-primary)}.tLyroq_folderItem[data-active]{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);color:var(--dsw-alias-state-business-primary);font-weight:650}.tLyroq_folderIcon{color:currentColor;opacity:.85;flex:none;justify-content:center;align-items:center;width:15px;height:15px;display:inline-flex}.tLyroq_allNotesDot{opacity:.75;background:currentColor;border-radius:50%;width:8px;height:8px}.tLyroq_folderName{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}.tLyroq_folderCount{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;font-size:10px;line-height:16px}.tLyroq_folderAdd{align-items:center;gap:4px;padding-bottom:6px;display:flex}.tLyroq_folderInput{box-sizing:border-box;border:1px solid var(--dsw-alias-line-strong);background:color-mix(in srgb, var(--dsw-alias-bg-module) 96%, transparent);min-width:0;color:var(--dsw-alias-label-primary);font:inherit;border-radius:7px;flex:1;padding:5px 7px;font-size:10.5px;line-height:16px}.tLyroq_folderInput:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent);outline:none}.tLyroq_folderInput::placeholder{color:var(--dsw-alias-label-tertiary)}.tLyroq_notesPane{flex-direction:column;flex:1;min-width:0;min-height:0;display:flex}.tLyroq_notesToolbar{flex:none;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px 6px;display:flex}.tLyroq_paneLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:12px;font-weight:700;line-height:18px;overflow:hidden}.tLyroq_paneActions{flex:none;align-items:center;gap:4px;display:flex}.tLyroq_notesContent{overscroll-behavior:contain;scrollbar-color:color-mix(in srgb, var(--dsw-alias-label-tertiary) 28%, transparent) transparent;scrollbar-width:thin;flex:1;min-height:0;overflow-y:auto}.tLyroq_saving{color:var(--dsw-alias-label-tertiary);flex:none;padding:3px 12px;font-size:10px;line-height:16px}.tLyroq_error{background:color-mix(in srgb, var(--dsw-alias-state-danger-primary,#e5484d) 10%, transparent);color:var(--dsw-alias-state-danger-primary,#e5484d);border-radius:8px;flex:none;margin:4px 12px;padding:5px 9px;font-size:10.5px;line-height:15px}.tLyroq_iconButton{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:7px;flex:none;justify-content:center;align-items:center;padding:0;transition:background-color .12s,color .12s;display:inline-flex}.tLyroq_iconButton:hover{background:var(--dsw-alias-bg-fill-neutral);color:var(--dsw-alias-label-primary)}.tLyroq_iconButton svg{width:14px;height:14px}.tLyroq_emptyHint{color:var(--dsw-alias-label-tertiary);text-align:center;padding:18px 12px;font-size:11px;line-height:17px}.tLyroq_sectionLabel{color:var(--dsw-alias-label-tertiary);letter-spacing:.04em;margin:8px 12px 4px;font-size:10px;font-weight:700;line-height:14px}.tLyroq_listWrap{padding:4px 0 12px}.tLyroq_addNoteBtn{border:1px dashed var(--dsw-alias-line-strong);color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border-radius:9px;justify-content:center;align-items:center;gap:6px;margin:8px 12px 4px;padding:7px 10px;font-size:11px;font-weight:600;line-height:18px;transition:border-color .12s,color .12s,background-color .12s;display:flex}.tLyroq_addNoteBtn:disabled{opacity:.5;cursor:default}.tLyroq_addNoteBtn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, transparent)}.tLyroq_addNoteBtn svg{width:14px;height:14px}.tLyroq_noteList{margin:0;padding:0 12px;list-style:none}.tLyroq_noteRow{cursor:pointer;border-bottom:1px solid var(--dsw-alias-line-normal);padding:9px 2px;transition:background-color .12s}.tLyroq_noteRow:last-child{border-bottom:0}.tLyroq_noteRow:hover{background:color-mix(in srgb, var(--dsw-alias-bg-fill-neutral) 30%, transparent)}.tLyroq_noteRow[data-pinned] .tLyroq_noteTitle{color:var(--dsw-alias-state-business-primary)}.tLyroq_noteTitle{min-width:0;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600;line-height:19px;overflow:hidden}.tLyroq_noteBody{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;-webkit-line-clamp:2;-webkit-box-orient:vertical;margin-top:3px;font-size:11px;line-height:17px;display:-webkit-box;overflow:hidden}.tLyroq_itemActions{flex:none;align-items:center;gap:1px;display:flex}.tLyroq_miniBtn{width:24px;height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;justify-content:center;align-items:center;padding:0;transition:background-color .12s,color .12s;display:inline-flex}.tLyroq_miniBtn:hover{background:var(--dsw-alias-bg-fill-neutral);color:var(--dsw-alias-label-primary)}.tLyroq_miniBtn svg{width:13px;height:13px}.tLyroq_editLayout{flex:1;min-height:0;display:flex}.tLyroq_editingSidebar{box-sizing:border-box;background:color-mix(in srgb, var(--dsw-alias-bg-fill-neutral) 24%, transparent);border-right:1px solid #0000;flex-direction:column;flex:none;min-width:0;min-height:0;transition:width .18s;display:flex;overflow:hidden}.tLyroq_editingSidebar[data-open]{border-right-color:var(--dsw-alias-line-normal)}.tLyroq_editingSidebarInner{box-sizing:border-box;overscroll-behavior:contain;scrollbar-width:thin;white-space:nowrap;flex-direction:column;flex:1;min-height:0;padding:8px 6px;display:flex;overflow-y:auto}.tLyroq_railToggle{width:22px;color:var(--dsw-alias-label-tertiary);cursor:ew-resize;z-index:2;touch-action:none;opacity:0;background:0 0;border:0;flex:none;justify-content:center;align-self:stretch;align-items:center;padding:0;transition:opacity .14s,background-color .12s,color .12s;display:inline-flex}.tLyroq_railToggle:hover,.tLyroq_railToggle:focus-visible{opacity:1;background:color-mix(in srgb, var(--dsw-alias-bg-fill-neutral) 60%, transparent);color:var(--dsw-alias-label-primary)}.tLyroq_railToggle svg{pointer-events:none;width:13px;height:13px;transition:transform .18s;transform:rotate(-90deg)}.tLyroq_railToggle[data-open] svg{transform:rotate(90deg)}.tLyroq_editorPane{overscroll-behavior:contain;scrollbar-color:color-mix(in srgb, var(--dsw-alias-label-tertiary) 28%, transparent) transparent;scrollbar-width:thin;flex-direction:column;flex:1;min-width:0;min-height:0;display:flex;overflow-y:auto}.tLyroq_noteEditorWrap{box-sizing:border-box;flex-direction:column;gap:8px;padding:10px 12px 14px;display:flex}.tLyroq_noteEditorHead{justify-content:space-between;align-items:center;gap:10px;display:flex}.tLyroq_noteEditorLabel{color:var(--dsw-alias-label-tertiary);letter-spacing:.04em;font-size:10px;font-weight:700;line-height:16px}.tLyroq_noteTitleInput{box-sizing:border-box;border:0;border-bottom:1px solid var(--dsw-alias-line-normal);min-width:0;color:var(--dsw-alias-label-primary);font:inherit;background:0 0;flex:1;padding:6px 2px;font-size:16px;font-weight:650;line-height:24px;transition:border-color .12s}.tLyroq_noteTitleInput::placeholder{color:var(--dsw-alias-label-tertiary)}.tLyroq_noteTitleInput:focus{border-bottom-color:var(--dsw-alias-state-business-primary);outline:none}.tLyroq_folderSelect{box-sizing:border-box;border:1px solid var(--dsw-alias-line-strong);background:color-mix(in srgb, var(--dsw-alias-bg-module) 96%, transparent);width:100%;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;padding:6px 8px;font-size:11.5px;line-height:18px}.tLyroq_folderSelect:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}.tLyroq_noteBodyEditor{box-sizing:border-box;width:100%;min-height:200px;color:var(--dsw-alias-label-primary);font:inherit;resize:none;tab-size:4;background:0 0;border:0;padding:4px 2px;font-size:13px;line-height:22px}.tLyroq_noteBodyEditor::placeholder{color:var(--dsw-alias-label-tertiary)}.tLyroq_noteBodyEditor:focus{outline:none}.tLyroq_noteEditorHint{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}.tLyroq_saveBtn{background:var(--dsw-alias-state-business-primary);width:auto;color:var(--dsw-alias-label-on-fill,#fff);border-radius:7px;padding:0 12px;font-size:11px;font-weight:600;line-height:28px}.tLyroq_saveBtn:hover{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 88%, #fff);color:var(--dsw-alias-label-on-fill,#fff)}.tLyroq_deleteBtn{color:var(--dsw-alias-state-danger-primary,#e5484d)}.tLyroq_deleteBtn:hover{background:color-mix(in srgb, var(--dsw-alias-state-danger-primary,#e5484d) 10%, transparent);color:var(--dsw-alias-state-danger-primary,#e5484d)}@media (prefers-reduced-motion:reduce){.tLyroq_capsule,.tLyroq_wrap,.tLyroq_iconButton,.tLyroq_miniBtn,.tLyroq_addNoteBtn,.tLyroq_addButton{transition:none;animation:none}}.tLyroq_addButton{width:24px;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:6px;flex:none;justify-content:center;align-items:center;padding:0;transition:background-color .12s,color .12s,opacity .12s;display:inline-flex}.tLyroq_addButton:hover:not(:disabled){background:var(--dsw-alias-bg-fill-neutral);color:var(--dsw-alias-label-primary)}.tLyroq_addButton:disabled{opacity:.4;cursor:default}.tLyroq_addButton svg{width:13px;height:13px}.tLyroq_ctxMenu{z-index:200;box-sizing:border-box;border:1px solid color-mix(in srgb, var(--dsw-alias-line-normal) 90%, transparent);background:color-mix(in srgb, var(--dsw-alias-bg-module) 98%, transparent);backdrop-filter:blur(18px)saturate(1.1);min-width:160px;box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent), 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);border-radius:10px;padding:5px;animation:.11s ease-out tLyroq_ctxIn;position:fixed}@keyframes tLyroq_ctxIn{0%{opacity:0;transform:translateY(-2px)scale(.98)}to{opacity:1;transform:translateY(0)scale(1)}}.tLyroq_ctxMenuTitle{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;max-width:180px;padding:5px 9px 7px;font-size:10px;font-weight:700;line-height:15px;overflow:hidden}.tLyroq_ctxMenuItem{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:7px;align-items:center;padding:7px 9px;font-size:11.5px;line-height:16px;transition:background-color .11s,color .11s;display:flex}.tLyroq_ctxMenuItem:hover{background:var(--dsw-alias-bg-fill-neutral);color:var(--dsw-alias-label-primary)}.tLyroq_ctxMenuDanger{color:var(--dsw-alias-state-danger-primary,#e5484d)}.tLyroq_ctxMenuDanger:hover{background:color-mix(in srgb, var(--dsw-alias-state-danger-primary,#e5484d) 10%, transparent);color:var(--dsw-alias-state-danger-primary,#e5484d)}.tLyroq_ctxMenuClose{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:7px;align-items:center;margin-top:2px;padding:7px 9px;font-size:11.5px;line-height:16px;transition:background-color .11s,color .11s;display:flex}.tLyroq_ctxMenuClose:hover{background:var(--dsw-alias-bg-fill-neutral);color:var(--dsw-alias-label-primary)}";
		const tagId = "dsh-dai-notebook/NotebookCapsule.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-dai-notebook";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var NotebookCapsule_module_css_default = {
			"addButton": "tLyroq_addButton",
			"addNoteBtn": "tLyroq_addNoteBtn",
			"allNotesDot": "tLyroq_allNotesDot",
			"badge": "tLyroq_badge",
			"body": "tLyroq_body",
			"capsule": "tLyroq_capsule",
			"ctxIn": "tLyroq_ctxIn",
			"ctxMenu": "tLyroq_ctxMenu",
			"ctxMenuClose": "tLyroq_ctxMenuClose",
			"ctxMenuDanger": "tLyroq_ctxMenuDanger",
			"ctxMenuItem": "tLyroq_ctxMenuItem",
			"ctxMenuTitle": "tLyroq_ctxMenuTitle",
			"deleteBtn": "tLyroq_deleteBtn",
			"editLayout": "tLyroq_editLayout",
			"editingSidebar": "tLyroq_editingSidebar",
			"editingSidebarInner": "tLyroq_editingSidebarInner",
			"editorPane": "tLyroq_editorPane",
			"emptyHint": "tLyroq_emptyHint",
			"error": "tLyroq_error",
			"folderAdd": "tLyroq_folderAdd",
			"folderCount": "tLyroq_folderCount",
			"folderHead": "tLyroq_folderHead",
			"folderHeadLabel": "tLyroq_folderHeadLabel",
			"folderIcon": "tLyroq_folderIcon",
			"folderInput": "tLyroq_folderInput",
			"folderItem": "tLyroq_folderItem",
			"folderName": "tLyroq_folderName",
			"folderSelect": "tLyroq_folderSelect",
			"folderSidebar": "tLyroq_folderSidebar",
			"folderSidebarInner": "tLyroq_folderSidebarInner",
			"iconButton": "tLyroq_iconButton",
			"itemActions": "tLyroq_itemActions",
			"listWrap": "tLyroq_listWrap",
			"miniBtn": "tLyroq_miniBtn",
			"noteBody": "tLyroq_noteBody",
			"noteBodyEditor": "tLyroq_noteBodyEditor",
			"noteEditorHead": "tLyroq_noteEditorHead",
			"noteEditorHint": "tLyroq_noteEditorHint",
			"noteEditorLabel": "tLyroq_noteEditorLabel",
			"noteEditorWrap": "tLyroq_noteEditorWrap",
			"noteList": "tLyroq_noteList",
			"noteRow": "tLyroq_noteRow",
			"noteTitle": "tLyroq_noteTitle",
			"noteTitleInput": "tLyroq_noteTitleInput",
			"notesContent": "tLyroq_notesContent",
			"notesPane": "tLyroq_notesPane",
			"notesToolbar": "tLyroq_notesToolbar",
			"offline": "tLyroq_offline",
			"paneActions": "tLyroq_paneActions",
			"paneLabel": "tLyroq_paneLabel",
			"panelControls": "tLyroq_panelControls",
			"panelHead": "tLyroq_panelHead",
			"panelIn": "tLyroq_panelIn",
			"panelTitle": "tLyroq_panelTitle",
			"railToggle": "tLyroq_railToggle",
			"resizeHandle": "tLyroq_resizeHandle",
			"saveBtn": "tLyroq_saveBtn",
			"saving": "tLyroq_saving",
			"sectionLabel": "tLyroq_sectionLabel",
			"sidebarExport": "tLyroq_sidebarExport",
			"wrap": "tLyroq_wrap"
		};
		//#endregion
		//#region lib/client/NotebookCapsule.js
		/**
		* The DAI notebook global floating capsule.
		*
		* A single collapsed pill (bottom-right) that expands into a minimalist panel
		* organized like a file browser: a folder sidebar on the left, and the note
		* list of the selected folder (or all notes) on the right, plus a notepad-style
		* Markdown editor. Pure notes, no tasks. All data flows through the host HTTP
		* routes so it is durable and shared with the chat notebook_* tools.
		*/
		/** Folder icon (simple folder glyph). */
		function FolderGlyph({ size = 14 }) {
			return (0, react_jsx_runtime.jsx)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "currentColor",
				"aria-hidden": true,
				children: (0, react_jsx_runtime.jsx)("path", { d: "M2 3.5A1.5 1.5 0 0 1 3.5 2h3l1.6 2H12.5A1.5 1.5 0 0 1 14 5.5v6A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-8Z" })
			});
		}
		/** CRC-32 (IEEE) — table-free bitwise loop, for storing zip entries un-compressed. */
		function crc32(data) {
			let crc = 4294967295;
			for (let i = 0; i < data.length; i++) {
				crc ^= data[i] ?? 0;
				for (let k = 0; k < 8; k++) crc = crc >>> 1 ^ 3988292384 & -(crc & 1);
			}
			return (crc ^ 4294967295) >>> 0;
		}
		/** Assemble a minimal STORE-method ZIP (UTF-8 names) from name→bytes entries. */
		function buildZip(entries) {
			const encoder = new TextEncoder();
			const parts = [];
			const central = [];
			let offset = 0;
			const now = /* @__PURE__ */ new Date();
			const dosTime = (now.getHours() << 11 | now.getMinutes() << 5 | Math.floor(now.getSeconds() / 2)) & 65535;
			const dosDate = (now.getFullYear() - 1980 << 9 | now.getMonth() + 1 << 5 | now.getDate()) & 65535;
			for (const entry of entries) {
				const nameBytes = encoder.encode(entry.name);
				const crc = crc32(entry.data);
				const size = entry.data.length;
				const local = new Uint8Array(30 + nameBytes.length + size);
				const lv = new DataView(local.buffer);
				lv.setUint32(0, 67324752, true);
				lv.setUint16(4, 20, true);
				lv.setUint16(6, 2048, true);
				lv.setUint16(8, 0, true);
				lv.setUint16(10, dosTime, true);
				lv.setUint16(12, dosDate, true);
				lv.setUint32(14, crc, true);
				lv.setUint32(18, size, true);
				lv.setUint32(22, size, true);
				lv.setUint16(26, nameBytes.length, true);
				local.set(nameBytes, 30);
				local.set(entry.data, 30 + nameBytes.length);
				parts.push(local);
				const cd = new Uint8Array(46 + nameBytes.length);
				const cv = new DataView(cd.buffer);
				cv.setUint32(0, 33639248, true);
				cv.setUint16(4, 20, true);
				cv.setUint16(6, 20, true);
				cv.setUint16(8, 2048, true);
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
			for (const c of central) cdSize += c.length;
			const eocd = /* @__PURE__ */ new Uint8Array(22);
			const ev = new DataView(eocd.buffer);
			ev.setUint32(0, 101010256, true);
			ev.setUint16(8, entries.length, true);
			ev.setUint16(10, entries.length, true);
			ev.setUint32(12, cdSize, true);
			ev.setUint32(16, cdStart, true);
			const total = parts.reduce((a, b) => a + b.length, 0) + cdSize + eocd.length;
			const out = new Uint8Array(total);
			let pos = 0;
			for (const chunk of [
				...parts,
				...central,
				eocd
			]) {
				out.set(chunk, pos);
				pos += chunk.length;
			}
			return new Blob([out.buffer], { type: "application/zip" });
		}
		/** Download the whole notebook as a ZIP: `<folder-name>/<note-title>.md` per note. */
		function exportNotebook(snapshot) {
			if (snapshot === void 0) return;
			const encoder = new TextEncoder();
			const entries = [];
			for (const folder of snapshot.folders) {
				const folderNotes = snapshot.notes.filter((n) => n.folderId === folder.id);
				const dirName = sanitizeName(folder.name);
				if (folderNotes.length === 0) {
					entries.push({
						name: `${dirName}/`,
						data: /* @__PURE__ */ new Uint8Array(0)
					});
					continue;
				}
				for (const note of folderNotes) {
					const noteName = `${sanitizeName(note.title || "无标题")}.md`;
					const md = `# ${note.title || "（无标题）"}\n\n${note.body.trim()}\n`;
					entries.push({
						name: `${dirName}/${noteName}`,
						data: encoder.encode(md)
					});
				}
			}
			const blob = buildZip(entries);
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `dai-notebook-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.zip`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		}
		/** Strip characters unsafe in file/folder names across common filesystems. */
		function sanitizeName(name) {
			return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "未命名";
		}
		function NotebookCapsule({ sessionsList }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [position, setPosition] = (0, react.useState)(() => parseCapsulePosition(window.localStorage.getItem(CAPSULE_STORAGE_KEY)));
			const [panelSize, setPanelSize] = (0, react.useState)(() => parsePanelSize(window.localStorage.getItem("dsh-dai-notebook:panel-size:v1")) ?? {
				width: 480,
				height: 560
			});
			const [viewport, setViewport] = (0, react.useState)({
				width: window.innerWidth,
				height: window.innerHeight
			});
			const sessions = (0, react.useSyncExternalStore)(sessionsList.subscribe, sessionsList.getSnapshot);
			const currentId = sessions.current;
			const currentCwd = currentId === void 0 ? void 0 : sessions.byId[currentId]?.cwd;
			const notebooks = (0, react.useSyncExternalStore)(subscribeNotebookSnapshot, getNotebookSnapshot).notebooks;
			const notebook = selectWorkspace(notebooks, currentCwd);
			(0, react.useEffect)(() => {
				return startNotebookPolling(1500);
			}, []);
			(0, react.useEffect)(() => {
				window.localStorage.setItem(CAPSULE_STORAGE_KEY, JSON.stringify(position));
			}, [position]);
			(0, react.useEffect)(() => {
				window.localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(panelSize));
			}, [panelSize]);
			const onWindowResize = (0, react.useCallback)(() => {
				setViewport({
					width: window.innerWidth,
					height: window.innerHeight
				});
			}, []);
			(0, react.useEffect)(() => {
				window.addEventListener("resize", onWindowResize);
				return () => window.removeEventListener("resize", onWindowResize);
			}, [onWindowResize]);
			(0, react.useEffect)(() => {
				setOpen(false);
			}, [currentId]);
			const clamps = (0, react.useMemo)(() => clampPosition(position, viewport), [position, viewport]);
			const panelSizeClamped = (0, react.useMemo)(() => clampPanelSize(panelSize, viewport), [panelSize, viewport]);
			const panelPosClamped = (0, react.useMemo)(() => anchorPanel(clamps, viewport, panelSizeClamped), [
				clamps,
				viewport,
				panelSizeClamped
			]);
			const MOVE_THRESHOLD = 4;
			const dragRef = (0, react.useRef)(null);
			const startDrag = (event) => {
				if (event.button !== 0) return;
				dragRef.current = {
					startX: event.clientX,
					startY: event.clientY,
					originX: clamps.x,
					originY: clamps.y,
					moved: false
				};
			};
			const clampsRef = (0, react.useRef)(clamps);
			clampsRef.current = clamps;
			const viewportRef = (0, react.useRef)(viewport);
			viewportRef.current = viewport;
			(0, react.useEffect)(() => {
				const onMove = (event) => {
					const drag = dragRef.current;
					if (drag === null) return;
					const dx = event.clientX - drag.startX;
					const dy = event.clientY - drag.startY;
					if (!drag.moved && Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
					drag.moved = true;
					setPosition(dragPosition({
						x: drag.originX,
						y: drag.originY
					}, dx, dy, viewportRef.current));
				};
				const onUp = () => {
					const drag = dragRef.current;
					dragRef.current = null;
					wasDragRef.current = drag?.moved === true;
				};
				const onCancel = () => {
					dragRef.current = null;
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
				window.addEventListener("pointercancel", onCancel);
				window.addEventListener("blur", onCancel);
				return () => {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
					window.removeEventListener("pointercancel", onCancel);
					window.removeEventListener("blur", onCancel);
				};
			}, []);
			const wasDragRef = (0, react.useRef)(false);
			const resizeRef = (0, react.useRef)(null);
			const panelSizeRef = (0, react.useRef)(panelSizeClamped);
			panelSizeRef.current = panelSizeClamped;
			const startPanelResize = (event) => {
				if (event.button !== 0) return;
				event.stopPropagation();
				resizeRef.current = {
					startX: event.clientX,
					startY: event.clientY,
					originWidth: panelSizeRef.current.width,
					originHeight: panelSizeRef.current.height
				};
			};
			(0, react.useEffect)(() => {
				const onResizeMove = (event) => {
					const resize = resizeRef.current;
					if (resize === null) return;
					const dx = event.clientX - resize.startX;
					const dy = event.clientY - resize.startY;
					setPanelSize({
						width: Math.max(320, resize.originWidth + dx),
						height: Math.max(300, resize.originHeight + dy)
					});
				};
				const onResizeUp = () => {
					if (resizeRef.current !== null) wasDragRef.current = true;
					resizeRef.current = null;
				};
				const onResizeCancel = () => {
					resizeRef.current = null;
				};
				window.addEventListener("pointermove", onResizeMove);
				window.addEventListener("pointerup", onResizeUp);
				window.addEventListener("pointercancel", onResizeCancel);
				window.addEventListener("blur", onResizeCancel);
				return () => {
					window.removeEventListener("pointermove", onResizeMove);
					window.removeEventListener("pointerup", onResizeUp);
					window.removeEventListener("pointercancel", onResizeCancel);
					window.removeEventListener("blur", onResizeCancel);
				};
			}, []);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					const target = event.target;
					if (target === null) return;
					if (target && target.closest?.("[data-dai-notebook]")) return;
					if (target && target.closest?.("[data-dai-capsule]")) return;
					if (target && target.closest?.("[data-dai-ctxmenu]")) return;
					setOpen(false);
				};
				const root = document;
				root.addEventListener("pointerdown", onPointerDown, true);
				return () => root.removeEventListener("pointerdown", onPointerDown, true);
			}, [open]);
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [!open && (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: NotebookCapsule_module_css_default.capsule,
				"data-dai-capsule": true,
				style: {
					right: clamps.x,
					bottom: clamps.y
				},
				"data-open": open || void 0,
				onClick: () => {
					if (wasDragRef.current) {
						wasDragRef.current = false;
						return;
					}
					setOpen((v) => !v);
				},
				onPointerDown: (e) => startDrag(e),
				"aria-label": "DAI 记事本",
				title: "DAI 记事本",
				children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconListPenOutline16, {})
			}), open && (0, react_jsx_runtime.jsxs)("div", {
				className: NotebookCapsule_module_css_default.wrap,
				style: {
					width: panelSizeClamped.width,
					height: panelSizeClamped.height,
					left: panelPosClamped.left,
					top: panelPosClamped.top
				},
				"data-dai-notebook": true,
				"aria-label": "DAI 记事本",
				children: [
					(0, react_jsx_runtime.jsxs)("header", {
						className: NotebookCapsule_module_css_default.panelHead,
						onPointerDown: (e) => startDrag(e),
						children: [(0, react_jsx_runtime.jsxs)("span", {
							className: NotebookCapsule_module_css_default.panelTitle,
							children: [
								(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconListPenOutline16, {}),
								(0, react_jsx_runtime.jsx)("span", { children: "记事本" }),
								notebook === void 0 && (0, react_jsx_runtime.jsx)("span", {
									className: NotebookCapsule_module_css_default.offline,
									children: "未连接工作区"
								})
							]
						}), (0, react_jsx_runtime.jsx)("span", {
							className: NotebookCapsule_module_css_default.panelControls,
							children: (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: NotebookCapsule_module_css_default.iconButton,
								onClick: () => setOpen(false),
								"aria-label": "收起",
								title: "收起",
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
							})
						})]
					}),
					(0, react_jsx_runtime.jsx)(NotebookPanel, {
						folders: notebook?.snapshot.folders ?? [],
						notes: notebook?.snapshot.notes ?? [],
						summaries: notebook?.snapshot.summaries ?? [],
						sessionId: currentId,
						hasWorkspace: notebook !== void 0,
						onExport: () => exportNotebook(notebook?.snapshot)
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: NotebookCapsule_module_css_default.resizeHandle,
						onPointerDown: startPanelResize,
						"aria-hidden": "true"
					})
				]
			})] });
		}
		function NotebookPanel({ folders, notes, summaries, sessionId, hasWorkspace, onExport }) {
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)("");
			const [activeFolderId, setActiveFolderId] = (0, react.useState)(null);
			const [newFolderName, setNewFolderName] = (0, react.useState)("");
			const [creatingFolder, setCreatingFolder] = (0, react.useState)(false);
			const [editingSidebarOpen, setEditingSidebarOpen] = (0, react.useState)(false);
			const [browseSidebarOpen, setBrowseSidebarOpen] = (0, react.useState)(true);
			const [sidebarWidth, setSidebarWidth] = (0, react.useState)(150);
			const [noteEditing, setNoteEditing] = (0, react.useState)(null);
			const [ctxMenu, setCtxMenu] = (0, react.useState)(null);
			const [confirmDelete, setConfirmDelete] = (0, react.useState)(false);
			const mutate = (0, react.useCallback)(async (op, payload) => {
				if (sessionId === void 0) return;
				setBusy(true);
				setError("");
				try {
					await mutateNotebook(sessionId, op, payload);
				} catch (e) {
					setError(e instanceof Error ? e.message : "操作失败");
				} finally {
					setBusy(false);
				}
			}, [sessionId]);
			(0, react.useEffect)(() => {
				setActiveFolderId((cur) => {
					if (cur !== null && folders.some((f) => f.id === cur)) return cur;
					return folders[0]?.id ?? null;
				});
			}, [folders]);
			const filteredNotes = (0, react.useMemo)(() => activeFolderId === null ? notes : notes.filter((n) => n.folderId === activeFolderId), [notes, activeFolderId]);
			const pinnedNotes = (0, react.useMemo)(() => filteredNotes.filter((n) => n.pinned), [filteredNotes]);
			const regularNotes = (0, react.useMemo)(() => filteredNotes.filter((n) => !n.pinned), [filteredNotes]);
			const addFolder = async (nameToUse) => {
				const name = (nameToUse ?? newFolderName).trim();
				if (name === "") return;
				setNewFolderName("");
				setCreatingFolder(false);
				await mutate("create_folder", { name });
			};
			const startNoteEdit = (note) => {
				if (note !== void 0) setNoteEditing({
					id: note.id,
					title: note.title,
					body: note.body,
					folderId: note.folderId
				});
				else setNoteEditing({
					id: "__new__",
					title: "",
					body: "",
					folderId: activeFolderId ?? folders[0]?.id ?? ""
				});
			};
			const saveNoteEdit = async () => {
				const editing = noteEditing;
				if (editing === null) return;
				const title = editing.title.trim();
				if (title === "") return;
				if (editing.id === "__new__") await mutate("create", {
					title,
					body: editing.body,
					folderId: editing.folderId,
					pinned: false
				});
				else await mutate("update", {
					id: editing.id,
					title,
					body: editing.body,
					folderId: editing.folderId
				});
				setNoteEditing(null);
			};
			const deleteEditing = async () => {
				const editing = noteEditing;
				if (editing === null || editing.id === "__new__") return;
				await mutate("delete", { id: editing.id });
				setNoteEditing(null);
			};
			const openFolderMenu = (e, folder) => {
				e.preventDefault();
				e.stopPropagation();
				setCtxMenu({
					left: e.clientX,
					top: e.clientY,
					folderId: folder.id,
					folderName: folder.name
				});
				setConfirmDelete(false);
			};
			const deleteFolderFromMenu = async (folderId) => {
				await mutate("delete_folder", { id: folderId });
				setCtxMenu(null);
				setConfirmDelete(false);
				if (activeFolderId === folderId) setActiveFolderId(null);
			};
			(0, react.useEffect)(() => {
				if (ctxMenu === null) return;
				const onPointerDown = (e) => {
					const target = e.target;
					if (target !== null && target.closest?.("[data-dai-ctxmenu]")) return;
					setCtxMenu(null);
				};
				const onKey = (e) => {
					if (e.key === "Escape") setCtxMenu(null);
				};
				document.addEventListener("pointerdown", onPointerDown);
				window.addEventListener("resize", () => setCtxMenu(null));
				window.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown);
					window.removeEventListener("resize", () => setCtxMenu(null));
					window.removeEventListener("keydown", onKey);
				};
			}, [ctxMenu !== null]);
			const resizeRef = (0, react.useRef)(null);
			const railDraggedRef = (0, react.useRef)(false);
			const startResize = (event) => {
				event.preventDefault();
				resizeRef.current = {
					startX: event.clientX,
					startWidth: sidebarWidth
				};
				railDraggedRef.current = false;
			};
			(0, react.useEffect)(() => {
				const onMove = (event) => {
					const r = resizeRef.current;
					if (r === null) return;
					if (Math.abs(event.clientX - r.startX) > 3) railDraggedRef.current = true;
					const next = Math.min(280, Math.max(100, r.startWidth + (event.clientX - r.startX)));
					setSidebarWidth(next);
				};
				const onUp = () => {
					resizeRef.current = null;
				};
				const onCancel = () => {
					resizeRef.current = null;
					railDraggedRef.current = false;
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
				window.addEventListener("pointercancel", onCancel);
				return () => {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
					window.removeEventListener("pointercancel", onCancel);
				};
			}, []);
			if (noteEditing !== null) return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("div", {
				className: NotebookCapsule_module_css_default.editLayout,
				children: [
					(0, react_jsx_runtime.jsx)("aside", {
						className: NotebookCapsule_module_css_default.editingSidebar,
						"data-open": editingSidebarOpen || void 0,
						style: { width: editingSidebarOpen ? sidebarWidth : 0 },
						children: (0, react_jsx_runtime.jsxs)("div", {
							className: NotebookCapsule_module_css_default.editingSidebarInner,
							children: [(0, react_jsx_runtime.jsx)("div", {
								className: NotebookCapsule_module_css_default.folderHead,
								children: (0, react_jsx_runtime.jsx)("span", {
									className: NotebookCapsule_module_css_default.folderHeadLabel,
									children: "文件夹"
								})
							}), folders.map((folder) => (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: NotebookCapsule_module_css_default.folderItem,
								"data-active": noteEditing.folderId === folder.id || void 0,
								onContextMenu: (e) => openFolderMenu(e, folder),
								onClick: () => {
									if (noteEditing.folderId !== folder.id) setNoteEditing((cur) => cur === null ? cur : {
										...cur,
										folderId: folder.id
									});
								},
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: NotebookCapsule_module_css_default.folderIcon,
									children: (0, react_jsx_runtime.jsx)(FolderGlyph, {})
								}), (0, react_jsx_runtime.jsx)("span", {
									className: NotebookCapsule_module_css_default.folderName,
									title: folder.name,
									children: folder.name
								})]
							}, folder.id))]
						})
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: NotebookCapsule_module_css_default.railToggle,
						"data-open": editingSidebarOpen || void 0,
						onPointerDown: startResize,
						onClick: () => {
							if (railDraggedRef.current) {
								railDraggedRef.current = false;
								return;
							}
							setEditingSidebarOpen((v) => !v);
						},
						"aria-label": editingSidebarOpen ? "隐藏文件夹" : "显示文件夹",
						title: "拖动调整宽度，点击展开/收起",
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: NotebookCapsule_module_css_default.editorPane,
						children: [
							busy && (0, react_jsx_runtime.jsx)("div", {
								className: NotebookCapsule_module_css_default.saving,
								children: "保存中…"
							}),
							error !== "" && (0, react_jsx_runtime.jsx)("div", {
								className: NotebookCapsule_module_css_default.error,
								children: error
							}),
							(0, react_jsx_runtime.jsx)(NoteEditor, {
								editing: noteEditing,
								onChange: (patch) => setNoteEditing((cur) => cur === null ? cur : {
									...cur,
									...patch
								}),
								onSave: () => void saveNoteEdit(),
								onDelete: () => void deleteEditing()
							})
						]
					})
				]
			}), ctxMenu !== null && (0, react_dom.createPortal)((0, react_jsx_runtime.jsx)(FolderContextMenu, {
				left: ctxMenu.left,
				top: ctxMenu.top,
				folderName: ctxMenu.folderName,
				confirm: confirmDelete,
				onRequestDelete: () => {
					if (!confirmDelete) {
						setConfirmDelete(true);
						return;
					}
					deleteFolderFromMenu(ctxMenu.folderId);
				},
				onClose: () => setCtxMenu(null)
			}), document.body)] });
			return (0, react_jsx_runtime.jsxs)("div", {
				className: NotebookCapsule_module_css_default.body,
				children: [
					(0, react_jsx_runtime.jsx)("aside", {
						className: NotebookCapsule_module_css_default.folderSidebar,
						"data-open": browseSidebarOpen || void 0,
						style: { width: browseSidebarOpen ? sidebarWidth : 0 },
						children: (0, react_jsx_runtime.jsxs)("div", {
							className: NotebookCapsule_module_css_default.folderSidebarInner,
							children: [
								(0, react_jsx_runtime.jsxs)("div", {
									className: NotebookCapsule_module_css_default.folderHead,
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: NotebookCapsule_module_css_default.folderHeadLabel,
										children: "文件夹"
									}), (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: NotebookCapsule_module_css_default.addButton,
										onClick: () => setCreatingFolder(true),
										"aria-label": "新建文件夹",
										title: "新建文件夹",
										children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, {})
									})]
								}),
								creatingFolder && (0, react_jsx_runtime.jsx)("div", {
									className: NotebookCapsule_module_css_default.folderAdd,
									children: (0, react_jsx_runtime.jsx)("input", {
										autoFocus: true,
										value: newFolderName,
										onChange: (e) => setNewFolderName(e.target.value),
										onKeyDown: (e) => {
											if (e.key === "Enter") addFolder();
											if (e.key === "Escape") {
												setCreatingFolder(false);
												setNewFolderName("");
											}
										},
										onBlur: () => {
											if (newFolderName.trim() === "") setCreatingFolder(false);
										},
										placeholder: "文件夹名…",
										className: NotebookCapsule_module_css_default.folderInput
									})
								}),
								folders.map((folder) => (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: NotebookCapsule_module_css_default.folderItem,
									"data-active": activeFolderId === folder.id || void 0,
									onContextMenu: (e) => openFolderMenu(e, folder),
									onClick: () => {
										setActiveFolderId(folder.id);
										setBrowseSidebarOpen(false);
									},
									children: [
										(0, react_jsx_runtime.jsx)("span", {
											className: NotebookCapsule_module_css_default.folderIcon,
											children: (0, react_jsx_runtime.jsx)(FolderGlyph, {})
										}),
										(0, react_jsx_runtime.jsx)("span", {
											className: NotebookCapsule_module_css_default.folderName,
											title: folder.name,
											children: folder.name
										}),
										(0, react_jsx_runtime.jsx)("span", {
											className: NotebookCapsule_module_css_default.folderCount,
											children: folder.noteCount
										})
									]
								}, folder.id)),
								(0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: NotebookCapsule_module_css_default.sidebarExport,
									onClick: onExport,
									"aria-label": "导出",
									title: "导出全部笔记",
									children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, {}), (0, react_jsx_runtime.jsx)("span", { children: "导出" })]
								})
							]
						})
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: NotebookCapsule_module_css_default.railToggle,
						"data-open": browseSidebarOpen || void 0,
						onPointerDown: startResize,
						onClick: () => {
							if (railDraggedRef.current) {
								railDraggedRef.current = false;
								return;
							}
							setBrowseSidebarOpen((v) => !v);
						},
						"aria-label": browseSidebarOpen ? "隐藏文件夹" : "显示文件夹",
						title: "拖动调整宽度，点击展开/收起",
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: NotebookCapsule_module_css_default.notesPane,
						children: [
							(0, react_jsx_runtime.jsxs)("div", {
								className: NotebookCapsule_module_css_default.notesToolbar,
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: NotebookCapsule_module_css_default.paneLabel,
									children: activeFolderId === null ? "笔记" : folders.find((f) => f.id === activeFolderId)?.name ?? "笔记"
								}), (0, react_jsx_runtime.jsx)("div", {
									className: NotebookCapsule_module_css_default.paneActions,
									children: (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: NotebookCapsule_module_css_default.addButton,
										onClick: () => startNoteEdit(),
										disabled: folders.length === 0,
										"aria-label": "新建笔记",
										title: "新建笔记",
										children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, {})
									})
								})]
							}),
							busy && (0, react_jsx_runtime.jsx)("div", {
								className: NotebookCapsule_module_css_default.saving,
								children: "保存中…"
							}),
							error !== "" && (0, react_jsx_runtime.jsx)("div", {
								className: NotebookCapsule_module_css_default.error,
								children: error
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: NotebookCapsule_module_css_default.notesContent,
								children: [
									folders.length === 0 && (0, react_jsx_runtime.jsx)("div", {
										className: NotebookCapsule_module_css_default.emptyHint,
										children: "先在左侧新建一个文件夹。"
									}),
									filteredNotes.length === 0 && folders.length > 0 && (0, react_jsx_runtime.jsx)("div", {
										className: NotebookCapsule_module_css_default.emptyHint,
										children: "这个文件夹还没有笔记。"
									}),
									(0, react_jsx_runtime.jsx)(NoteList, {
										notes: regularNotes,
										pinned: pinnedNotes,
										onEdit: startNoteEdit
									})
								]
							})
						]
					}),
					ctxMenu !== null && (0, react_dom.createPortal)((0, react_jsx_runtime.jsx)(FolderContextMenu, {
						left: ctxMenu.left,
						top: ctxMenu.top,
						folderName: ctxMenu.folderName,
						confirm: confirmDelete,
						onRequestDelete: () => {
							if (!confirmDelete) {
								setConfirmDelete(true);
								return;
							}
							deleteFolderFromMenu(ctxMenu.folderId);
						},
						onClose: () => setCtxMenu(null)
					}), document.body)
				]
			});
		}
		function NoteList({ notes, pinned, onEdit }) {
			const all = (0, react.useMemo)(() => [...pinned, ...notes], [pinned, notes]);
			return (0, react_jsx_runtime.jsx)("ul", {
				className: NotebookCapsule_module_css_default.noteList,
				children: all.map((note) => (0, react_jsx_runtime.jsxs)("li", {
					className: NotebookCapsule_module_css_default.noteRow,
					"data-pinned": note.pinned || void 0,
					onClick: () => onEdit(note),
					title: "点击编辑",
					children: [(0, react_jsx_runtime.jsx)("div", {
						className: NotebookCapsule_module_css_default.noteTitle,
						children: note.title
					}), note.body !== "" && (0, react_jsx_runtime.jsx)("div", {
						className: NotebookCapsule_module_css_default.noteBody,
						children: note.body
					})]
				}, note.id))
			});
		}
		function NoteEditor({ editing, onChange, onSave, onDelete }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: NotebookCapsule_module_css_default.noteEditorWrap,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: NotebookCapsule_module_css_default.noteEditorHead,
					children: [(0, react_jsx_runtime.jsx)("input", {
						autoFocus: true,
						value: editing.title,
						onChange: (e) => onChange({ title: e.target.value }),
						placeholder: "标题",
						className: NotebookCapsule_module_css_default.noteTitleInput
					}), (0, react_jsx_runtime.jsxs)("span", {
						className: NotebookCapsule_module_css_default.itemActions,
						children: [(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: `${NotebookCapsule_module_css_default.miniBtn} ${NotebookCapsule_module_css_default.saveBtn}`,
							onClick: onSave,
							children: "保存"
						}), editing.id !== "__new__" && (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: `${NotebookCapsule_module_css_default.miniBtn} ${NotebookCapsule_module_css_default.deleteBtn}`,
							onClick: onDelete,
							"aria-label": "删除",
							title: "删除",
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {})
						})]
					})]
				}), (0, react_jsx_runtime.jsx)("textarea", {
					value: editing.body,
					onChange: (e) => onChange({ body: e.target.value }),
					placeholder: "在这里用 Markdown 写正文…",
					className: NotebookCapsule_module_css_default.noteBodyEditor,
					spellCheck: true
				})]
			});
		}
		/** Right-click context menu for a folder, rendered via a portal to <body>. */
		function FolderContextMenu({ left, top, folderName, confirm, onRequestDelete, onClose }) {
			const MENU_W = 168;
			const MENU_H = 108;
			const x = Math.min(left, window.innerWidth - MENU_W - 8);
			const y = Math.min(top, window.innerHeight - MENU_H - 8);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: NotebookCapsule_module_css_default.ctxMenu,
				style: {
					left: x,
					top: y
				},
				role: "menu",
				"data-dai-ctxmenu": true,
				onContextMenu: (e) => e.preventDefault(),
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						className: NotebookCapsule_module_css_default.ctxMenuTitle,
						title: folderName,
						children: folderName
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: `${NotebookCapsule_module_css_default.ctxMenuItem} ${NotebookCapsule_module_css_default.ctxMenuDanger}`,
						role: "menuitem",
						onClick: (e) => {
							e.stopPropagation();
							onRequestDelete();
						},
						children: confirm ? "确认删除？" : "删除文件夹"
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: NotebookCapsule_module_css_default.ctxMenuClose,
						role: "menuitem",
						onClick: (e) => {
							e.stopPropagation();
							onClose();
						},
						children: "取消"
					})
				]
			});
		}
		//#endregion
		//#region lib/client/index.js
		/** Required services: slots and sessions. */
		const inject = ["slots", "sessions"];
		/**
		* Register the notebook capsule in the shell's additive overlay. It is a
		* single always-available floating entry, visually distinct from any
		* collocated agent-teams / mobius panels.
		*/
		function apply(ctx) {
			const NotebookCapsuleView = () => (0, react_jsx_runtime.jsx)(NotebookCapsule, { sessionsList: ctx.sessions.list });
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dai-notebook-capsule",
				order: 78,
				label: "DAI Notebook"
			}, NotebookCapsuleView));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map