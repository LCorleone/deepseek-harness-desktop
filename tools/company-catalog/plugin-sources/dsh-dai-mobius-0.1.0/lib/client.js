window.__ModuleLoader__.load({
	id: "dsh-dai-mobius",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/client/mobius-activity-model.js
		/**
		* Pure relationship projections for the Mobius activity panel.
		*
		* Mobius is the sequential-research sibling of AgentTeams: instead of a team
		* graph it owns one or more ordered *workflows* per captain session, and this
		* model derives the floater-wide lifecycle phase and cross-session expansion
		* rules from those workflows. It is deliberately free of I/O so the panel and
		* its tests share one source of truth.
		* @module dsh-agent-teams/client/mobius-activity-model
		*/
		/**
		* Derive the panel's overall phase from the workflows owned by the current
		* captain session.
		*
		* - `idle`: no workflow in this session (the collapsed badge / empty state).
		* - `planning`: any workflow is still staged (planned but not started) —
		*   "Mobius 规划中".
		* - `running`: any workflow is in flight ("Mobius 运行中").
		* - `completed`: there is at least one workflow and every workflow is fully
		*   done ("Mobius 已完成").
		*
		* Precedence makes planning and running dominate over completion: while any
		* workflow is still planned or in flight the floater keeps signalling active
		* coordination, and completion only reads once the whole set is settled.
		*/
		function mobiusPanelPhaseOf(workflows) {
			if (workflows.length === 0) return "idle";
			if (workflows.some((workflow) => workflow.phase === "staged")) return "planning";
			if (workflows.some((workflow) => workflow.phase === "running")) return "running";
			return "completed";
		}
		/** Whether the floater shows its animated water-wave surface (any real state). */
		function mobiusRunsWater(phase) {
			return phase !== "idle";
		}
		/**
		* Whether an expanded panel still belongs to the current session.
		*
		* The panel is mounted in the root-scoped shell overlay, so React does not
		* remount it when the conversation route changes. Ownership keeps an expanded
		* panel from leaking onto the new-session screen (or another conversation)
		* while its local open state is being reset.
		*/
		function mobiusPanelExpandedForSession(open, owner, current) {
			return open && owner !== void 0 && owner === current;
		}
		/**
		* Auto-expand only for workflows that appear after the current session's
		* initial restore pass. Workflows restored while reopening a conversation must
		* remain behind the collapsed badge.
		*/
		function mobiusPanelShouldAutoExpand({ alreadyAutoOpened, pageSettled, restoreComplete, previousLiveWorkflowIds, currentLiveWorkflowIds }) {
			return !alreadyAutoOpened && pageSettled && restoreComplete && currentLiveWorkflowIds.some((workflowId) => !previousLiveWorkflowIds.has(workflowId));
		}
		//#endregion
		//#region lib/client/mobius-monitor.js
		/**
		* Shared, demand-driven state for the Mobius browser monitor.
		*
		* Mobius has no archive: workflows stay live for their captain session until
		* the harness forgets them, so this monitor keeps a single live snapshot and
		* the same reference-counted target/refcount/discovery machinery as the
		* AgentTeams monitor, minus the archived-team fallback pass.
		* @module dsh-agent-teams/client/mobius-monitor
		*/
		const targets = /* @__PURE__ */ new Map();
		const targetListeners = /* @__PURE__ */ new Set();
		const snapshotListeners = /* @__PURE__ */ new Set();
		let targetSnapshot = [];
		let mobiusSnapshots = { workflows: [] };
		function targetKey(sessionId, workflowId) {
			return `${sessionId}\u0000${workflowId}`;
		}
		function publishTargets() {
			targetSnapshot = [...targets.values()].filter((target) => target.active).map(({ key, sessionId, workflowId }) => ({
				key,
				sessionId,
				workflowId
			}));
			for (const listener of targetListeners) listener();
		}
		/** Subscribe to the active monitor-target list (React external-store shape). */
		function subscribeMobiusMonitorTargets(listener) {
			targetListeners.add(listener);
			return () => {
				targetListeners.delete(listener);
			};
		}
		/** Read the stable active-target snapshot. */
		function getMobiusMonitorTargetsSnapshot() {
			return targetSnapshot;
		}
		/**
		* Register one successful mobius workflow as a monitoring demand.
		*
		* The returned cleanup is reference-counted so multiple cards and React
		* StrictMode remounts cannot stop another card's monitor.
		*/
		function monitorMobiusWorkflow(sessionId, workflowId) {
			const owner = sessionId.trim();
			const id = workflowId.trim();
			if (owner === "" || id === "") return () => {};
			const key = targetKey(owner, id);
			const existing = targets.get(key);
			if (existing === void 0) {
				targets.set(key, {
					key,
					sessionId: owner,
					workflowId: id,
					refs: 1,
					active: true
				});
				publishTargets();
			} else {
				existing.refs += 1;
				if (!existing.active) {
					existing.active = true;
					publishTargets();
				}
			}
			let released = false;
			return () => {
				if (released) return;
				released = true;
				const current = targets.get(key);
				if (current === void 0) return;
				current.refs -= 1;
				if (current.refs <= 0) {
					targets.delete(key);
					if (current.active) publishTargets();
				}
			};
		}
		/** Stop polling targets that no longer exist in the shared snapshot. */
		function settleMobiusMonitorTargets(keys) {
			let changed = false;
			for (const key of keys) {
				const target = targets.get(key);
				if (target?.active !== true) continue;
				target.active = false;
				changed = true;
			}
			if (changed) publishTargets();
		}
		/** Subscribe to the shared live snapshot. */
		function subscribeMobiusSnapshots(listener) {
			snapshotListeners.add(listener);
			return () => {
				snapshotListeners.delete(listener);
			};
		}
		/** Read the stable shared live snapshot. */
		function getMobiusSnapshotsSnapshot() {
			return mobiusSnapshots;
		}
		/** Publish a successful state-route response. */
		function updateMobiusSnapshots(workflows) {
			if (workflows === mobiusSnapshots.workflows) return;
			mobiusSnapshots = { workflows };
			for (const listener of snapshotListeners) listener();
		}
		/** Poll cadence for the live host snapshot route. */
		const MOBIUS_POLL_MS = 1e3;
		/**
		* Low-frequency probe cadence while a cardless discovery session still owns
		* no workflow. The probe keeps the panel able to pick up a workflow created
		* later in that session without turning every ordinary session into a
		* one-second filesystem scan.
		*/
		const MOBIUS_PROBE_MS = 5e3;
		/** Host route serving live mobius workflow snapshots. */
		const MOBIUS_STATE_URL = "/plugins/dsh-mobius/mobius";
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
		function startMobiusPolling(monitorTargets, runtime = {}) {
			const discoverySessionId = runtime.discoverySessionId?.trim();
			if (monitorTargets.length === 0 && (discoverySessionId === void 0 || discoverySessionId === "")) return {
				firstTick: Promise.resolve(),
				stop: () => {}
			};
			const fetchState = runtime.fetchState ?? ((url, init) => fetch(url, init));
			const schedule = runtime.schedule ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
			const cancel = runtime.cancel ?? ((timer) => {
				clearInterval(timer);
			});
			const publishSnapshots = runtime.publishSnapshots ?? updateMobiusSnapshots;
			const settleTargets = runtime.settleTargets ?? settleMobiusMonitorTargets;
			let cancelled = false;
			let inFlight = false;
			let hot = monitorTargets.length > 0;
			let discoveredLiveKeys = /* @__PURE__ */ new Set();
			let controller;
			let timer;
			const intervalMs = () => hot ? MOBIUS_POLL_MS : MOBIUS_PROBE_MS;
			const reschedule = () => {
				cancel(timer);
				timer = schedule(() => {
					tick();
				}, intervalMs());
			};
			const tick = async () => {
				if (inFlight || cancelled) return;
				inFlight = true;
				controller = new AbortController();
				try {
					const liveResponse = await fetchState(MOBIUS_STATE_URL, {
						cache: "no-store",
						signal: controller.signal
					});
					if (!liveResponse.ok) return;
					const body = await liveResponse.json();
					if (cancelled || !Array.isArray(body.workflows)) return;
					const workflows = body.workflows;
					publishSnapshots(workflows);
					discoveredLiveKeys = new Set(discoverySessionId === void 0 || discoverySessionId === "" ? [] : workflows.filter((workflow) => workflow.captainSessionId === discoverySessionId).map((workflow) => workflow.id));
					if (!hot && discoveredLiveKeys.size > 0) {
						hot = true;
						reschedule();
					}
					const missing = monitorTargets.filter((target) => !workflows.some((workflow) => workflow.captainSessionId === target.sessionId && workflow.id === target.workflowId));
					if (missing.length === 0) return;
					settleTargets(new Set(missing.map((target) => target.key)));
				} catch (error) {
					if (error?.name === "AbortError") return;
				} finally {
					inFlight = false;
				}
			};
			const firstTick = tick();
			if (timer === void 0) timer = schedule(() => {
				tick();
			}, intervalMs());
			return {
				firstTick,
				stop: () => {
					if (cancelled) return;
					cancelled = true;
					controller?.abort();
					cancel(timer);
				}
			};
		}
		const DEFAULT_PANEL_LAYOUT = Object.freeze({
			mode: "docked",
			x: 0,
			y: 64,
			width: 388,
			height: 640,
			heightMode: "auto"
		});
		function clamp(value, minimum, maximum) {
			return Math.min(Math.max(value, minimum), maximum);
		}
		function finite(value) {
			return typeof value === "number" && Number.isFinite(value);
		}
		/** Decode one versioned localStorage value, rejecting partial/corrupt state. */
		function parsePanelLayout(value) {
			if (value === null) return DEFAULT_PANEL_LAYOUT;
			try {
				const parsed = JSON.parse(value);
				if (typeof parsed !== "object" || parsed === null) return DEFAULT_PANEL_LAYOUT;
				const record = parsed;
				if (record.mode !== "docked" && record.mode !== "floating" || !finite(record.x) || !finite(record.y) || !finite(record.width) || !finite(record.height)) return DEFAULT_PANEL_LAYOUT;
				return {
					mode: record.mode,
					x: record.x,
					y: record.y,
					width: record.width,
					height: record.height,
					heightMode: record.mode === "floating" && record.heightMode === "manual" ? "manual" : "auto"
				};
			} catch {
				return DEFAULT_PANEL_LAYOUT;
			}
		}
		const BADGE_OFFSET_LIMIT = 1200;
		/** Read a persisted badge offset, rejecting out-of-range/corrupt values. */
		function parseBadgeOffset(value) {
			if (value === null) return {
				x: 0,
				y: 0
			};
			try {
				const parsed = JSON.parse(value);
				if (typeof parsed !== "object" || parsed === null) return {
					x: 0,
					y: 0
				};
				const record = parsed;
				if (!finite(record.x) || !finite(record.y)) return {
					x: 0,
					y: 0
				};
				return {
					x: clamp(record.x, -1200, BADGE_OFFSET_LIMIT),
					y: clamp(record.y, -1200, BADGE_OFFSET_LIMIT)
				};
			} catch {
				return {
					x: 0,
					y: 0
				};
			}
		}
		/** Whether the panel should become a simple inset overlay with no gestures. */
		function compactPanelForBounds(bounds) {
			return bounds.width <= 960;
		}
		/** Docked and compact panels always fit content; floating panels may be user-sized. */
		function panelUsesAutoHeight(layout, bounds) {
			return compactPanelForBounds(bounds) || layout.mode === "docked" || layout.heightMode === "auto";
		}
		/** CSS max-height ceiling that keeps an auto-height panel inside its shell. */
		function panelMaximumHeight(layout, bounds) {
			const bottomInset = compactPanelForBounds(bounds) || layout.mode === "floating" ? 12 : 48;
			return Math.max(1, bounds.height - layout.y - bottomInset);
		}
		/** Resolve persisted state into a visible rectangle inside the current shell. */
		function resolvePanelGeometry(layout, bounds) {
			const boundsWidth = Math.max(1, bounds.width);
			const boundsHeight = Math.max(1, bounds.height);
			if (compactPanelForBounds(bounds)) return {
				...layout,
				x: 12,
				y: 12,
				width: Math.max(1, boundsWidth - 24),
				height: Math.max(1, boundsHeight - 24)
			};
			const maximumWidth = Math.max(1, Math.min(640, boundsWidth - 24));
			const minimumWidth = Math.min(320, maximumWidth);
			const width = clamp(layout.width, minimumWidth, maximumWidth);
			const maximumHeight = Math.max(1, boundsHeight - 24);
			const minimumHeight = Math.min(360, maximumHeight);
			if (layout.mode === "docked") {
				const y = clamp(64, 12, Math.max(12, boundsHeight - minimumHeight - 12));
				const availableHeight = Math.max(1, boundsHeight - y - 48);
				const height = clamp(availableHeight, Math.min(minimumHeight, availableHeight), maximumHeight);
				const anchorRight = clamp(bounds.anchorRight, 0, boundsWidth);
				const maximumX = Math.max(12, boundsWidth - width - 12);
				return {
					mode: "docked",
					x: clamp(anchorRight - 18 - width, 12, maximumX),
					y,
					width,
					height,
					heightMode: layout.heightMode
				};
			}
			const height = clamp(layout.height, minimumHeight, maximumHeight);
			return {
				mode: "floating",
				x: clamp(layout.x, 12, Math.max(12, boundsWidth - width - 12)),
				y: clamp(layout.y, 12, Math.max(12, boundsHeight - height - 12)),
				width,
				height,
				heightMode: layout.heightMode
			};
		}
		/** Undock without a visual jump by adopting the panel's resolved rectangle. */
		function floatPanelLayout(geometry, bounds) {
			return resolvePanelGeometry({
				...geometry,
				mode: "floating"
			}, bounds);
		}
		/** Return to the right dock, preserving width and restoring content-fit height. */
		function dockPanelLayout(layout, bounds) {
			return resolvePanelGeometry({
				...layout,
				mode: "docked",
				heightMode: "auto"
			}, bounds);
		}
		/** Translate a floating panel and clamp it back into the visible shell. */
		function movePanelLayout(start, dx, dy, bounds) {
			return resolvePanelGeometry({
				...start,
				mode: "floating",
				x: start.x + dx,
				y: start.y + dy
			}, bounds);
		}
		/** Resize while keeping the edge opposite the active handle stationary. */
		function resizePanelLayout(start, edge, dx, dy, bounds) {
			if (start.mode === "docked") {
				if (edge !== "left") return resolvePanelGeometry(start, bounds);
				return resolvePanelGeometry({
					...start,
					width: start.width - dx
				}, bounds);
			}
			const resolved = resolvePanelGeometry(start, bounds);
			const minimumWidth = Math.min(320, resolved.x + resolved.width - 12);
			const minimumHeight = Math.min(360, bounds.height - resolved.y - 12);
			if (edge === "left") {
				const right = resolved.x + resolved.width;
				const maximumWidth = Math.max(1, Math.min(640, right - 12));
				const width = clamp(resolved.width - dx, Math.min(minimumWidth, maximumWidth), maximumWidth);
				return {
					...resolved,
					x: right - width,
					width
				};
			}
			const maximumHeight = Math.max(1, bounds.height - resolved.y - 12);
			const height = clamp(resolved.height + dy, Math.min(minimumHeight, maximumHeight), maximumHeight);
			if (edge === "bottom") return {
				...resolved,
				height,
				heightMode: "manual"
			};
			const maximumWidth = Math.max(1, Math.min(640, bounds.width - resolved.x - 12));
			const width = clamp(resolved.width + dx, Math.min(minimumWidth, maximumWidth), maximumWidth);
			return {
				...resolved,
				width,
				height,
				heightMode: "manual"
			};
		}
		//#endregion
		//#region \0dsh-css:/opt/dsh-plugins/dsh-dai-mobius/src/client/MobiusCard.module.css.mjs
		const css$1 = "._3lJHkW_root{border:1px solid var(--dsh-border,#80808040);background:var(--dsh-surface,#ffffff0a);border-radius:10px;flex-direction:column;gap:6px;padding:10px 12px;display:flex}._3lJHkW_head{align-items:center;gap:8px;display:flex}._3lJHkW_name{text-overflow:ellipsis;white-space:nowrap;font-weight:600;overflow:hidden}._3lJHkW_count{color:var(--dsh-text-muted,#808080e6);white-space:nowrap;font-size:12px}._3lJHkW_panelButton{border:1px solid var(--dsh-border,#80808040);color:var(--dsh-text-secondary,#b4b4b4e6);cursor:pointer;white-space:nowrap;background:0 0;border-radius:7px;align-items:center;gap:5px;margin-left:auto;padding:4px 9px;font-size:12px;display:inline-flex}._3lJHkW_panelButton:hover:not(:disabled){background:#8080801f}._3lJHkW_goal{color:var(--dsh-text-secondary,#b4b4b4e6);font-size:13px;line-height:1.4}";
		const tagId$1 = "dsh-dai-mobius/MobiusCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-dai-mobius";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var MobiusCard_module_css_default = {
			"count": "_3lJHkW_count",
			"goal": "_3lJHkW_goal",
			"head": "_3lJHkW_head",
			"name": "_3lJHkW_name",
			"panelButton": "_3lJHkW_panelButton",
			"root": "_3lJHkW_root"
		};
		//#endregion
		//#region lib/client/MobiusCard.js
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
		/** Window event the floater listens for to open itself with this workflow. */
		const OPEN_MOBIUS_PANEL_EVENT = "dsh-mobius:open-panel";
		function useMobiusSnapshots() {
			return (0, react.useSyncExternalStore)(subscribeMobiusSnapshots, getMobiusSnapshotsSnapshot).workflows;
		}
		/** Re-activate the top-right activity panel, carrying this workflow's summary. */
		function openActivityPanel(data) {
			window.dispatchEvent(new CustomEvent(OPEN_MOBIUS_PANEL_EVENT, { detail: {
				workflowId: data.workflowId,
				captainSessionId: data.captainSessionId,
				name: data.name
			} }));
		}
		function MobiusCard({ node }) {
			const data = node.data;
			const owner = data.captainSessionId;
			const workflows = useMobiusSnapshots();
			(0, react.useEffect)(() => {
				if (owner === "") return;
				return monitorMobiusWorkflow(owner, data.workflowId);
			}, [data.workflowId, owner]);
			const snapshot = workflows.find((workflow) => workflow.id === data.workflowId && (owner === "" || workflow.captainSessionId === owner));
			const resolved = (0, react.useMemo)(() => ({
				...data,
				captainSessionId: snapshot?.captainSessionId ?? owner,
				steps: snapshot?.steps.length ?? data.steps
			}), [
				data,
				owner,
				snapshot
			]);
			return (0, react_jsx_runtime.jsxs)("section", {
				className: MobiusCard_module_css_default.root,
				"data-mobius-card": true,
				"data-workflow-id": resolved.workflowId,
				children: [(0, react_jsx_runtime.jsxs)("header", {
					className: MobiusCard_module_css_default.head,
					children: [
						(0, react_jsx_runtime.jsx)("span", {
							className: MobiusCard_module_css_default.name,
							title: resolved.name,
							children: resolved.name
						}),
						(0, react_jsx_runtime.jsxs)("span", {
							className: MobiusCard_module_css_default.count,
							children: [resolved.steps, " 个步骤"]
						}),
						(0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: MobiusCard_module_css_default.panelButton,
							onClick: () => {
								openActivityPanel(resolved);
							},
							"aria-label": "打开 Activity Panel",
							title: "打开 Activity Panel",
							children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPanelLeftOutline16, {}), (0, react_jsx_runtime.jsx)("span", { children: "打开 Activity Panel" })]
						})
					]
				}), resolved.goal !== "" && (0, react_jsx_runtime.jsx)("div", {
					className: MobiusCard_module_css_default.goal,
					children: resolved.goal
				})]
			});
		}
		//#endregion
		//#region \0dsh-css:/opt/dsh-plugins/dsh-dai-mobius/src/client/MobiusActivityPanel.module.css.mjs
		const css = "html{--mobius-panel-shift:420px}html[data-mobius-panel-open] [data-phase=active]{box-sizing:border-box;padding-right:var(--mobius-panel-shift)}.kTZJvG_badge,.kTZJvG_panel{--dsw-alias-line-normal:var(--dsw-static-neutral-bluish-150,#e7e9ee);--dsw-alias-line-strong:color-mix(in srgb, var(--dsw-static-neutral-bluish-200,#e1e5ee) 50%, var(--dsw-static-neutral-bluish-300,#cfd3d6));--dsw-alias-bg-module:var(--dsw-alias-bg-layer-1,#fff);--dsw-alias-bg-fill-neutral:var(--dsw-static-neutral-bluish-100,#eef0f4);--dsw-alias-state-business-primary:var(--mobius-green-primary,#37a876);--dsw-alias-bg-fill-business:var(--dsw-alias-state-business-primary,#37a876);--dsw-alias-bg-fill-success:var(--dsw-alias-state-success-primary,#12a150);--dsw-alias-bg-fill-warning:var(--dsw-alias-state-warn-primary,#e08700);--dsw-alias-bg-fill-danger:var(--dsw-alias-state-error-primary,#e5484d);--dsw-alias-state-success:var(--dsw-alias-state-success-primary,#12a150);--dsw-alias-state-warning:var(--dsw-alias-state-warn-primary,#e08700);--dsw-alias-state-danger:var(--dsw-alias-state-error-primary,#e5484d);--dsw-alias-label-on-fill:var(--dsw-alias-label-primary-inverted,#fff)}.kTZJvG_badge{box-sizing:border-box;border:1px solid var(--dsw-alias-line-normal);background:color-mix(in srgb, var(--dsw-alias-bg-module-platform) 92%, transparent);backdrop-filter:blur(16px);height:34px;box-shadow:0 8px 28px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);color:var(--dsw-alias-label-secondary);font:inherit;cursor:grab;touch-action:none;border-radius:999px;align-items:center;gap:7px;padding:0 12px;font-size:12px;font-weight:600;line-height:20px;transition:border-color .15s;display:inline-flex;position:absolute;top:64px;right:18px;overflow:hidden}.kTZJvG_badge[data-phase=planning]{--mobius-accent:#4d6bfe}.kTZJvG_badge[data-phase=running]{--mobius-accent:#f2994a}.kTZJvG_badge[data-phase=completed]{--mobius-accent:#12a150}.kTZJvG_badge:before,.kTZJvG_badge:after{z-index:0;content:\"\";pointer-events:none;border-radius:inherit;position:absolute;inset:-40%}.kTZJvG_badge:before{background:radial-gradient(ellipse at 20% 30%, color-mix(in srgb, var(--mobius-accent) 30%, transparent) 0%, transparent 48%);animation:4.5s ease-in-out infinite kTZJvG_mobiusBadgeWave}.kTZJvG_badge:after{background:radial-gradient(ellipse at 70% 20%, color-mix(in srgb, var(--mobius-accent) 20%, transparent) 0%, transparent 52%);animation:6.5s ease-in-out infinite reverse kTZJvG_mobiusBadgeWave}@keyframes kTZJvG_mobiusBadgeWave{0%{opacity:.45;transform:translate(-18%)rotate(0)}50%{opacity:.9;transform:translate(18%,2%)rotate(2deg)}to{opacity:.45;transform:translate(-18%)rotate(0)}}.kTZJvG_badge>.kTZJvG_badgeDot,.kTZJvG_badge>.kTZJvG_badgeText,.kTZJvG_badge>.kTZJvG_badgeCount{z-index:1;position:relative}.kTZJvG_badge:hover{border-color:var(--dsw-alias-line-strong)}.kTZJvG_badge:active,.kTZJvG_badge[data-dragging=true]{cursor:grabbing;user-select:none}.kTZJvG_badge[data-dragging=true]{box-shadow:0 8px 28px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent), 0 16px 40px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)}.kTZJvG_badge:focus-visible,.kTZJvG_iconButton:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.kTZJvG_badgeDot,.kTZJvG_panelDot{background:var(--dsw-alias-label-tertiary);border-radius:50%;width:7px;height:7px}.kTZJvG_badgeDot[data-busy=true],.kTZJvG_panelDot[data-busy=true]{background:var(--dsw-alias-state-business-primary);animation:1.25s ease-in-out infinite kTZJvG_mobiusPulse}.kTZJvG_badgeDot[data-phase=planning],.kTZJvG_badgeDot[data-phase=running],.kTZJvG_badgeDot[data-phase=completed]{background:var(--mobius-accent)}.kTZJvG_badgeText{text-overflow:ellipsis;white-space:nowrap;max-width:160px;overflow:hidden}.kTZJvG_badgeCount{font-variant-numeric:tabular-nums}.kTZJvG_panel{box-sizing:border-box;border:1px solid color-mix(in srgb, var(--dsw-alias-line-normal) 90%, transparent);background:color-mix(in srgb, var(--dsw-alias-bg-module) 90%, transparent);backdrop-filter:blur(22px)saturate(1.1);box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent), 0 16px 40px color-mix(in srgb, var(--dsw-alias-label-primary) 13%, transparent), 0 40px 80px color-mix(in srgb, var(--dsw-alias-label-primary) 11%, transparent);will-change:transform;border-radius:14px;flex-direction:column;animation:.16s ease-out kTZJvG_mobiusPanelIn;display:flex;position:absolute;top:0;left:0;overflow:hidden}.kTZJvG_panel[data-phase=planning]{--mobius-accent:#4d6bfe}.kTZJvG_panel[data-phase=running]{--mobius-accent:#f2994a}.kTZJvG_panel[data-phase=completed]{--mobius-accent:#12a150}.kTZJvG_panel[data-dragging],.kTZJvG_panel[data-resizing]{user-select:none;box-shadow:0 16px 38px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent), 0 36px 78px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent)}@keyframes kTZJvG_mobiusPanelIn{0%{opacity:0}to{opacity:1}}@keyframes kTZJvG_mobiusPulse{0%,to{opacity:.42}50%{opacity:1}}.kTZJvG_waterWaves{z-index:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity .32s;position:absolute;inset:0;overflow:hidden}.kTZJvG_waterWaves[data-active=true]{opacity:1}.kTZJvG_waterWaves:before,.kTZJvG_waterWaves:after{content:\"\";pointer-events:none;width:200%;height:260%;position:absolute;left:-50%}.kTZJvG_waterWaves:before{background:radial-gradient(ellipse at 20% 30%, color-mix(in srgb, var(--mobius-accent,var(--dsw-alias-state-business-primary)) 20%, transparent) 0%, transparent 42%);animation:9s ease-in-out infinite kTZJvG_mobiusWave;top:-70%}.kTZJvG_waterWaves:after{background:radial-gradient(ellipse at 70% 18%, color-mix(in srgb, var(--mobius-accent,var(--dsw-alias-state-success)) 14%, transparent) 0%, transparent 46%);animation:13s ease-in-out infinite reverse kTZJvG_mobiusWave;top:-52%}@keyframes kTZJvG_mobiusWave{0%{transform:translate(0,0)rotate(0)scale(1.02)}25%{transform:translate(6%,2%)rotate(1.2deg)scale(1.05)}50%{transform:translateY(4%)rotate(-.8deg)scale(1.03)}75%{transform:translate(-5%,1%)rotate(1deg)scale(1.06)}to{transform:translate(0,0)rotate(0)scale(1.02)}}.kTZJvG_panel>.kTZJvG_panelHead,.kTZJvG_panel>.kTZJvG_workflows{z-index:1;position:relative}.kTZJvG_panelHead{border-bottom:1px solid var(--dsw-alias-line-normal);cursor:grab;touch-action:none;flex:none;justify-content:space-between;align-items:center;min-height:46px;padding:0 12px 0 16px;display:flex}.kTZJvG_panelHead:active,.kTZJvG_panel[data-dragging] .kTZJvG_panelHead{cursor:grabbing}.kTZJvG_panel[data-compact] .kTZJvG_panelHead{cursor:default;touch-action:auto}.kTZJvG_panelTitle{color:var(--dsw-alias-label-primary);letter-spacing:.01em;align-items:center;gap:8px;font-size:13px;font-weight:700;line-height:20px;display:inline-flex}.kTZJvG_panelControls{flex:none;align-items:center;gap:2px;display:inline-flex}.kTZJvG_iconButton{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:7px;justify-content:center;align-items:center;padding:0;transition:background-color .12s,color .12s,transform .12s;display:inline-flex}.kTZJvG_iconButton:hover{background:var(--dsw-alias-bg-fill-neutral);color:var(--dsw-alias-label-primary)}.kTZJvG_iconButton:active{transform:scale(.94)}.kTZJvG_iconButton[data-control=dock][data-mode=docked] svg{transform:scaleX(-1)}.kTZJvG_iconButton[data-control=halt]:disabled{opacity:.5;cursor:default}.kTZJvG_resizeHandle{z-index:5;touch-action:none;pointer-events:auto;position:absolute}.kTZJvG_resizeHandle[data-resize-edge=left]{cursor:ew-resize;width:14px;top:44px;bottom:14px;left:0}.kTZJvG_resizeHandle[data-resize-edge=left]:after{background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 42%, transparent);content:\"\";opacity:.45;border-radius:999px;width:3px;height:48px;transition:background-color .12s,opacity .12s;position:absolute;top:50%;left:4px;transform:translateY(-50%)}.kTZJvG_resizeHandle[data-resize-edge=bottom]{cursor:ns-resize;height:14px;bottom:0;left:20px;right:20px}.kTZJvG_resizeHandle[data-resize-edge=bottom]:after{background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 42%, transparent);content:\"\";opacity:.45;border-radius:999px;width:48px;height:3px;transition:background-color .12s,opacity .12s;position:absolute;bottom:4px;left:50%;transform:translate(-50%)}.kTZJvG_resizeHandle[data-resize-edge=corner]{cursor:nwse-resize;width:28px;height:28px;bottom:0;right:0}.kTZJvG_resizeHandle[data-resize-edge=corner]:after{border-right:2px solid var(--dsw-alias-label-tertiary);border-bottom:2px solid var(--dsw-alias-label-tertiary);content:\"\";opacity:.58;width:10px;height:10px;transition:border-color .12s,opacity .12s;position:absolute;bottom:6px;right:6px}.kTZJvG_resizeHandle:hover:after,.kTZJvG_panel[data-resizing] .kTZJvG_resizeHandle:after{background-color:var(--dsw-alias-bg-fill-business);border-color:var(--dsw-alias-bg-fill-business);opacity:.95}.kTZJvG_workflows{overscroll-behavior:contain;scrollbar-color:color-mix(in srgb, var(--dsw-alias-label-tertiary) 28%, transparent) transparent;scrollbar-width:thin;flex-direction:column;min-height:0;display:flex;overflow-y:auto}.kTZJvG_workflows::-webkit-scrollbar{width:6px}.kTZJvG_workflows::-webkit-scrollbar-track{background:0 0}.kTZJvG_workflows::-webkit-scrollbar-thumb{background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 28%, transparent);background-clip:padding-box;border:2px solid #0000;border-radius:999px}.kTZJvG_workflows:hover::-webkit-scrollbar-thumb{background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 44%, transparent);background-clip:padding-box}.kTZJvG_card{border-bottom:1px solid var(--dsw-alias-line-normal);flex-direction:column;gap:8px;padding:14px;display:flex}.kTZJvG_card[data-phase=staged]{--mobius-card-accent:var(--dsw-alias-state-business-primary)}.kTZJvG_card[data-phase=running]{--mobius-card-accent:#f2994a}.kTZJvG_card[data-phase=done]{--mobius-card-accent:var(--dsw-alias-state-success)}.kTZJvG_card:last-child{border-bottom:0}.kTZJvG_head{align-items:center;gap:8px;min-width:0;display:flex}.kTZJvG_name{min-width:0;color:var(--dsw-alias-label-primary);letter-spacing:.005em;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:13px;font-weight:650;line-height:20px;overflow:hidden}.kTZJvG_phase{background:color-mix(in srgb, var(--mobius-card-accent,var(--dsw-alias-bg-fill-business)) 14%, transparent);color:var(--mobius-card-accent,var(--dsw-alias-state-business-primary));letter-spacing:.03em;border-radius:999px;flex:none;padding:1px 8px;font-size:9px;font-weight:700;line-height:16px}.kTZJvG_progress{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;flex:none;font-size:10.5px;line-height:16px}.kTZJvG_progressPct{color:var(--mobius-card-accent);font-weight:600;animation:.4s cubic-bezier(.34,1.56,.64,1) kTZJvG_mobiusPctPop;display:inline-block}@keyframes kTZJvG_mobiusPctPop{0%{transform:scale(1)}40%{transform:scale(1.25)}to{transform:scale(1)}}.kTZJvG_exportButton{width:22px;height:22px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;flex:none;justify-content:center;align-items:center;padding:0;transition:background-color .12s,color .12s,transform .12s;display:inline-flex}.kTZJvG_exportButton:hover{background:var(--dsw-alias-bg-fill-neutral);color:var(--dsw-alias-label-primary)}.kTZJvG_exportButton:active{transform:scale(.92)}.kTZJvG_exportButton svg{width:13px;height:13px}.kTZJvG_exportButtonActive{background:var(--dsw-alias-bg-fill-neutral);color:var(--dsw-alias-label-primary)}.kTZJvG_exportWrap{flex:none;display:inline-flex;position:relative}.kTZJvG_exportBackdrop{z-index:30;position:fixed;inset:0}.kTZJvG_exportMenu{z-index:40;border:1px solid var(--dsw-alias-line-normal);background:var(--dsw-alias-bg-raised,var(--dsw-alias-bg-fill-neutral));border-radius:10px;flex-direction:column;width:218px;padding:5px;display:flex;position:absolute;top:calc(100% + 6px);right:0;box-shadow:0 8px 24px #0000002e}.kTZJvG_exportMenuItem{color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:0;border-radius:7px;align-items:center;gap:9px;padding:7px 8px;transition:background-color .12s;display:flex}.kTZJvG_exportMenuItem:hover{background:var(--dsw-alias-bg-fill-neutral)}.kTZJvG_exportMenuItemIcon{background:color-mix(in srgb, var(--mobius-card-accent,var(--dsw-alias-state-business-primary)) 14%, transparent);width:26px;height:26px;color:var(--mobius-card-accent,var(--dsw-alias-state-business-primary));border-radius:6px;flex:none;justify-content:center;align-items:center;display:inline-flex}.kTZJvG_exportMenuItemIcon svg{width:14px;height:14px}.kTZJvG_exportMenuItemText{flex-direction:column;gap:1px;min-width:0;display:flex}.kTZJvG_exportMenuItemTitle{font-size:12px;font-weight:600;line-height:17px}.kTZJvG_exportMenuItemDesc{color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:15px}.kTZJvG_goal{color:var(--dsw-alias-label-secondary);-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:11px;line-height:17px;display:-webkit-box;overflow:hidden}.kTZJvG_bar{background:var(--dsw-alias-line-strong);border-radius:999px;height:4px;margin:1px 0 2px;overflow:hidden}.kTZJvG_barFill{background:linear-gradient(90deg, color-mix(in srgb, var(--mobius-card-accent) 82%, transparent), var(--mobius-card-accent));border-radius:999px;height:100%;transition:width .45s cubic-bezier(.22,.61,.36,1);position:relative;overflow:hidden}.kTZJvG_barShimmer{background:linear-gradient(100deg,#0000 20%,#ffffff73 50%,#0000 80%) 0 0/200% 100%;animation:1.8s linear infinite kTZJvG_mobiusBarSweep;position:absolute;inset:0}@keyframes kTZJvG_mobiusBarSweep{0%{background-position:200% 0}to{background-position:-200% 0}}.kTZJvG_card[data-phase=done] .kTZJvG_barShimmer,.kTZJvG_card[data-phase=staged] .kTZJvG_barShimmer{opacity:.35;animation:none}.kTZJvG_stages{flex-direction:column;gap:4px;margin:4px 0 0;padding:0;list-style:none;display:flex}.kTZJvG_stageConnector{flex:none;justify-content:center;align-items:center;height:18px;display:flex;position:relative}.kTZJvG_stageConnector:before{border-left:1.5px solid var(--dsw-alias-line-strong);content:\"\";width:0;height:100%}.kTZJvG_stageConnector:after{border-right:2px solid var(--dsw-alias-state-business-primary);border-bottom:2px solid var(--dsw-alias-state-business-primary);content:\"\";width:7px;height:7px;position:absolute;top:50%;transform:translateY(-2px)rotate(45deg)}.kTZJvG_stageBlock{border:1px solid var(--dsw-alias-line-normal);background:color-mix(in srgb, var(--dsw-alias-bg-module-platform) 24%, transparent);border-radius:10px;flex-direction:column;gap:7px;padding:9px 10px;transition:border-color .12s,background-color .12s;display:flex}.kTZJvG_stageBlockHead{align-items:center;gap:7px;display:flex}.kTZJvG_stageBlockIndex{background:color-mix(in srgb, var(--dsw-alias-bg-fill-business) 14%, transparent);width:19px;height:19px;color:var(--dsw-alias-state-business-primary);border-radius:6px;flex:none;justify-content:center;align-items:center;font-size:10px;font-weight:800;line-height:19px;display:inline-flex}.kTZJvG_stageBlockName{min-width:0;color:var(--dsw-alias-text-primary);text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:700;line-height:16px;overflow:hidden}.kTZJvG_stageNameEdit{border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, var(--dsw-alias-line-normal));background:color-mix(in srgb, var(--dsw-alias-bg-module) 40%, transparent);min-width:0;color:var(--dsw-alias-text-primary);border-radius:6px;flex:1;padding:1px 6px;font-size:11px;font-weight:700;line-height:16px}.kTZJvG_stageNameEdit:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 20%, transparent);outline:none}.kTZJvG_stageNameEdit::placeholder{color:var(--dsw-alias-label-tertiary);font-weight:500}.kTZJvG_stageBlockParallel{background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 13%, transparent);color:var(--dsw-alias-state-warning-primary);border-radius:999px;flex:none;margin-left:auto;padding:0 7px;font-size:9px;font-weight:700;line-height:16px}.kTZJvG_stageBlockSerial{background:var(--dsw-alias-bg-fill-neutral);color:var(--dsw-alias-label-tertiary);border-radius:999px;flex:none;margin-left:auto;padding:0 7px;font-size:9px;font-weight:700;line-height:16px}.kTZJvG_stageSteps{flex-direction:column;gap:3px;margin:0;padding:0;list-style:none;display:flex}.kTZJvG_step{border-left:2px solid var(--dsw-alias-line-normal);border-radius:4px;flex-direction:column;gap:2px;min-width:0;padding:2px 2px 2px 9px;transition:border-color .12s,background-color .12s;display:flex}.kTZJvG_step:hover{background:color-mix(in srgb, var(--dsw-alias-bg-fill-neutral) 50%, transparent);border-left-color:var(--dsw-alias-line-strong)}.kTZJvG_step.kTZJvG_is-running{border-left-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, transparent)}.kTZJvG_step.kTZJvG_is-completed{border-left-color:color-mix(in srgb, var(--dsw-alias-state-success) 55%, transparent)}.kTZJvG_step.kTZJvG_is-completed .kTZJvG_stepName{color:var(--dsw-alias-label-tertiary);text-decoration:line-through;text-decoration-color:color-mix(in srgb, var(--dsw-alias-label-tertiary) 60%, transparent);text-decoration-thickness:1px}.kTZJvG_step.kTZJvG_is-failed{border-left-color:var(--dsw-alias-state-danger)}.kTZJvG_step.kTZJvG_is-halted{border-left-color:var(--dsw-alias-line-strong)}.kTZJvG_step.kTZJvG_is-halted .kTZJvG_stepName{color:var(--dsw-alias-label-tertiary)}.kTZJvG_stepHeader{min-width:0;color:inherit;text-align:left;font:inherit;cursor:pointer;background:0 0;border:0;border-radius:4px;align-items:center;gap:6px;padding:2px 0;display:flex}.kTZJvG_stepHeader:hover .kTZJvG_stepName{color:var(--dsw-alias-label-primary)}.kTZJvG_stepHeader:disabled{cursor:default}.kTZJvG_stepCaret{color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;margin-left:auto;transition:transform .15s;display:inline-flex}.kTZJvG_step[data-open=true] .kTZJvG_stepCaret{transform:rotate(180deg)}.kTZJvG_stepCaret svg{width:12px;height:12px}.kTZJvG_stepBody{flex-direction:column;gap:3px;min-width:0;padding-bottom:3px;display:flex}.kTZJvG_stepTitle{align-items:center;gap:6px;display:flex}.kTZJvG_statusDot{background:var(--dsw-alias-line-normal);width:16px;height:16px;color:var(--dsw-alias-label-on-fill);border-radius:50%;flex-shrink:0;justify-content:center;align-items:center;margin-top:1px;display:inline-flex}.kTZJvG_statusDot svg{width:11px;height:11px}.kTZJvG_step.kTZJvG_is-running .kTZJvG_statusDot{background:var(--dsw-alias-state-business-primary);animation:1.2s infinite kTZJvG_mobiusStepPulse}.kTZJvG_step.kTZJvG_is-completed .kTZJvG_statusDot{background:var(--dsw-alias-state-success)}.kTZJvG_step.kTZJvG_is-failed .kTZJvG_statusDot{background:var(--dsw-alias-state-danger)}.kTZJvG_step.kTZJvG_is-halted .kTZJvG_statusDot{background:var(--dsw-alias-line-strong)}@keyframes kTZJvG_mobiusStepPulse{0%,to{opacity:1}50%{opacity:.35}}.kTZJvG_stepOrdinal{background:var(--dsw-alias-bg-fill-neutral);min-width:17px;height:17px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;border-radius:5px;flex:none;justify-content:center;align-items:center;padding:0 4px;font-size:9px;font-weight:800;line-height:17px;display:inline-flex}.kTZJvG_stepName{min-width:0;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:600;line-height:16px;overflow:hidden}.kTZJvG_runningTag{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 11%, transparent);color:var(--dsw-alias-state-business-primary);border-radius:999px;flex:none;align-items:center;gap:4px;padding:0 6px;font-size:9px;font-weight:700;line-height:15px;display:inline-flex}.kTZJvG_runningTag:before{content:\"\";background:currentColor;border-radius:50%;width:5px;height:5px;animation:1.2s infinite kTZJvG_mobiusStepPulse}.kTZJvG_haltedTag,.kTZJvG_failedTag{border-radius:999px;flex:none;align-items:center;padding:0 6px;font-size:9px;font-weight:700;line-height:15px;display:inline-flex}.kTZJvG_haltedTag{background:color-mix(in srgb, var(--dsw-alias-line-strong) 40%, transparent);color:var(--dsw-alias-label-tertiary)}.kTZJvG_failedTag{background:color-mix(in srgb, var(--dsw-alias-state-danger) 12%, transparent);color:var(--dsw-alias-state-danger)}.kTZJvG_stepTarget,.kTZJvG_stepOutput{white-space:pre-wrap;word-break:break-word;font-size:10.5px;line-height:15px}.kTZJvG_stepTarget{color:var(--dsw-alias-label-secondary)}.kTZJvG_stepOutput{color:var(--dsw-alias-label-primary);border-left:2px solid var(--dsw-alias-line-strong);padding-left:6px}.kTZJvG_emptyHint{color:var(--dsw-alias-label-tertiary);text-align:center;padding:18px 16px;font-size:11px;line-height:17px}.kTZJvG_reviewBanner{border-radius:9px;align-items:flex-start;gap:8px;padding:8px 10px;font-size:10.5px;line-height:15px;display:flex}.kTZJvG_reviewBanner[data-pending]{border:1px solid color-mix(in srgb, var(--dsw-alias-state-warning-primary) 36%, var(--dsw-alias-line-normal));background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 7%, transparent);color:var(--dsw-alias-state-warning-primary)}.kTZJvG_reviewBanner[data-rejected]{border:1px solid color-mix(in srgb, var(--dsw-alias-state-danger-primary) 36%, var(--dsw-alias-line-normal));background:color-mix(in srgb, var(--dsw-alias-state-danger-primary) 7%, transparent);color:var(--dsw-alias-state-danger-primary)}.kTZJvG_reviewBanner[data-passed]{border:1px solid color-mix(in srgb, var(--dsw-alias-state-success) 36%, var(--dsw-alias-line-normal));background:color-mix(in srgb, var(--dsw-alias-state-success) 7%, transparent);color:var(--dsw-alias-state-success)}.kTZJvG_reviewText{flex-direction:column;gap:2px;min-width:0;display:flex}.kTZJvG_reviewRound{flex:none;font-weight:700}.kTZJvG_reviewFindings{-webkit-line-clamp:3;color:var(--dsw-alias-label-secondary);-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}.kTZJvG_conclusion{border:1px solid var(--dsw-alias-line-normal);background:color-mix(in srgb, var(--dsw-alias-bg-module-platform) 18%, transparent);border-radius:9px;overflow:hidden}.kTZJvG_conclusion summary{cursor:pointer;color:var(--dsw-alias-label-secondary);user-select:none;align-items:center;gap:6px;padding:7px 10px;font-size:10.5px;font-weight:650;display:flex}.kTZJvG_conclusion summary:hover{color:var(--dsw-alias-label-primary)}.kTZJvG_conclusion summary:before{content:\"\";border-bottom:1.5px solid;border-right:1.5px solid;width:6px;height:6px;transition:transform .12s;transform:rotate(-45deg)translateY(-1px)}.kTZJvG_conclusion[open] summary:before{transform:rotate(45deg)}.kTZJvG_conclusionBody{color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;padding:2px 12px 10px;font-size:10.5px;line-height:16px}@media (prefers-reduced-motion:reduce){.kTZJvG_panel,.kTZJvG_badge,.kTZJvG_badgeDot,.kTZJvG_panelDot,.kTZJvG_waterWaves,.kTZJvG_waterWaves:before,.kTZJvG_waterWaves:after,.kTZJvG_step.kTZJvG_is-running .kTZJvG_statusDot{transition:none;animation:none}}@media (width<=960px){html[data-mobius-panel-open] [data-phase=active]{padding-right:0}}@media (width<=640px){.kTZJvG_badge{top:56px;right:10px}}.kTZJvG_planActions{border-top:1px solid var(--dsw-alias-line-normal);flex-direction:column;align-items:stretch;gap:7px;margin-top:10px;padding-top:11px;display:flex}.kTZJvG_planBtn,.kTZJvG_planBtnPrimary,.kTZJvG_planBtnDanger{border:1px solid var(--dsw-alias-line-strong);background:color-mix(in srgb, var(--dsw-alias-bg-module) 60%, transparent);color:var(--dsw-alias-text-primary);cursor:pointer;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:550;line-height:1.4;transition:background-color .12s,border-color .12s,transform 80ms}.kTZJvG_planBtn:hover:not(:disabled){background:var(--dsw-alias-surface-mid);border-color:var(--dsw-alias-line-strong)}.kTZJvG_planBtn:active:not(:disabled){transform:scale(.985)}.kTZJvG_planBtnPrimary{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-fill);background:var(--dsw-alias-state-business-primary);font-weight:600}.kTZJvG_planBtnPrimary:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 88%, #fff);border-color:#0000}.kTZJvG_planBtnDanger{border-color:color-mix(in srgb, var(--dsw-alias-state-danger-primary,#e05555) 55%, transparent);color:var(--dsw-alias-state-danger-primary,#e05555)}.kTZJvG_planBtnDanger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-danger-primary,#e05555) 10%, transparent)}.kTZJvG_planBtn:disabled,.kTZJvG_planBtnPrimary:disabled,.kTZJvG_planBtnDanger:disabled{opacity:.5;cursor:default}.kTZJvG_planConfirm{color:var(--dsw-alias-text-secondary);font-size:12px}.kTZJvG_planError{color:var(--dsw-alias-state-danger-primary,#e05555);font-size:12px}.kTZJvG_editGoal{flex-direction:column;gap:3px;display:flex}.kTZJvG_editLabel{color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:600;line-height:14px}.kTZJvG_editField{flex-direction:column;gap:2px;min-width:0;display:flex}.kTZJvG_editFieldLabel{color:var(--dsw-alias-label-tertiary);font-size:9.5px;font-weight:600;line-height:13px}.kTZJvG_editInput{box-sizing:border-box;border:1px solid var(--dsw-alias-line-strong);background:color-mix(in srgb, var(--dsw-alias-bg-module) 96%, transparent);width:100%;color:var(--dsw-alias-label-primary);font:inherit;resize:vertical;border-radius:7px;padding:4px 7px;font-size:11px;line-height:16px;transition:border-color .12s,box-shadow .12s}.kTZJvG_editInput:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent);outline:none}.kTZJvG_editInput::placeholder{color:var(--dsw-alias-label-quaternary,var(--dsw-alias-label-tertiary))}.kTZJvG_editStepId{min-width:0;color:var(--dsw-alias-label-tertiary);align-items:baseline;gap:8px;display:flex}.kTZJvG_editStepOrdinal{letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;flex:none;font-size:9.5px;font-weight:700;line-height:14px}.kTZJvG_editStepTitle{color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;font-weight:600;line-height:16px;overflow:hidden}.kTZJvG_editRemoveBtn{border:1px solid color-mix(in srgb, var(--dsw-alias-state-danger-primary,#e05555) 45%, transparent);color:var(--dsw-alias-state-danger-primary,#e05555);cursor:pointer;text-transform:none;background:0 0;border-radius:6px;padding:1px 8px;font-size:9.5px;font-weight:600;line-height:16px;transition:background-color .12s}.kTZJvG_editRemoveBtn:hover{background:color-mix(in srgb, var(--dsw-alias-state-danger-primary,#e05555) 10%, transparent)}.kTZJvG_addStepBtn{border:1px dashed var(--dsw-alias-line-strong);color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border-radius:7px;align-self:stretch;padding:4px 10px;font-size:10.5px;font-weight:600;line-height:1.4;transition:border-color .12s,color .12s,background-color .12s}.kTZJvG_addStepBtn:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, transparent)}.kTZJvG_step[data-editing]{border-left-color:var(--dsw-alias-state-business-primary);border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, var(--dsw-alias-line-normal));background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 4%, transparent);border-radius:8px;gap:7px;padding:7px 8px 8px}.kTZJvG_editStepHeader{cursor:pointer;text-align:left;background:0 0;border:none;justify-content:space-between;align-items:center;gap:8px;width:100%;min-width:0;padding:0;display:flex}.kTZJvG_editStepHeader .kTZJvG_editStepId{flex:1;min-width:0}.kTZJvG_editStepHeader:hover .kTZJvG_editStepId{color:var(--dsw-alias-label-primary)}.kTZJvG_editBody{flex-direction:column;gap:7px;display:flex}.kTZJvG_editRemoveRow{justify-content:flex-end;display:flex}.kTZJvG_step[data-editing][data-open=true] .kTZJvG_stepCaret{transform:rotate(180deg)}.kTZJvG_editBoard{flex-direction:column;gap:7px;display:flex}.kTZJvG_timeoutHint{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}.kTZJvG_timeoutBadge{background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 12%, transparent);color:var(--dsw-alias-state-warning-primary);border-radius:999px;align-self:flex-start;align-items:center;padding:1px 8px;font-size:9.5px;font-weight:700;line-height:16px;display:inline-flex}.kTZJvG_eurekaBadge{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);color:var(--dsw-alias-state-business-primary);border-radius:999px;align-self:flex-start;align-items:center;gap:4px;padding:1px 8px;font-size:9.5px;font-weight:700;line-height:16px;display:inline-flex}.kTZJvG_eurekaBadgeOn{letter-spacing:.02em}.kTZJvG_eurekaBadgeZh{color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 78%, var(--dsw-alias-label-tertiary));font-weight:600}.kTZJvG_eurekaRow{border:1px solid var(--dsw-alias-line-normal);background:color-mix(in srgb, var(--dsw-alias-bg-module) 40%, transparent);cursor:pointer;border-radius:8px;align-items:flex-start;gap:8px;padding:7px 8px;display:flex}.kTZJvG_eurekaRow:hover{border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, var(--dsw-alias-line-normal))}.kTZJvG_eurekaCheckbox{width:15px;height:15px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;flex:none;margin:1px 0 0}.kTZJvG_eurekaText{flex-direction:column;gap:1px;min-width:0;display:flex}.kTZJvG_eurekaName{color:var(--dsw-alias-label-primary);font-size:11px;font-weight:700;line-height:15px}.kTZJvG_eurekaDesc{color:var(--dsw-alias-label-tertiary);font-size:9.5px;line-height:14px}.kTZJvG_optionToggles{flex-direction:column;gap:6px;display:flex}.kTZJvG_eurekaToggle{border:1px solid var(--dsw-alias-line-normal);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, transparent);cursor:pointer;border-radius:8px;justify-content:space-between;align-items:center;gap:10px;padding:7px 10px;display:flex}.kTZJvG_eurekaToggle:hover{border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, var(--dsw-alias-line-normal))}.kTZJvG_eurekaToggleLabel{min-width:0;color:var(--dsw-alias-label-primary);flex-direction:column;gap:1px;font-size:11px;font-weight:700;line-height:15px;display:flex}.kTZJvG_eurekaToggleSub{color:var(--dsw-alias-label-tertiary);font-size:9.5px;font-weight:400;line-height:14px}.kTZJvG_eurekaSwitch{border:1px solid var(--dsw-alias-line-strong);background:color-mix(in srgb, var(--dsw-alias-bg-module) 60%, transparent);cursor:pointer;border-radius:999px;flex:none;width:34px;height:20px;padding:0;transition:background .16s,border-color .16s;position:relative}.kTZJvG_eurekaSwitch:disabled{opacity:.55;cursor:not-allowed}.kTZJvG_eurekaSwitch[data-on]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}.kTZJvG_eurekaKnob{background:#fff;border-radius:50%;width:14px;height:14px;transition:transform .16s;position:absolute;top:2px;left:2px;box-shadow:0 1px 2px #00000047}.kTZJvG_eurekaSwitch[data-on] .kTZJvG_eurekaKnob{transform:translate(14px)}";
		const tagId = "dsh-dai-mobius/MobiusActivityPanel.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-dai-mobius";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var MobiusActivityPanel_module_css_default = {
			"addStepBtn": "kTZJvG_addStepBtn",
			"badge": "kTZJvG_badge",
			"badgeCount": "kTZJvG_badgeCount",
			"badgeDot": "kTZJvG_badgeDot",
			"badgeText": "kTZJvG_badgeText",
			"bar": "kTZJvG_bar",
			"barFill": "kTZJvG_barFill",
			"barShimmer": "kTZJvG_barShimmer",
			"card": "kTZJvG_card",
			"conclusion": "kTZJvG_conclusion",
			"conclusionBody": "kTZJvG_conclusionBody",
			"editBoard": "kTZJvG_editBoard",
			"editBody": "kTZJvG_editBody",
			"editField": "kTZJvG_editField",
			"editFieldLabel": "kTZJvG_editFieldLabel",
			"editGoal": "kTZJvG_editGoal",
			"editInput": "kTZJvG_editInput",
			"editLabel": "kTZJvG_editLabel",
			"editRemoveBtn": "kTZJvG_editRemoveBtn",
			"editRemoveRow": "kTZJvG_editRemoveRow",
			"editStepHeader": "kTZJvG_editStepHeader",
			"editStepId": "kTZJvG_editStepId",
			"editStepOrdinal": "kTZJvG_editStepOrdinal",
			"editStepTitle": "kTZJvG_editStepTitle",
			"emptyHint": "kTZJvG_emptyHint",
			"eurekaBadge": "kTZJvG_eurekaBadge",
			"eurekaBadgeOn": "kTZJvG_eurekaBadgeOn",
			"eurekaBadgeZh": "kTZJvG_eurekaBadgeZh",
			"eurekaCheckbox": "kTZJvG_eurekaCheckbox",
			"eurekaDesc": "kTZJvG_eurekaDesc",
			"eurekaKnob": "kTZJvG_eurekaKnob",
			"eurekaName": "kTZJvG_eurekaName",
			"eurekaRow": "kTZJvG_eurekaRow",
			"eurekaSwitch": "kTZJvG_eurekaSwitch",
			"eurekaText": "kTZJvG_eurekaText",
			"eurekaToggle": "kTZJvG_eurekaToggle",
			"eurekaToggleLabel": "kTZJvG_eurekaToggleLabel",
			"eurekaToggleSub": "kTZJvG_eurekaToggleSub",
			"exportBackdrop": "kTZJvG_exportBackdrop",
			"exportButton": "kTZJvG_exportButton",
			"exportButtonActive": "kTZJvG_exportButtonActive",
			"exportMenu": "kTZJvG_exportMenu",
			"exportMenuItem": "kTZJvG_exportMenuItem",
			"exportMenuItemDesc": "kTZJvG_exportMenuItemDesc",
			"exportMenuItemIcon": "kTZJvG_exportMenuItemIcon",
			"exportMenuItemText": "kTZJvG_exportMenuItemText",
			"exportMenuItemTitle": "kTZJvG_exportMenuItemTitle",
			"exportWrap": "kTZJvG_exportWrap",
			"failedTag": "kTZJvG_failedTag",
			"goal": "kTZJvG_goal",
			"haltedTag": "kTZJvG_haltedTag",
			"head": "kTZJvG_head",
			"iconButton": "kTZJvG_iconButton",
			"is-completed": "kTZJvG_is-completed",
			"is-failed": "kTZJvG_is-failed",
			"is-halted": "kTZJvG_is-halted",
			"is-running": "kTZJvG_is-running",
			"mobiusBadgeWave": "kTZJvG_mobiusBadgeWave",
			"mobiusBarSweep": "kTZJvG_mobiusBarSweep",
			"mobiusPanelIn": "kTZJvG_mobiusPanelIn",
			"mobiusPctPop": "kTZJvG_mobiusPctPop",
			"mobiusPulse": "kTZJvG_mobiusPulse",
			"mobiusStepPulse": "kTZJvG_mobiusStepPulse",
			"mobiusWave": "kTZJvG_mobiusWave",
			"name": "kTZJvG_name",
			"optionToggles": "kTZJvG_optionToggles",
			"panel": "kTZJvG_panel",
			"panelControls": "kTZJvG_panelControls",
			"panelDot": "kTZJvG_panelDot",
			"panelHead": "kTZJvG_panelHead",
			"panelTitle": "kTZJvG_panelTitle",
			"phase": "kTZJvG_phase",
			"planActions": "kTZJvG_planActions",
			"planBtn": "kTZJvG_planBtn",
			"planBtnDanger": "kTZJvG_planBtnDanger",
			"planBtnPrimary": "kTZJvG_planBtnPrimary",
			"planConfirm": "kTZJvG_planConfirm",
			"planError": "kTZJvG_planError",
			"progress": "kTZJvG_progress",
			"progressPct": "kTZJvG_progressPct",
			"resizeHandle": "kTZJvG_resizeHandle",
			"reviewBanner": "kTZJvG_reviewBanner",
			"reviewFindings": "kTZJvG_reviewFindings",
			"reviewRound": "kTZJvG_reviewRound",
			"reviewText": "kTZJvG_reviewText",
			"runningTag": "kTZJvG_runningTag",
			"stageBlock": "kTZJvG_stageBlock",
			"stageBlockHead": "kTZJvG_stageBlockHead",
			"stageBlockIndex": "kTZJvG_stageBlockIndex",
			"stageBlockName": "kTZJvG_stageBlockName",
			"stageBlockParallel": "kTZJvG_stageBlockParallel",
			"stageBlockSerial": "kTZJvG_stageBlockSerial",
			"stageConnector": "kTZJvG_stageConnector",
			"stageNameEdit": "kTZJvG_stageNameEdit",
			"stageSteps": "kTZJvG_stageSteps",
			"stages": "kTZJvG_stages",
			"statusDot": "kTZJvG_statusDot",
			"step": "kTZJvG_step",
			"stepBody": "kTZJvG_stepBody",
			"stepCaret": "kTZJvG_stepCaret",
			"stepHeader": "kTZJvG_stepHeader",
			"stepName": "kTZJvG_stepName",
			"stepOrdinal": "kTZJvG_stepOrdinal",
			"stepOutput": "kTZJvG_stepOutput",
			"stepTarget": "kTZJvG_stepTarget",
			"stepTitle": "kTZJvG_stepTitle",
			"timeoutBadge": "kTZJvG_timeoutBadge",
			"timeoutHint": "kTZJvG_timeoutHint",
			"waterWaves": "kTZJvG_waterWaves",
			"workflows": "kTZJvG_workflows"
		};
		//#endregion
		//#region lib/client/MobiusActivityPanel.js
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
		/** Mobius-specific storage keys (kept separate so the two panels never collide). */
		const PANEL_LAYOUT_STORAGE_KEY = "dsh-mobius:activity-panel:v1";
		const PANEL_BADGE_OFFSET_STORAGE_KEY = "dsh-mobius:activity-badge-offset:v1";
		/** Grace before the panel collapses once no workflow remains. */
		const AUTOCLOSE_GRACE_MS = 2e3;
		/**
		* Page-settle window after mount: activity restored on page load only shows
		* the collapsed badge, so the panel never yanks the conversation column
		* right after load. New activity after this window auto-expands as usual.
		* Kept short (1s) so the panel appears promptly after loading.
		*/
		const AUTO_OPEN_SETTLE_MS = 1e3;
		/** Root marker shared with the panel CSS while the shell overlay is expanded. */
		const PANEL_OPEN_ATTRIBUTE = "data-mobius-panel-open";
		/** Shared width concession consumed by the conversation root CSS. */
		const PANEL_SHIFT_PROPERTY = "--mobius-panel-shift";
		const PANEL_CONVERSATION_GAP = 14;
		const MOVE_THRESHOLD = 4;
		function initialPanelLayout() {
			if (typeof window === "undefined") return DEFAULT_PANEL_LAYOUT;
			return parsePanelLayout(window.localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY));
		}
		function initialPanelBounds() {
			if (typeof window === "undefined") return {
				width: 1440,
				height: 900,
				anchorRight: 1440
			};
			return {
				width: window.innerWidth,
				height: window.innerHeight,
				anchorRight: window.innerWidth
			};
		}
		/** Phase copy for the collapsed badge and the expanded-panel accent. */
		const MOBIUS_PHASE_LABEL = {
			planning: "规划中",
			running: "运行中",
			completed: "已完成"
		};
		function phaseLabel(phase) {
			return phase === "idle" ? "" : MOBIUS_PHASE_LABEL[phase];
		}
		/** Collapsed badge: an always-visible corner pill while any workflow exists. */
		function CollapsedBadge({ count, phase, busy, offset, onDrag, onDragEnd, onClick, dragging }) {
			const dragRef = (0, react.useRef)(null);
			const handlePointerDown = (event) => {
				if (event.button !== 0) return;
				dragRef.current = {
					pointerId: event.pointerId,
					originX: event.clientX,
					originY: event.clientY,
					startX: offset.x,
					startY: offset.y,
					moved: false
				};
				event.currentTarget.setPointerCapture(event.pointerId);
			};
			const handlePointerMove = (event) => {
				const drag = dragRef.current;
				if (drag === null || drag.pointerId !== event.pointerId) return;
				event.preventDefault();
				const dx = event.clientX - drag.originX;
				const dy = event.clientY - drag.originY;
				if (!drag.moved && Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
				drag.moved = true;
				onDrag({
					x: drag.startX + dx,
					y: drag.startY + dy
				});
			};
			const finishDrag = (event) => {
				const drag = dragRef.current;
				if (drag === null || drag.pointerId !== event.pointerId) return;
				dragRef.current = null;
				if (drag.moved) onDragEnd();
				else onClick();
			};
			return (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: MobiusActivityPanel_module_css_default.badge,
				"data-mobius-collapsed": true,
				"data-phase": phase,
				"data-busy": busy,
				"data-dragging": dragging || void 0,
				style: { transform: `translate(${offset.x}px, ${offset.y}px)` },
				onPointerDown: handlePointerDown,
				onPointerMove: handlePointerMove,
				onPointerUp: finishDrag,
				onPointerCancel: finishDrag,
				"aria-label": `Mobius ${phaseLabel(phase)} ${count} 个工作流`,
				children: [
					(0, react_jsx_runtime.jsx)("span", {
						className: MobiusActivityPanel_module_css_default.badgeDot,
						"data-phase": phase,
						"data-busy": busy,
						"aria-hidden": true
					}),
					(0, react_jsx_runtime.jsxs)("span", {
						className: MobiusActivityPanel_module_css_default.badgeText,
						children: ["Mobius ", phaseLabel(phase)]
					}),
					(0, react_jsx_runtime.jsx)("span", {
						className: MobiusActivityPanel_module_css_default.badgeCount,
						children: count
					})
				]
			});
		}
		/**
		* Group steps by execution stage, preserving order of first appearance.
		* Steps sharing an explicit stage form one group (run concurrently); steps
		* without a stage each stay as a single-step group (implicit sequential stage).
		*/
		/** Render a millisecond duration as a short, human-readable label. */
		function durationLabel(ms) {
			const minutes = ms / 6e4;
			if (minutes >= 1 && Number.isInteger(minutes)) return `${minutes} 分钟`;
			if (minutes >= 1) return `${minutes.toFixed(1)} 分钟`;
			const seconds = ms / 1e3;
			return Number.isInteger(seconds) ? `${seconds} 秒` : `${seconds.toFixed(1)} 秒`;
		}
		/**
		* Group steps by execution stage, preserving order of first appearance.
		* Steps sharing an explicit stage form one group (run concurrently); steps
		* without a stage each stay as a single-step group (implicit sequential stage).
		*/
		function groupStepsByStage(steps) {
			const order = [];
			const byKey = /* @__PURE__ */ new Map();
			for (const step of steps) {
				const key = step.stage !== void 0 && step.stage.trim() !== "" ? step.stage.trim() : `@${step.id}`;
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
			const byKey = /* @__PURE__ */ new Map();
			for (const step of steps) {
				const key = step.stage.trim() !== "" ? step.stage.trim() : `@${step.id}`;
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
				crcTable = /* @__PURE__ */ new Uint32Array(256);
				for (let n = 0; n < 256; n++) {
					let c = n;
					for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 3988292384 ^ c >>> 1 : c >>> 1;
					crcTable[n] = c >>> 0;
				}
			}
			let crc = 4294967295;
			const table = crcTable;
			for (let i = 0; i < data.length; i++) {
				const idx = ((crc ^ (data[i] ?? 0)) & 255) >>> 0;
				crc = crc >>> 8 ^ (table[idx] ?? 0);
			}
			return (crc ^ 4294967295) >>> 0;
		}
		/** Build a STORE-method .zip (no external dependency, no compression) from
		*  UTF-8 text entries. Each entry carries the UTF-8 filename flag so Chinese
		*  paths survive on any unzip implementation. */
		function makeZip(files) {
			const encoder = new TextEncoder();
			const locals = [];
			const centrals = [];
			let offset = 0;
			const flag = 2048;
			for (const file of files) {
				const nameBytes = encoder.encode(file.name);
				const data = encoder.encode(file.content);
				const crc = crc32(data);
				const local = new Uint8Array(30 + nameBytes.length + data.length);
				const view = new DataView(local.buffer);
				view.setUint32(0, 67324752, true);
				view.setUint16(4, 20, true);
				view.setUint16(6, flag, true);
				view.setUint16(8, 0, true);
				view.setUint16(10, 0, true);
				view.setUint16(12, 33, true);
				view.setUint32(14, crc, true);
				view.setUint32(18, data.length, true);
				view.setUint32(22, data.length, true);
				view.setUint16(26, nameBytes.length, true);
				view.setUint16(28, 0, true);
				local.set(nameBytes, 30);
				local.set(data, 30 + nameBytes.length);
				locals.push(local);
				const central = new Uint8Array(46 + nameBytes.length);
				const cview = new DataView(central.buffer);
				cview.setUint32(0, 33639248, true);
				cview.setUint16(4, 20, true);
				cview.setUint16(6, 20, true);
				cview.setUint16(8, flag, true);
				cview.setUint16(10, 0, true);
				cview.setUint16(12, 0, true);
				cview.setUint16(14, 33, true);
				cview.setUint32(16, crc, true);
				cview.setUint32(20, data.length, true);
				cview.setUint32(24, data.length, true);
				cview.setUint16(28, nameBytes.length, true);
				cview.setUint16(30, 0, true);
				cview.setUint16(32, 0, true);
				cview.setUint16(34, 0, true);
				cview.setUint16(36, 0, true);
				cview.setUint32(38, 0, true);
				cview.setUint32(42, offset, true);
				central.set(nameBytes, 46);
				centrals.push({
					bytes: central,
					localOffset: offset
				});
				offset += local.length;
			}
			const centralDirSize = centrals.reduce((sum, e) => sum + e.bytes.length, 0);
			const centralOffset = offset;
			const end = /* @__PURE__ */ new Uint8Array(22);
			const eview = new DataView(end.buffer);
			eview.setUint32(0, 101010256, true);
			eview.setUint16(4, 0, true);
			eview.setUint16(6, 0, true);
			eview.setUint16(8, files.length, true);
			eview.setUint16(10, files.length, true);
			eview.setUint32(12, centralDirSize, true);
			eview.setUint32(16, centralOffset, true);
			eview.setUint16(20, 0, true);
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
			return new Blob([all], { type: "application/zip" });
		}
		/** Compose the SKILL.md for a workflow-derived skill: YAML frontmatter with a
		*  slugged `name` and trigger-rich `description`, then the goal, run options,
		*  ordered step plan, and how-to-run. */
		function buildSkillMd(wf) {
			const slug = wf.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "mobius-workflow";
			const lines = [];
			const goalLine = wf.goal.trim() !== "" ? wf.goal.trim() : wf.name;
			lines.push("---");
			lines.push(`name: ${slug}`);
			lines.push(`description: ${goalLine}。使用顺序研究/分析工作流执行该目标，可导入 mobius 工作流模板运行。`);
			lines.push("---");
			lines.push("");
			lines.push(`# ${wf.name}`);
			lines.push("");
			if (wf.goal.trim() !== "") lines.push("## 目标", "", wf.goal.trim(), "");
			if (wf.eureka === true || wf.disableWebSearch === true || wf.maxStageCount !== void 0 && wf.maxStageCount > 0) {
				lines.push("## 运行选项", "");
				if (wf.eureka === true) lines.push("- 尤里卡模式：运行中的步骤 agent 可主动发现新观点并调整后续步骤。");
				if (wf.disableWebSearch === true) lines.push("- 禁用网页搜索：步骤仅凭自身知识与记忆，不使用 web_search / web_fetch。");
				if (wf.maxStageCount !== void 0 && wf.maxStageCount > 0) lines.push(`- 最大执行阶段数：最多 ${wf.maxStageCount} 个 stage。`);
				lines.push("");
			}
			if (wf.steps.length > 0) {
				lines.push("## 工作流步骤", "");
				wf.steps.forEach((s, i) => {
					const stageNote = s.stage !== void 0 && s.stage.trim() !== "" ? `（阶段：${s.stage}）` : "";
					lines.push(`${i + 1}. **${s.title}**${stageNote}：${s.target}`);
				});
				lines.push("");
			}
			lines.push("## 使用方式", "");
			lines.push("将本目录中的 `workflow.json` 作为 mobius 工作流模板导入，即可按上述步骤顺序执行该研究/分析目标。", "");
			return lines.join("\n");
		}
		/** One step node within a stage: collapsed shows only a concise title; clicking
		*  expands to reveal the full target/output. Keeps the node list scannable. */
		function StepRow({ step, ordinal }) {
			const [open, setOpen] = (0, react.useState)(false);
			const output = step.status === "completed" && step.output !== void 0 && step.output !== "" ? step.output : null;
			const expandable = step.target !== "" && step.target !== void 0 || output !== null;
			return (0, react_jsx_runtime.jsxs)("li", {
				className: `${MobiusActivityPanel_module_css_default.step} ${MobiusActivityPanel_module_css_default[`is-${step.status}`]}`,
				"data-step-id": step.id,
				"data-status": step.status,
				"data-open": open || void 0,
				children: [(0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: MobiusActivityPanel_module_css_default.stepHeader,
					onClick: () => {
						if (expandable) setOpen((v) => !v);
					},
					disabled: !expandable,
					"aria-expanded": open,
					children: [
						(0, react_jsx_runtime.jsx)("span", {
							className: MobiusActivityPanel_module_css_default.statusDot,
							"aria-hidden": true,
							children: step.status === "completed" && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline14, {})
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: MobiusActivityPanel_module_css_default.stepOrdinal,
							children: ordinal
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: MobiusActivityPanel_module_css_default.stepName,
							children: step.title
						}),
						step.status === "running" && (0, react_jsx_runtime.jsx)("span", {
							className: MobiusActivityPanel_module_css_default.runningTag,
							children: "运行中"
						}),
						step.status === "halted" && (0, react_jsx_runtime.jsx)("span", {
							className: MobiusActivityPanel_module_css_default.haltedTag,
							children: "已中断"
						}),
						step.status === "failed" && (0, react_jsx_runtime.jsx)("span", {
							className: MobiusActivityPanel_module_css_default.failedTag,
							children: "已失败"
						}),
						expandable && (0, react_jsx_runtime.jsx)("span", {
							className: MobiusActivityPanel_module_css_default.stepCaret,
							"aria-hidden": true,
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
						})
					]
				}), open && expandable && (0, react_jsx_runtime.jsxs)("div", {
					className: MobiusActivityPanel_module_css_default.stepBody,
					children: [step.target !== "" && step.target !== void 0 && (0, react_jsx_runtime.jsx)("div", {
						className: MobiusActivityPanel_module_css_default.stepTarget,
						children: step.target
					}), output !== null && (0, react_jsx_runtime.jsx)("div", {
						className: MobiusActivityPanel_module_css_default.stepOutput,
						children: output
					})]
				})]
			});
		}
		/** Per-step edit fields shown while the staged plan is being edited in place.
		*  Nodes start collapsed (open = false) so the timeline stays scannable; each
		*  header row toggles the form open/closed. */
		function StepEditorRow({ stepId, ordinal, values, onChange, onRemove }) {
			const [open, setOpen] = (0, react.useState)(false);
			return (0, react_jsx_runtime.jsxs)("li", {
				className: MobiusActivityPanel_module_css_default.step,
				"data-step-id": stepId,
				"data-editing": true,
				"data-open": open || void 0,
				children: [(0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: MobiusActivityPanel_module_css_default.editStepHeader,
					onClick: () => {
						setOpen((v) => !v);
					},
					"aria-expanded": open,
					children: [(0, react_jsx_runtime.jsxs)("span", {
						className: MobiusActivityPanel_module_css_default.editStepId,
						children: [(0, react_jsx_runtime.jsxs)("span", {
							className: MobiusActivityPanel_module_css_default.editStepOrdinal,
							children: ["步骤 ", ordinal]
						}), (0, react_jsx_runtime.jsx)("span", {
							className: MobiusActivityPanel_module_css_default.editStepTitle,
							children: values.title.trim() !== "" ? values.title : stepId
						})]
					}), (0, react_jsx_runtime.jsx)("span", {
						className: MobiusActivityPanel_module_css_default.stepCaret,
						"aria-hidden": true,
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
					})]
				}), open && (0, react_jsx_runtime.jsxs)("div", {
					className: MobiusActivityPanel_module_css_default.editBody,
					children: [
						(0, react_jsx_runtime.jsx)("div", {
							className: MobiusActivityPanel_module_css_default.editRemoveRow,
							children: (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: MobiusActivityPanel_module_css_default.editRemoveBtn,
								onClick: () => {
									onRemove(stepId);
								},
								title: "删除此步骤",
								"aria-label": "删除此步骤",
								children: "删除"
							})
						}),
						(0, react_jsx_runtime.jsxs)("label", {
							className: MobiusActivityPanel_module_css_default.editField,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: MobiusActivityPanel_module_css_default.editFieldLabel,
								children: "标题"
							}), (0, react_jsx_runtime.jsx)("input", {
								className: MobiusActivityPanel_module_css_default.editInput,
								value: values.title,
								onChange: (e) => {
									onChange(stepId, "title", e.target.value);
								}
							})]
						}),
						(0, react_jsx_runtime.jsxs)("label", {
							className: MobiusActivityPanel_module_css_default.editField,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: MobiusActivityPanel_module_css_default.editFieldLabel,
								children: "目标"
							}), (0, react_jsx_runtime.jsx)("textarea", {
								className: MobiusActivityPanel_module_css_default.editInput,
								value: values.target,
								onChange: (e) => {
									onChange(stepId, "target", e.target.value);
								},
								rows: 2
							})]
						}),
						(0, react_jsx_runtime.jsxs)("label", {
							className: MobiusActivityPanel_module_css_default.editField,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: MobiusActivityPanel_module_css_default.editFieldLabel,
								children: "阶段"
							}), (0, react_jsx_runtime.jsx)("input", {
								className: MobiusActivityPanel_module_css_default.editInput,
								value: values.stage,
								onChange: (e) => {
									onChange(stepId, "stage", e.target.value);
								},
								placeholder: "（留空为顺序执行）"
							})]
						})
					]
				})]
			});
		}
		/** POST one staged-plan action to the host plan route. */
		async function mutatePlan(payload) {
			const response = await fetch("/plugins/dsh-mobius/plan", {
				method: "POST",
				cache: "no-store",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			if (response.ok) return;
			let message = `HTTP ${response.status}`;
			try {
				const body = await response.json();
				if (typeof body.error === "string" && body.error.trim() !== "") message = body.error;
			} catch {}
			throw new Error(message);
		}
		/** One workflow card: goal + ordered step timeline + staged-plan review actions. */
		function WorkflowCard({ workflow, captainSessionId }) {
			const done = workflow.steps.filter((s) => s.status === "completed").length;
			const pct = workflow.steps.length === 0 ? 0 : Math.round(done / workflow.steps.length * 100);
			const phaseLabel = workflow.phase === "staged" ? "已规划" : workflow.phase === "done" ? "已完成" : "进行中";
			const [busy, setBusy] = (0, react.useState)(false);
			const [discardArmed, setDiscardArmed] = (0, react.useState)(false);
			const [editing, setEditing] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)("");
			const [exportOpen, setExportOpen] = (0, react.useState)(false);
			const exportRef = (0, react.useRef)(null);
			const [cardEureka, setCardEureka] = (0, react.useState)(workflow.eureka === true);
			const [cardWebSearchOn, setCardWebSearchOn] = (0, react.useState)(workflow.disableWebSearch !== true);
			(0, react.useEffect)(() => {
				setCardEureka(workflow.eureka === true);
				setCardWebSearchOn(workflow.disableWebSearch !== true);
			}, [workflow.eureka, workflow.disableWebSearch]);
			const staged = workflow.phase === "staged";
			const running = workflow.phase === "running";
			const runAction = async (action) => {
				if (busy) return;
				setBusy(true);
				setError("");
				try {
					await mutatePlan({
						sessionId: captainSessionId,
						workflowId: workflow.id,
						action
					});
					setDiscardArmed(false);
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					setBusy(false);
				}
			};
			const [draftGoal, setDraftGoal] = (0, react.useState)(workflow.goal);
			const [draftTimeout, setDraftTimeout] = (0, react.useState)(workflow.timeoutMs !== void 0 && workflow.timeoutMs > 0 ? String(workflow.timeoutMs) : "");
			const [draftEureka, setDraftEureka] = (0, react.useState)(workflow.eureka === true);
			const [draftDisableWebSearch, setDraftDisableWebSearch] = (0, react.useState)(workflow.disableWebSearch === true);
			const [draftMaxStageCount, setDraftMaxStageCount] = (0, react.useState)(workflow.maxStageCount !== void 0 && workflow.maxStageCount > 0 ? String(workflow.maxStageCount) : "");
			const [draftStageTitles, setDraftStageTitles] = (0, react.useState)(() => ({ ...workflow.stageTitles ?? {} }));
			const [draftSteps, setDraftSteps] = (0, react.useState)(() => workflow.steps.map((step) => ({
				id: step.id,
				title: step.title,
				target: step.target,
				context: step.context ?? "",
				stage: step.stage ?? ""
			})));
			const newStepCounter = (0, react.useRef)(0);
			const addStepToStage = (stageKey) => {
				const tempId = `__new${++newStepCounter.current}`;
				setDraftSteps((prev) => [...prev, {
					id: tempId,
					title: "",
					target: "",
					context: "",
					stage: stageKey
				}]);
			};
			const removeStep = (id) => {
				setDraftSteps((prev) => prev.filter((step) => step.id !== id));
			};
			const setStepField = (id, field, value) => {
				setDraftSteps((prev) => prev.map((step) => step.id === id ? {
					...step,
					[field]: value
				} : step));
			};
			const beginEdit = () => {
				newStepCounter.current = 0;
				setDraftGoal(workflow.goal);
				setDraftTimeout(workflow.timeoutMs !== void 0 && workflow.timeoutMs > 0 ? String(workflow.timeoutMs) : "");
				setDraftEureka(workflow.eureka === true);
				setDraftDisableWebSearch(workflow.disableWebSearch === true);
				setDraftMaxStageCount(workflow.maxStageCount !== void 0 && workflow.maxStageCount > 0 ? String(workflow.maxStageCount) : "");
				setDraftStageTitles({ ...workflow.stageTitles ?? {} });
				setDraftSteps(workflow.steps.map((step) => ({
					id: step.id,
					title: step.title,
					target: step.target,
					context: step.context ?? "",
					stage: step.stage ?? ""
				})));
				setError("");
				setEditing(true);
			};
			const saveEdit = async () => {
				if (busy) return;
				setBusy(true);
				setError("");
				const timeoutNum = draftTimeout.trim() === "" ? void 0 : Number(draftTimeout.trim());
				if (draftTimeout.trim() !== "" && (!Number.isFinite(timeoutNum) || timeoutNum <= 0)) {
					setError("超时时长必须为正整数（毫秒）");
					setBusy(false);
					return;
				}
				const maxStageNum = draftMaxStageCount.trim() === "" ? void 0 : Number(draftMaxStageCount.trim());
				if (draftMaxStageCount.trim() !== "" && (!Number.isFinite(maxStageNum) || maxStageNum < 0)) {
					setError("最大 stage 数必须为非负整数（0 表示不限制）");
					setBusy(false);
					return;
				}
				const existingSteps = draftSteps.filter((step) => !step.id.startsWith("__new"));
				const newSteps = draftSteps.filter((step) => step.id.startsWith("__new"));
				const originalIds = new Set(workflow.steps.map((step) => step.id));
				const keptIds = new Set(existingSteps.map((step) => step.id));
				const removeStepIds = [...originalIds].filter((id) => !keptIds.has(id));
				for (const step of newSteps) if (step.title.trim() === "" || step.target.trim() === "") {
					setError("新增步骤需要填写标题和目标");
					setBusy(false);
					return;
				}
				try {
					await mutatePlan({
						sessionId: captainSessionId,
						workflowId: workflow.id,
						action: "update",
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
							stage: step.stage
						})),
						addSteps: newSteps.map((step) => ({
							title: step.title,
							target: step.target,
							context: step.context,
							stage: step.stage
						})),
						removeStepIds
					});
					setEditing(false);
					setDiscardArmed(false);
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					setBusy(false);
				}
			};
			const toggleWebSearch = async () => {
				if (busy) return;
				const nextOn = !cardWebSearchOn;
				setCardWebSearchOn(nextOn);
				setBusy(true);
				setError("");
				try {
					await mutatePlan({
						sessionId: captainSessionId,
						workflowId: workflow.id,
						action: "update",
						disableWebSearch: !nextOn
					});
				} catch (e) {
					setCardWebSearchOn(!nextOn);
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					setBusy(false);
				}
			};
			const toggleEureka = async () => {
				if (busy) return;
				const nextOn = !cardEureka;
				setCardEureka(nextOn);
				setBusy(true);
				setError("");
				try {
					await mutatePlan({
						sessionId: captainSessionId,
						workflowId: workflow.id,
						action: "update",
						eureka: nextOn
					});
				} catch (e) {
					setCardEureka(!nextOn);
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					setBusy(false);
				}
			};
			const download = async () => {
				if (captainSessionId === "") return;
				try {
					const response = await fetch(`/plugins/dsh-mobius/export?sessionId=${encodeURIComponent(captainSessionId)}&workflowId=${encodeURIComponent(workflow.id)}`, { cache: "no-store" });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const text = await response.text();
					const name = workflow.name.replace(/[^\w.-]+/g, "_") || "workflow";
					const blob = new Blob([text], { type: "application/json" });
					const url = URL.createObjectURL(blob);
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = `${name}.mobius.json`;
					document.body.appendChild(anchor);
					anchor.click();
					anchor.remove();
					URL.revokeObjectURL(url);
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				}
			};
			const downloadSkill = async () => {
				if (captainSessionId === "") return;
				try {
					const response = await fetch(`/plugins/dsh-mobius/export?sessionId=${encodeURIComponent(captainSessionId)}&workflowId=${encodeURIComponent(workflow.id)}`, { cache: "no-store" });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const workflowJson = await response.text();
					const folder = workflow.name.replace(/[^\w.-]+/g, "_") || "workflow";
					const zip = makeZip([{
						name: `${folder}/SKILL.md`,
						content: buildSkillMd(workflow)
					}, {
						name: `${folder}/workflow.json`,
						content: workflowJson
					}]);
					const url = URL.createObjectURL(zip);
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = `${folder}.skill.zip`;
					document.body.appendChild(anchor);
					anchor.click();
					anchor.remove();
					URL.revokeObjectURL(url);
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				}
			};
			return (0, react_jsx_runtime.jsxs)("section", {
				className: MobiusActivityPanel_module_css_default.card,
				"data-workflow-id": workflow.id,
				"data-phase": workflow.phase,
				children: [
					(0, react_jsx_runtime.jsxs)("header", {
						className: MobiusActivityPanel_module_css_default.head,
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: MobiusActivityPanel_module_css_default.name,
								title: workflow.name,
								children: workflow.name
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: MobiusActivityPanel_module_css_default.phase,
								children: phaseLabel
							}),
							(0, react_jsx_runtime.jsxs)("span", {
								className: MobiusActivityPanel_module_css_default.progress,
								title: `已完成 ${done} / ${workflow.steps.length} 步`,
								children: [
									done,
									"/",
									workflow.steps.length,
									" ",
									(0, react_jsx_runtime.jsxs)("span", {
										className: MobiusActivityPanel_module_css_default.progressPct,
										children: [pct, "%"]
									}, pct)
								]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: MobiusActivityPanel_module_css_default.exportWrap,
								ref: exportRef,
								children: [(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: `${MobiusActivityPanel_module_css_default.exportButton} ${exportOpen ? MobiusActivityPanel_module_css_default.exportButtonActive : ""}`,
									onClick: () => {
										setExportOpen((v) => !v);
									},
									"aria-label": "导出或制作 skill",
									title: "导出工作流或制作 skill",
									"aria-haspopup": "menu",
									"aria-expanded": exportOpen,
									children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, {})
								}), exportOpen && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("div", {
									className: MobiusActivityPanel_module_css_default.exportBackdrop,
									onClick: () => {
										setExportOpen(false);
									}
								}), (0, react_jsx_runtime.jsxs)("div", {
									className: MobiusActivityPanel_module_css_default.exportMenu,
									role: "menu",
									children: [(0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										role: "menuitem",
										className: MobiusActivityPanel_module_css_default.exportMenuItem,
										onClick: () => {
											setExportOpen(false);
											download();
										},
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: MobiusActivityPanel_module_css_default.exportMenuItemIcon,
											children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, {})
										}), (0, react_jsx_runtime.jsxs)("span", {
											className: MobiusActivityPanel_module_css_default.exportMenuItemText,
											children: [(0, react_jsx_runtime.jsx)("span", {
												className: MobiusActivityPanel_module_css_default.exportMenuItemTitle,
												children: "导出工作流"
											}), (0, react_jsx_runtime.jsx)("span", {
												className: MobiusActivityPanel_module_css_default.exportMenuItemDesc,
												children: ".mobius.json 模板"
											})]
										})]
									}), (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										role: "menuitem",
										className: MobiusActivityPanel_module_css_default.exportMenuItem,
										onClick: () => {
											setExportOpen(false);
											downloadSkill();
										},
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: MobiusActivityPanel_module_css_default.exportMenuItemIcon,
											children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSkillOutline16, {})
										}), (0, react_jsx_runtime.jsxs)("span", {
											className: MobiusActivityPanel_module_css_default.exportMenuItemText,
											children: [(0, react_jsx_runtime.jsx)("span", {
												className: MobiusActivityPanel_module_css_default.exportMenuItemTitle,
												children: "制作 skill"
											}), (0, react_jsx_runtime.jsx)("span", {
												className: MobiusActivityPanel_module_css_default.exportMenuItemDesc,
												children: "SKILL.md + workflow.json 的 zip"
											})]
										})]
									})]
								})] })]
							})
						]
					}),
					staged && editing ? (0, react_jsx_runtime.jsxs)("div", {
						className: MobiusActivityPanel_module_css_default.editBoard,
						children: [
							(0, react_jsx_runtime.jsxs)("label", {
								className: MobiusActivityPanel_module_css_default.editField,
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: MobiusActivityPanel_module_css_default.editFieldLabel,
									children: "目标"
								}), (0, react_jsx_runtime.jsx)("textarea", {
									className: MobiusActivityPanel_module_css_default.editInput,
									value: draftGoal,
									onChange: (e) => {
										setDraftGoal(e.target.value);
									},
									rows: 2
								})]
							}),
							(0, react_jsx_runtime.jsxs)("label", {
								className: MobiusActivityPanel_module_css_default.editField,
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: MobiusActivityPanel_module_css_default.editFieldLabel,
									children: "单步超时（毫秒，留空用全局默认）"
								}), (0, react_jsx_runtime.jsx)("input", {
									className: MobiusActivityPanel_module_css_default.editInput,
									value: draftTimeout,
									onChange: (e) => {
										setDraftTimeout(e.target.value);
									},
									inputMode: "numeric",
									placeholder: "例如 600000（10 分钟）"
								})]
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: MobiusActivityPanel_module_css_default.timeoutHint,
								children: "每个步骤超过此时长未完成即判定失败并停止流水线（不自动重试）。"
							}),
							(0, react_jsx_runtime.jsxs)("label", {
								className: MobiusActivityPanel_module_css_default.editField,
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: MobiusActivityPanel_module_css_default.editFieldLabel,
									children: "最大 stage 数（留空为不限制）"
								}), (0, react_jsx_runtime.jsx)("input", {
									className: MobiusActivityPanel_module_css_default.editInput,
									value: draftMaxStageCount,
									onChange: (e) => {
										setDraftMaxStageCount(e.target.value);
									},
									inputMode: "numeric",
									placeholder: "例如 5（0 或留空表示不限制）"
								})]
							}),
							(0, react_jsx_runtime.jsxs)("label", {
								className: MobiusActivityPanel_module_css_default.eurekaRow,
								children: [(0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									className: MobiusActivityPanel_module_css_default.eurekaCheckbox,
									checked: draftEureka,
									onChange: (e) => {
										setDraftEureka(e.target.checked);
									}
								}), (0, react_jsx_runtime.jsxs)("span", {
									className: MobiusActivityPanel_module_css_default.eurekaText,
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: MobiusActivityPanel_module_css_default.eurekaName,
										children: "尤里卡模式（Eureka）"
									}), (0, react_jsx_runtime.jsx)("span", {
										className: MobiusActivityPanel_module_css_default.eurekaDesc,
										children: "开启后，让正在研究的步骤 agent 能主动发现新问题、新增或调整后面还没开始的步骤，适合开放式、需要灵活深挖的研究（默认关闭）"
									})]
								})]
							}),
							(0, react_jsx_runtime.jsxs)("label", {
								className: MobiusActivityPanel_module_css_default.eurekaRow,
								children: [(0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									className: MobiusActivityPanel_module_css_default.eurekaCheckbox,
									checked: !draftDisableWebSearch,
									onChange: (e) => {
										setDraftDisableWebSearch(!e.target.checked);
									}
								}), (0, react_jsx_runtime.jsxs)("span", {
									className: MobiusActivityPanel_module_css_default.eurekaText,
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: MobiusActivityPanel_module_css_default.eurekaName,
										children: "启用网页搜索"
									}), (0, react_jsx_runtime.jsx)("span", {
										className: MobiusActivityPanel_module_css_default.eurekaDesc,
										children: "步骤 agent 可使用 web_search / web_fetch 联网检索最新信息"
									})]
								})]
							})
						]
					}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						workflow.goal !== "" && (0, react_jsx_runtime.jsx)("div", {
							className: MobiusActivityPanel_module_css_default.goal,
							children: workflow.goal
						}),
						workflow.timeoutMs !== void 0 && workflow.timeoutMs > 0 && (0, react_jsx_runtime.jsxs)("div", {
							className: MobiusActivityPanel_module_css_default.timeoutBadge,
							title: `每个步骤 ${durationLabel(workflow.timeoutMs)} 未完成即失败`,
							children: ["单步超时 ", durationLabel(workflow.timeoutMs)]
						}),
						workflow.maxStageCount !== void 0 && workflow.maxStageCount > 0 && (0, react_jsx_runtime.jsxs)("div", {
							className: MobiusActivityPanel_module_css_default.timeoutBadge,
							title: `整个工作流最多 ${workflow.maxStageCount} 个执行阶段`,
							children: [
								"最多 ",
								workflow.maxStageCount,
								" 个 stage"
							]
						}),
						staged ? (0, react_jsx_runtime.jsxs)("div", {
							className: MobiusActivityPanel_module_css_default.optionToggles,
							children: [(0, react_jsx_runtime.jsxs)("label", {
								className: MobiusActivityPanel_module_css_default.eurekaToggle,
								title: "尤里卡模式：让正在研究的步骤 agent 能主动发现新问题、新增或调整后面还没开始的步骤，适合开放式研究",
								children: [(0, react_jsx_runtime.jsxs)("span", {
									className: MobiusActivityPanel_module_css_default.eurekaToggleLabel,
									children: [(0, react_jsx_runtime.jsx)("span", { children: "尤里卡模式" }), (0, react_jsx_runtime.jsx)("span", {
										className: MobiusActivityPanel_module_css_default.eurekaToggleSub,
										children: cardEureka ? "启用中：agent 可自动调整后续步骤" : "已关闭：按预定步骤顺序执行"
									})]
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "switch",
									"aria-checked": cardEureka,
									className: MobiusActivityPanel_module_css_default.eurekaSwitch,
									"data-on": cardEureka || void 0,
									disabled: busy,
									onClick: () => {
										toggleEureka();
									},
									children: (0, react_jsx_runtime.jsx)("span", { className: MobiusActivityPanel_module_css_default.eurekaKnob })
								})]
							}), (0, react_jsx_runtime.jsxs)("label", {
								className: MobiusActivityPanel_module_css_default.eurekaToggle,
								title: "启用网页搜索：步骤 agent 可使用 web_search / web_fetch 联网检索",
								children: [(0, react_jsx_runtime.jsxs)("span", {
									className: MobiusActivityPanel_module_css_default.eurekaToggleLabel,
									children: [(0, react_jsx_runtime.jsx)("span", { children: "启用网页搜索" }), (0, react_jsx_runtime.jsx)("span", {
										className: MobiusActivityPanel_module_css_default.eurekaToggleSub,
										children: cardWebSearchOn ? "步骤可使用 web_search / web_fetch" : "步骤仅凭自身知识与记忆"
									})]
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "switch",
									"aria-checked": cardWebSearchOn,
									className: MobiusActivityPanel_module_css_default.eurekaSwitch,
									"data-on": cardWebSearchOn || void 0,
									disabled: busy,
									onClick: () => {
										toggleWebSearch();
									},
									children: (0, react_jsx_runtime.jsx)("span", { className: MobiusActivityPanel_module_css_default.eurekaKnob })
								})]
							})]
						}) : workflow.eureka === true && (0, react_jsx_runtime.jsxs)("div", {
							className: MobiusActivityPanel_module_css_default.eurekaBadge,
							title: "尤里卡模式已开启：运行中的步骤 agent 可主动填补遗漏、分割或精简尚未开始的后续步骤",
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: MobiusActivityPanel_module_css_default.eurekaBadgeOn,
								children: "尤里卡模式启用中"
							}), (0, react_jsx_runtime.jsx)("span", {
								className: MobiusActivityPanel_module_css_default.eurekaBadgeZh,
								children: "· 步骤会随研究推进自动优化"
							})]
						})
					] }),
					(0, react_jsx_runtime.jsx)("div", {
						className: MobiusActivityPanel_module_css_default.bar,
						role: "progressbar",
						"aria-valuenow": pct,
						"aria-valuemin": 0,
						"aria-valuemax": 100,
						"aria-valuetext": `${pct}%`,
						children: (0, react_jsx_runtime.jsx)("div", {
							className: MobiusActivityPanel_module_css_default.barFill,
							style: { width: `${pct}%` },
							children: (0, react_jsx_runtime.jsx)("span", { className: MobiusActivityPanel_module_css_default.barShimmer })
						})
					}),
					(workflow.steps.length > 0 || staged && editing) && (() => {
						const groups = staged && editing ? groupDraftSteps(draftSteps) : groupStepsByStage(workflow.steps);
						return (0, react_jsx_runtime.jsx)("ol", {
							className: MobiusActivityPanel_module_css_default.stages,
							children: groups.flatMap((group, groupIndex) => {
								const first = group[0];
								const hasStageName = first?.stage !== void 0 && first.stage.trim() !== "";
								const stageKey = hasStageName ? first.stage.trim() : first?.id !== void 0 ? `@${first.id}` : "";
								const fallbackName = hasStageName ? first.stage.trim() : `阶段 ${groupIndex + 1}`;
								const summary = (staged && editing ? draftStageTitles : workflow.stageTitles)?.[stageKey] ?? "";
								const stageName = summary !== "" ? summary : fallbackName;
								const parallel = group.length > 1;
								const editingThis = staged && editing;
								const stage = (0, react_jsx_runtime.jsxs)("li", {
									className: MobiusActivityPanel_module_css_default.stageBlock,
									"data-stage": first?.stage,
									children: [
										(0, react_jsx_runtime.jsxs)("div", {
											className: MobiusActivityPanel_module_css_default.stageBlockHead,
											children: [
												(0, react_jsx_runtime.jsx)("span", {
													className: MobiusActivityPanel_module_css_default.stageBlockIndex,
													children: groupIndex + 1
												}),
												editingThis ? (0, react_jsx_runtime.jsx)("input", {
													className: MobiusActivityPanel_module_css_default.stageNameEdit,
													value: summary,
													placeholder: fallbackName,
													onChange: (e) => {
														const value = e.target.value;
														setDraftStageTitles((prev) => {
															const next = { ...prev };
															if (value.trim() === "") delete next[stageKey];
															else next[stageKey] = value;
															return next;
														});
													},
													"aria-label": `阶段 ${groupIndex + 1} 概括名`
												}) : (0, react_jsx_runtime.jsx)("span", {
													className: MobiusActivityPanel_module_css_default.stageBlockName,
													children: stageName
												}),
												parallel ? (0, react_jsx_runtime.jsxs)("span", {
													className: MobiusActivityPanel_module_css_default.stageBlockParallel,
													children: [group.length, " 步并行"]
												}) : (0, react_jsx_runtime.jsx)("span", {
													className: MobiusActivityPanel_module_css_default.stageBlockSerial,
													children: "单步"
												})
											]
										}),
										(0, react_jsx_runtime.jsx)("ol", {
											className: MobiusActivityPanel_module_css_default.stageSteps,
											children: group.map((step, stepIndex) => editingThis ? (0, react_jsx_runtime.jsx)(StepEditorRow, {
												stepId: step.id,
												ordinal: stepIndex + 1,
												values: step,
												onChange: setStepField,
												onRemove: removeStep
											}, step.id) : (0, react_jsx_runtime.jsx)(StepRow, {
												step,
												ordinal: stepIndex + 1
											}, step.id))
										}),
										editingThis && (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: MobiusActivityPanel_module_css_default.addStepBtn,
											onClick: () => {
												addStepToStage(stageKey);
											},
											children: "＋ 添加步骤"
										})
									]
								}, `stage${groupIndex}`);
								return groupIndex === 0 ? [stage] : [(0, react_jsx_runtime.jsx)("li", {
									className: MobiusActivityPanel_module_css_default.stageConnector,
									"aria-hidden": true
								}, `conn${groupIndex}`), stage];
							})
						});
					})(),
					workflow.review !== void 0 && workflow.review.status === "needs_revision" && (0, react_jsx_runtime.jsx)("div", {
						className: MobiusActivityPanel_module_css_default.reviewBanner,
						"data-rejected": true,
						children: (0, react_jsx_runtime.jsxs)("div", {
							className: MobiusActivityPanel_module_css_default.reviewText,
							children: [(0, react_jsx_runtime.jsxs)("span", {
								className: MobiusActivityPanel_module_css_default.reviewRound,
								children: [
									"第 ",
									workflow.review.round,
									" 轮审核未通过"
								]
							}), (0, react_jsx_runtime.jsx)("span", {
								className: MobiusActivityPanel_module_css_default.reviewFindings,
								children: workflow.review.findings
							})]
						})
					}),
					workflow.review !== void 0 && workflow.review.status === "awaiting_review" && workflow.phase === "running" && (0, react_jsx_runtime.jsx)("div", {
						className: MobiusActivityPanel_module_css_default.reviewBanner,
						"data-pending": true,
						children: (0, react_jsx_runtime.jsxs)("span", {
							className: MobiusActivityPanel_module_css_default.reviewRound,
							children: [
								"审核中（第 ",
								workflow.review.round,
								" 轮）"
							]
						})
					}),
					workflow.review !== void 0 && workflow.review.status === "passed" && (0, react_jsx_runtime.jsx)("div", {
						className: MobiusActivityPanel_module_css_default.reviewBanner,
						"data-passed": true,
						children: (0, react_jsx_runtime.jsx)("span", {
							className: MobiusActivityPanel_module_css_default.reviewRound,
							children: "最终结论审核通过"
						})
					}),
					workflow.conclusion !== void 0 && workflow.conclusion !== "" && workflow.phase === "done" && (0, react_jsx_runtime.jsxs)("details", {
						className: MobiusActivityPanel_module_css_default.conclusion,
						children: [(0, react_jsx_runtime.jsx)("summary", { children: "最终结论" }), (0, react_jsx_runtime.jsx)("div", {
							className: MobiusActivityPanel_module_css_default.conclusionBody,
							children: workflow.conclusion
						})]
					}),
					staged && (0, react_jsx_runtime.jsxs)("div", {
						className: MobiusActivityPanel_module_css_default.planActions,
						"data-armed": discardArmed || void 0,
						children: [discardArmed ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: MobiusActivityPanel_module_css_default.planConfirm,
								children: "确认丢弃这个计划？"
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: MobiusActivityPanel_module_css_default.planBtn,
								disabled: busy,
								onClick: () => {
									setDiscardArmed(false);
								},
								children: "取消"
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: MobiusActivityPanel_module_css_default.planBtnDanger,
								disabled: busy,
								onClick: () => {
									runAction("discard");
								},
								children: busy ? "丢弃中…" : "确认丢弃"
							})
						] }) : editing ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: MobiusActivityPanel_module_css_default.planBtnPrimary,
							disabled: busy,
							onClick: () => {
								saveEdit();
							},
							children: busy ? "保存中…" : "保存修改"
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: MobiusActivityPanel_module_css_default.planBtn,
							disabled: busy,
							onClick: () => {
								setEditing(false);
								setError("");
							},
							children: "取消"
						})] }) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: MobiusActivityPanel_module_css_default.planBtnPrimary,
								disabled: busy,
								onClick: () => {
									runAction("approve");
								},
								children: busy ? "启动中…" : "启动"
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: MobiusActivityPanel_module_css_default.planBtn,
								disabled: busy,
								onClick: () => {
									beginEdit();
								},
								children: "编辑计划"
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: MobiusActivityPanel_module_css_default.planBtn,
								disabled: busy,
								onClick: () => {
									runAction("continue");
								},
								children: "返回对话重新规划"
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: MobiusActivityPanel_module_css_default.planBtnDanger,
								disabled: busy,
								onClick: () => {
									setDiscardArmed(true);
									setError("");
								},
								children: "丢弃"
							})
						] }), error !== "" && (0, react_jsx_runtime.jsx)("span", {
							className: MobiusActivityPanel_module_css_default.planError,
							children: error
						})]
					}),
					running && error !== "" && (0, react_jsx_runtime.jsx)("span", {
						className: MobiusActivityPanel_module_css_default.planError,
						children: error
					})
				]
			});
		}
		function MobiusActivityPanel({ sessionsList }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [openOwner, setOpenOwner] = (0, react.useState)();
			const [autoOpened, setAutoOpened] = (0, react.useState)(false);
			const [wasActive, setWasActive] = (0, react.useState)(false);
			const [layout, setLayout] = (0, react.useState)(initialPanelLayout);
			const [badgeOffset, setBadgeOffset] = (0, react.useState)(() => parseBadgeOffset(window.localStorage.getItem(PANEL_BADGE_OFFSET_STORAGE_KEY)));
			const [badgeDragging, setBadgeDragging] = (0, react.useState)(false);
			const [bounds, setBounds] = (0, react.useState)(initialPanelBounds);
			const [interaction, setInteraction] = (0, react.useState)(null);
			const panelRef = (0, react.useRef)(null);
			const boundsRef = (0, react.useRef)(bounds);
			const gestureRef = (0, react.useRef)(null);
			const frameRef = (0, react.useRef)(null);
			const pendingLayoutRef = (0, react.useRef)(null);
			const current = (0, react.useSyncExternalStore)(sessionsList.subscribe, sessionsList.getSnapshot).current;
			const autoOpenTrackerRef = (0, react.useRef)({
				sessionId: current,
				restoreComplete: false,
				liveWorkflowIds: /* @__PURE__ */ new Set()
			});
			const monitorTargets = (0, react.useSyncExternalStore)(subscribeMobiusMonitorTargets, getMobiusMonitorTargetsSnapshot);
			const { workflows } = (0, react.useSyncExternalStore)(subscribeMobiusSnapshots, getMobiusSnapshotsSnapshot);
			const currentTargets = (0, react.useMemo)(() => current === void 0 ? [] : monitorTargets.filter((target) => target.sessionId === current), [current, monitorTargets]);
			const currentRef = (0, react.useRef)(current);
			(0, react.useEffect)(() => {
				currentRef.current = current;
			}, [current]);
			(0, react.useEffect)(() => {
				const onOpenPanel = (event) => {
					const activeSession = currentRef.current;
					if (activeSession === void 0) return;
					setOpenOwner(activeSession);
					setOpen(true);
				};
				window.addEventListener(OPEN_MOBIUS_PANEL_EVENT, onOpenPanel);
				return () => {
					window.removeEventListener(OPEN_MOBIUS_PANEL_EVENT, onOpenPanel);
				};
			}, []);
			const mountedAtRef = (0, react.useRef)(performance.now());
			const expanded = mobiusPanelExpandedForSession(open, openOwner, current);
			const geometry = (0, react.useMemo)(() => resolvePanelGeometry(layout, bounds), [layout, bounds]);
			const compact = compactPanelForBounds(bounds);
			const commitLayout = (0, react.useCallback)((next) => {
				setLayout(next);
			}, []);
			(0, react.useEffect)(() => {
				window.localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
			}, [layout]);
			const handleBadgeDrag = (0, react.useCallback)((delta) => {
				setBadgeDragging(true);
				setBadgeOffset(delta);
			}, []);
			const handleBadgeDragEnd = (0, react.useCallback)(() => {
				setBadgeDragging(false);
				setBadgeOffset((current) => {
					window.localStorage.setItem(PANEL_BADGE_OFFSET_STORAGE_KEY, JSON.stringify(current));
					return current;
				});
			}, []);
			(0, react.useLayoutEffect)(() => {
				const overlay = document.querySelector("[data-shell-overlay]");
				if (overlay === null) return;
				const conversation = document.querySelector("[data-phase='active']");
				let frame = null;
				const measure = () => {
					frame = null;
					const overlayRect = overlay.getBoundingClientRect();
					const conversationRect = conversation?.getBoundingClientRect();
					const next = {
						width: overlayRect.width,
						height: overlayRect.height,
						anchorRight: conversationRect === void 0 ? overlayRect.width : Math.min(Math.max(conversationRect.right - overlayRect.left, 0), overlayRect.width)
					};
					const previous = boundsRef.current;
					if (previous.width === next.width && previous.height === next.height && previous.anchorRight === next.anchorRight) return;
					boundsRef.current = next;
					setBounds(next);
				};
				const scheduleMeasure = () => {
					frame ??= requestAnimationFrame(measure);
				};
				measure();
				const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
				observer?.observe(overlay);
				if (conversation !== null) observer?.observe(conversation);
				window.addEventListener("resize", scheduleMeasure);
				return () => {
					if (frame !== null) cancelAnimationFrame(frame);
					observer?.disconnect();
					window.removeEventListener("resize", scheduleMeasure);
				};
			}, [current]);
			(0, react.useLayoutEffect)(() => {
				const tracker = autoOpenTrackerRef.current;
				if (tracker.sessionId !== current) {
					tracker.sessionId = current;
					tracker.restoreComplete = false;
					tracker.liveWorkflowIds = /* @__PURE__ */ new Set();
					setWasActive(false);
					setAutoOpened(false);
				}
				if (openOwner === void 0 || openOwner === current) return;
				setOpen(false);
				setOpenOwner(void 0);
			}, [current, openOwner]);
			(0, react.useLayoutEffect)(() => {
				const root = document.documentElement;
				if (expanded && geometry.mode === "docked" && !compact) {
					root.setAttribute(PANEL_OPEN_ATTRIBUTE, "");
					root.style.setProperty(PANEL_SHIFT_PROPERTY, `${geometry.width + PANEL_CONVERSATION_GAP + 18}px`);
				} else {
					root.removeAttribute(PANEL_OPEN_ATTRIBUTE);
					root.style.removeProperty(PANEL_SHIFT_PROPERTY);
				}
				return () => {
					root.removeAttribute(PANEL_OPEN_ATTRIBUTE);
					root.style.removeProperty(PANEL_SHIFT_PROPERTY);
				};
			}, [
				compact,
				expanded,
				geometry.mode,
				geometry.width
			]);
			(0, react.useEffect)(() => {
				if (current === void 0) return;
				const controller = startMobiusPolling(currentTargets, { discoverySessionId: current });
				let active = true;
				const tracker = autoOpenTrackerRef.current;
				if (tracker.sessionId === current && !tracker.restoreComplete) controller.firstTick.then(() => {
					const latest = autoOpenTrackerRef.current;
					if (!active || latest.sessionId !== current || latest.restoreComplete) return;
					latest.liveWorkflowIds = new Set(getMobiusSnapshotsSnapshot().workflows.filter((workflow) => workflow.captainSessionId === current).map((workflow) => workflow.id));
					latest.restoreComplete = true;
				});
				return () => {
					active = false;
					controller.stop();
				};
			}, [current, currentTargets]);
			const visibleWorkflows = (0, react.useMemo)(() => current === void 0 ? [] : workflows.filter((workflow) => workflow.captainSessionId === current), [workflows, current]);
			const visibleCount = visibleWorkflows.length;
			const visibleLiveWorkflowIds = (0, react.useMemo)(() => visibleWorkflows.map((workflow) => workflow.id).sort(), [visibleWorkflows]);
			(0, react.useEffect)(() => {
				const tracker = autoOpenTrackerRef.current;
				const settled = performance.now() - mountedAtRef.current >= AUTO_OPEN_SETTLE_MS;
				const shouldAutoExpand = tracker.sessionId === current && mobiusPanelShouldAutoExpand({
					alreadyAutoOpened: autoOpened,
					pageSettled: settled,
					restoreComplete: tracker.restoreComplete,
					previousLiveWorkflowIds: tracker.liveWorkflowIds,
					currentLiveWorkflowIds: visibleLiveWorkflowIds
				});
				if (tracker.sessionId === current && tracker.restoreComplete) tracker.liveWorkflowIds = new Set(visibleLiveWorkflowIds);
				if (visibleCount > 0) {
					setWasActive(true);
					if (shouldAutoExpand) {
						setOpenOwner(current);
						setOpen(true);
						setAutoOpened(true);
					}
					return;
				}
				if (!wasActive) return;
				const timer = setTimeout(() => {
					setOpen(false);
					setOpenOwner(void 0);
					setWasActive(false);
					setAutoOpened(false);
				}, AUTOCLOSE_GRACE_MS);
				return () => {
					clearTimeout(timer);
				};
			}, [
				visibleCount,
				visibleLiveWorkflowIds.join("\0"),
				autoOpened,
				wasActive,
				current
			]);
			const busy = (0, react.useMemo)(() => visibleWorkflows.some((workflow) => workflow.steps.some((step) => step.status === "running")), [visibleWorkflows]);
			const hasWorkflows = visibleCount > 0;
			const phase = (0, react.useMemo)(() => mobiusPanelPhaseOf(visibleWorkflows), [visibleWorkflows]);
			const activePhase = phase === "idle" ? "running" : phase;
			const runsWater = mobiusRunsWater(phase);
			const [panelHalting, setPanelHalting] = (0, react.useState)(false);
			const [panelError, setPanelError] = (0, react.useState)("");
			const runningWorkflows = (0, react.useMemo)(() => visibleWorkflows.filter((workflow) => workflow.phase === "running"), [visibleWorkflows]);
			const panelHalt = (0, react.useCallback)(async () => {
				if (panelHalting) return;
				const sessionId = currentRef.current;
				if (sessionId === void 0) return;
				const targets = runningWorkflows.filter((workflow) => workflow.phase === "running");
				if (targets.length === 0) return;
				setPanelHalting(true);
				setPanelError("");
				try {
					await Promise.all(targets.map(async (workflow) => {
						const response = await fetch("/plugins/dsh-mobius/halt", {
							method: "POST",
							cache: "no-store",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								sessionId,
								workflowId: workflow.id
							})
						});
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
					}));
				} catch (error) {
					setPanelError(error instanceof Error ? error.message : String(error));
				} finally {
					setPanelHalting(false);
				}
			}, [panelHalting, runningWorkflows.map((workflow) => workflow.id).join("\0")]);
			const panelGeometryForGesture = (0, react.useCallback)(() => {
				const measuredHeight = panelRef.current?.getBoundingClientRect().height;
				if (measuredHeight === void 0 || measuredHeight <= 0) return geometry;
				return {
					...geometry,
					height: measuredHeight
				};
			}, [geometry]);
			const flushScheduledLayout = (0, react.useCallback)(() => {
				if (frameRef.current !== null) {
					cancelAnimationFrame(frameRef.current);
					frameRef.current = null;
				}
				const pending = pendingLayoutRef.current;
				pendingLayoutRef.current = null;
				if (pending !== null) commitLayout(pending);
			}, [commitLayout]);
			const scheduleLayout = (0, react.useCallback)((next) => {
				pendingLayoutRef.current = next;
				frameRef.current ??= requestAnimationFrame(() => {
					frameRef.current = null;
					const pending = pendingLayoutRef.current;
					pendingLayoutRef.current = null;
					if (pending !== null) commitLayout(pending);
				});
			}, [commitLayout]);
			(0, react.useEffect)(() => () => {
				if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
			}, []);
			const beginMove = (0, react.useCallback)((event) => {
				if (compact || event.button !== 0 || event.target.closest("button") !== null) return;
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				gestureRef.current = {
					kind: "move",
					pointerId: event.pointerId,
					originX: event.clientX,
					originY: event.clientY,
					start: panelGeometryForGesture(),
					activated: false
				};
			}, [compact, panelGeometryForGesture]);
			const beginResize = (0, react.useCallback)((edge, event) => {
				if (compact || event.button !== 0 || geometry.mode === "docked" && edge !== "left") return;
				event.preventDefault();
				event.stopPropagation();
				event.currentTarget.setPointerCapture(event.pointerId);
				gestureRef.current = {
					kind: "resize",
					edge,
					pointerId: event.pointerId,
					originX: event.clientX,
					originY: event.clientY,
					start: panelGeometryForGesture(),
					activated: true
				};
				setInteraction("resizing");
			}, [
				compact,
				geometry.mode,
				panelGeometryForGesture
			]);
			const updateGesture = (0, react.useCallback)((event) => {
				const gesture = gestureRef.current;
				if (gesture === null || gesture.pointerId !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
				const dx = event.clientX - gesture.originX;
				const dy = event.clientY - gesture.originY;
				const activeBounds = boundsRef.current;
				if (gesture.kind === "move") {
					if (!gesture.activated && Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
					if (!gesture.activated) {
						gesture.activated = true;
						setInteraction("dragging");
					}
					scheduleLayout(movePanelLayout(floatPanelLayout(gesture.start, activeBounds), dx, dy, activeBounds));
					return;
				}
				scheduleLayout(resizePanelLayout(gesture.start, gesture.edge ?? "left", dx, dy, activeBounds));
			}, [scheduleLayout]);
			const endGesture = (0, react.useCallback)((event) => {
				const gesture = gestureRef.current;
				if (gesture === null || gesture.pointerId !== event.pointerId) return;
				updateGesture(event);
				flushScheduledLayout();
				if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
				gestureRef.current = null;
				setInteraction(null);
			}, [flushScheduledLayout, updateGesture]);
			const cancelGesture = (0, react.useCallback)((event) => {
				const gesture = gestureRef.current;
				if (gesture === null || gesture.pointerId !== event.pointerId) return;
				flushScheduledLayout();
				gestureRef.current = null;
				setInteraction(null);
			}, [flushScheduledLayout]);
			const toggleDock = (0, react.useCallback)(() => {
				const liveGeometry = panelGeometryForGesture();
				commitLayout(liveGeometry.mode === "docked" ? floatPanelLayout(liveGeometry, boundsRef.current) : dockPanelLayout(liveGeometry, boundsRef.current));
			}, [commitLayout, panelGeometryForGesture]);
			const autoHeight = panelUsesAutoHeight(geometry, bounds);
			const panelStyle = {
				width: geometry.width,
				height: autoHeight ? "auto" : geometry.height,
				maxHeight: panelMaximumHeight(geometry, bounds),
				transform: `translate3d(${geometry.x}px, ${geometry.y}px, 0)`
			};
			if (!hasWorkflows && !expanded) return null;
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [!expanded && (0, react_jsx_runtime.jsx)(CollapsedBadge, {
				count: visibleCount,
				phase: activePhase,
				busy,
				offset: badgeOffset,
				onDrag: handleBadgeDrag,
				onDragEnd: handleBadgeDragEnd,
				dragging: badgeDragging,
				onClick: () => {
					if (current === void 0) return;
					setOpenOwner(current);
					setOpen(true);
				}
			}), expanded && (0, react_jsx_runtime.jsxs)("aside", {
				ref: panelRef,
				className: MobiusActivityPanel_module_css_default.panel,
				style: panelStyle,
				"data-mobius-activity": true,
				"data-phase": activePhase,
				"data-panel-mode": geometry.mode,
				"data-height-mode": autoHeight ? "auto" : "manual",
				"data-compact": compact || void 0,
				"data-dragging": interaction === "dragging" || void 0,
				"data-resizing": interaction === "resizing" || void 0,
				"aria-label": "Mobius 研究工作流",
				children: [
					(0, react_jsx_runtime.jsxs)("header", {
						className: MobiusActivityPanel_module_css_default.panelHead,
						onPointerDown: beginMove,
						onPointerMove: updateGesture,
						onPointerUp: endGesture,
						onPointerCancel: cancelGesture,
						"data-drag-handle": !compact || void 0,
						children: [(0, react_jsx_runtime.jsxs)("span", {
							className: MobiusActivityPanel_module_css_default.panelTitle,
							children: [(0, react_jsx_runtime.jsxs)("span", { children: ["Mobius ", phaseLabel(activePhase)] }), (0, react_jsx_runtime.jsx)("span", {
								className: MobiusActivityPanel_module_css_default.panelDot,
								"data-busy": busy,
								"aria-hidden": true
							})]
						}), (0, react_jsx_runtime.jsxs)("span", {
							className: MobiusActivityPanel_module_css_default.panelControls,
							children: [
								runningWorkflows.length > 0 && (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: MobiusActivityPanel_module_css_default.iconButton,
									"data-control": "halt",
									onClick: () => {
										panelHalt();
									},
									disabled: panelHalting,
									"aria-label": panelHalting ? "正在停止…" : "强制中断",
									title: panelHalting ? "正在停止…" : "强制中断",
									children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconStopFill16, {})
								}),
								!compact && (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: MobiusActivityPanel_module_css_default.iconButton,
									"data-control": "dock",
									"data-mode": geometry.mode,
									onClick: toggleDock,
									"aria-label": geometry.mode === "docked" ? "浮动窗口" : "停靠右侧",
									title: geometry.mode === "docked" ? "浮动窗口" : "停靠右侧",
									children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPanelLeftOutline16, {})
								}),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: MobiusActivityPanel_module_css_default.iconButton,
									"data-control": "collapse",
									onClick: () => {
										setOpen(false);
										setOpenOwner(void 0);
									},
									"aria-label": "折叠",
									title: "折叠",
									children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
								})
							]
						})]
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: MobiusActivityPanel_module_css_default.waterWaves,
						"data-active": runsWater || void 0,
						"aria-hidden": true
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: MobiusActivityPanel_module_css_default.workflows,
						children: [visibleCount === 0 ? (0, react_jsx_runtime.jsx)("span", {
							className: MobiusActivityPanel_module_css_default.emptyHint,
							children: "暂无研究工作流。对我说“我要研究 xxx”。"
						}) : visibleWorkflows.map((workflow) => (0, react_jsx_runtime.jsx)(WorkflowCard, {
							workflow,
							captainSessionId: current ?? ""
						}, workflow.id)), panelError !== "" && (0, react_jsx_runtime.jsx)("span", {
							className: MobiusActivityPanel_module_css_default.planError,
							children: panelError
						})]
					}),
					!compact && (0, react_jsx_runtime.jsx)("div", {
						className: MobiusActivityPanel_module_css_default.resizeHandle,
						"data-resize-edge": "left",
						onPointerDown: (event) => {
							beginResize("left", event);
						},
						onPointerMove: updateGesture,
						onPointerUp: endGesture,
						onPointerCancel: cancelGesture,
						"aria-hidden": true
					}),
					!compact && geometry.mode === "floating" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("div", {
						className: MobiusActivityPanel_module_css_default.resizeHandle,
						"data-resize-edge": "bottom",
						onPointerDown: (event) => {
							beginResize("bottom", event);
						},
						onPointerMove: updateGesture,
						onPointerUp: endGesture,
						onPointerCancel: cancelGesture,
						"aria-hidden": true
					}), (0, react_jsx_runtime.jsx)("div", {
						className: MobiusActivityPanel_module_css_default.resizeHandle,
						"data-resize-edge": "corner",
						onPointerDown: (event) => {
							beginResize("corner", event);
						},
						onPointerMove: updateGesture,
						onPointerUp: endGesture,
						onPointerCancel: cancelGesture,
						"aria-hidden": true
					})] })
				]
			})] });
		}
		//#endregion
		//#region lib/client/mobius-card-definition.js
		/**
		* Mobius conversation card: a lightweight in-conversation summary shown when a
		* sequential research workflow is created — the workflow name, its goal, a
		* step count, and an interrupt button to stop a running pipeline from the chat.
		*
		* The fold anchors to the Harness's durable `tool/call` + `tool/result`
		* records for `mobius_create`. Those are first-party session events, so the
		* card survives restarts without writing an out-of-repo event type (it mirrors
		* the agent-teams card, which anchors on `agent_teams_create`).
		* @module dsh-dai-mobius/client/card
		*/
		/** Parse the only create-call fields the card owns. */
		function parseMobiusCreateArgs(value) {
			try {
				const parsed = JSON.parse(value);
				if (typeof parsed !== "object" || parsed === null || !("name" in parsed) || typeof parsed.name !== "string") return;
				const name = parsed.name.trim();
				if (name === "") return void 0;
				const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
				const goal = "goal" in parsed && typeof parsed.goal === "string" ? parsed.goal.trim() : "";
				const steps = "steps" in parsed && Array.isArray(parsed.steps) ? parsed.steps.length : 0;
				if (steps === 0) return void 0;
				return {
					workflowId: cleaned === "" ? "workflow" : cleaned,
					name,
					goal,
					steps
				};
			} catch {
				return;
			}
		}
		/** Durable first-party tool events folded into one keyed Chat node. */
		const mobiusCardDefinition = {
			kind: "mobius",
			target: "chat",
			match: (event) => {
				if (event.type === "tool/call" && event.data.name === "mobius_create") return parseMobiusCreateArgs(event.data.arguments) === void 0 ? null : {
					id: String(event.data.callId),
					role: "start"
				};
				if (event.type === "tool/result" && event.data.message.source.kind === "tool") return {
					id: String(event.data.message.source.callId),
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "tool/call") throw new Error("mobius card start requires mobius_create tool/call");
				const parsed = parseMobiusCreateArgs(match.event.data.arguments);
				if (parsed === void 0) throw new Error("mobius card start requires valid create arguments");
				return {
					...parsed,
					accepted: false
				};
			},
			update: (context, match) => {
				if (match.event.type !== "tool/result") return context.state;
				if (match.event.data.error !== void 0 || match.event.data.message.content.some((block) => block.type === "tool-result" && block.isError === true)) return context.state;
				return {
					...context.state,
					accepted: true
				};
			},
			buildViewNode: (context) => {
				if (context.start === void 0) return null;
				const state = context.state;
				if (!state.accepted) return null;
				return {
					key: context.key,
					kind: "mobius",
					id: context.id,
					target: "chat",
					anchorSeq: context.start.event.seq,
					location: context.start.location,
					visibility: "visible",
					data: {
						workflowId: state.workflowId,
						captainSessionId: "",
						name: state.name,
						goal: state.goal,
						steps: state.steps
					}
				};
			}
		};
		//#endregion
		//#region lib/client/index.js
		/** Required services: conversation nodes, slots, and sessions. */
		const inject = [
			"uiConversation",
			"slots",
			"sessions"
		];
		/**
		* Register the Mobius activity monitor in the shell's additive overlay and the
		* in-conversation workflow card. A separate overlay slot keeps the floater
		* visually distinct from any collocated agent-teams floater.
		*/
		function apply(ctx) {
			const MobiusActivityPanelView = () => (0, react_jsx_runtime.jsx)(MobiusActivityPanel, { sessionsList: ctx.sessions.list });
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "mobius-activity",
				order: 79,
				label: "Mobius workflow"
			}, MobiusActivityPanelView));
			ctx.uiConversation.events.register(mobiusCardDefinition);
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "mobius"
			}, MobiusCard));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map