import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import z$1 from "@deepseek-ai/schemastery";
import { deriveEventMessage } from "@deepseek-ai/dsh-session";
/**
* Recover the MCP server display label from a proxied tool name, or undefined
* for non-MCP names. `dsh-mcp-client` names tools `mcp__<server>__<rawName>`
* (normalized, and hash-appended when overlong/invalid — the label then shows
* whatever of the server survived the truncation). The separating `__` is the
* LAST one in the name, and it must sit AFTER the `mcp__` prefix: the prefix's
* own separator (or an empty server right after it) is not a server.
*/
function mcpServerOf(name) {
	if (!name.startsWith("mcp__")) return void 0;
	const cut = name.lastIndexOf("__");
	if (cut < 5) return void 0;
	const server = name.slice(5, cut);
	return server.length > 0 ? server : void 0;
}
/** The `mcp:<server>` display label of a proxied tool name, or undefined. */
function mcpSourceOf(name) {
	const server = mcpServerOf(name);
	return server !== void 0 ? `mcp:${server}` : void 0;
}
/** The pinned package of a first-party tool name, or undefined. */
function pinnedSourceOf(name) {
	return FIRST_PARTY_SOURCES[name];
}
/**
* Pinned first-party tool → plugin package map (see header comment). One entry
* per model-facing name of the shipped tool packages at dsh 0.1.1-rc.2, from
* the official tool-schema catalog; names are stable across the supported
* harness range. Packages that mount under distinct names per composition
* (bash/pwsh persistent variants, subagent fork) map to their primary package.
*/
const FIRST_PARTY_SOURCES = Object.freeze({
	read: "@deepseek-ai/dsh-tool-fs",
	write: "@deepseek-ai/dsh-tool-fs",
	edit: "@deepseek-ai/dsh-tool-fs",
	read_image: "@deepseek-ai/dsh-tool-fs",
	glob: "@deepseek-ai/dsh-tool-fs-search",
	grep: "@deepseek-ai/dsh-tool-fs-search",
	str_replace_editor: "@deepseek-ai/dsh-tool-str-replace-editor",
	bash: "@deepseek-ai/dsh-tool-bash",
	pwsh: "@deepseek-ai/dsh-tool-pwsh",
	web_search: "@deepseek-ai/dsh-tool-web",
	web_fetch: "@deepseek-ai/dsh-tool-web",
	job_output: "@deepseek-ai/dsh-tool-jobs",
	job_list: "@deepseek-ai/dsh-tool-jobs",
	job_kill: "@deepseek-ai/dsh-tool-jobs",
	ask_user_question: "@deepseek-ai/dsh-tool-ask-user",
	plan: "@deepseek-ai/dsh-plan-mode",
	exit_plan_mode: "@deepseek-ai/dsh-plan-mode",
	skill: "@deepseek-ai/dsh-tool-skill",
	todo_write: "@deepseek-ai/dsh-tool-todo",
	subagent: "@deepseek-ai/dsh-tool-subagent",
	subagent_fork: "@deepseek-ai/dsh-tool-subagent",
	send_message: "@deepseek-ai/dsh-tool-subagent-control",
	interrupt_agent: "@deepseek-ai/dsh-tool-subagent-control",
	list_agents: "@deepseek-ai/dsh-tool-subagent-control",
	ralph: "@deepseek-ai/dsh-tool-ralph",
	workflow: "@deepseek-ai/dsh-tool-workflow",
	run_code: "@deepseek-ai/dsh-tools",
	schedule_create: "@deepseek-ai/dsh-schedule",
	schedule_list: "@deepseek-ai/dsh-schedule",
	schedule_delete: "@deepseek-ai/dsh-schedule",
	create_goal: "@deepseek-ai/dsh-tool-goal",
	get_goal: "@deepseek-ai/dsh-tool-goal",
	update_goal: "@deepseek-ai/dsh-tool-goal",
	lsp: "@deepseek-ai/dsh-tool-lsp"
});
//#endregion
//#region src/host/attribution.ts
/**
* Live tool→plugin attribution layered on the static recovery in
* toolSources.ts.
*
* The session log records tools as plain `ToolSchema` entries (name /
* description / parameters) — the registering plugin is not in there.
* toolSources.ts derives the deterministic sources (harness-logged field,
* `mcp:<server>` naming, pinned first-party map). This module additionally
* watches RUNTIME registrations: cordis fires the `internal/get` waterfall on
* every context read of a service property, passing the READING context as the
* first argument, so `reader.fiber.name` identifies the plugin that is about
* to call `register()`.
*
* - The `internal/get` handler records who last read the `tools` service and
*   wraps that instance's `register` (once — an earlier wrapper of a previous
*   hook incarnation is peeled back to the original, so a plugin reload
*   re-wraps without stacking) to capture the reader at registration time
*   into a live map. Every wrapper is undone when the plugin unloads: the
*   original `register` goes back on the instance, unless a newer hook
*   incarnation re-wrapped it first (that incarnation's own cleanup then
*   owns the restore).
* - When the reader slot is missing, root-named, or this plugin's own (e.g.
*   LOCAL-LINK plugins — dev installs via `dsh plugin add <path>` or
*   npm/pnpm link — whose anonymous entrypoints make cordis fall back to the
*   root name), the wrapped `register` falls back to the call stack: the first
*   frame outside this package is resolved to its nearest `package.json`
*   `name`. That covers both npm installs (`node_modules/<pkg>`) and local
*   links (any directory carrying a package.json), which never pass through
*   node_modules. Frames that resolve back to this package are skipped.
* - `ownerOf(name)` prefers the name-derived `mcp:<server>` label (it names
*   the actual provider, where the live record would only ever name the MCP
*   proxy client), then the LIVE record — for a post-boot registration it is
*   the truth, even when the name collides with a pinned first-party tool —
*   then the pinned map (the boot-time guess for tools registered before the
*   hook), and finally tags tools that were ALREADY registered when the hook
*   installed (the boot snapshot — third-party bundles, e.g. local links like
*   dsh-file-claim, that applied before dsh-context) with the
*   `UNKNOWN_TOOL_SOURCE` sentinel: their registering plugin is unknowable,
*   and a bare gap would read as "no plugin" instead of "unknown plugin".
*
* Best-effort by design: a read separated from `register()` by an `await` can
* be overwritten by another plugin's read (misattribution) and the stack
* fallback needs a resolvable package.json — both degrade to the name/pinned
* chain; registrations that predate the hook degrade to the unknown tag. The
* hook costs roughly +1.4us per service-property read and is negligible on
* the rare register path (the stack walk only runs when the reader slot is
* unusable, and its package lookups are cached per directory).
*/
/** This module's own file URL — the stack walk skips its own frames. */
const selfUrl = normalize(fileURLToPath(import.meta.url));
/** Directory → package-name cache for the synchronous walk below. */
const packageCache = /* @__PURE__ */ new Map();
/**
* Best-effort package name for a module file: walk up to the nearest
* `package.json` carrying a `name`. Works for dependencies installed under
* `node_modules` as well as local links whose package root is any on-disk
* directory. The per-directory results are cached.
* @param file - absolute path of a module file.
*/
function packageNameFrom(file) {
	let dir = dirname(file);
	for (let depth = 0; depth < 12; depth++) {
		const cached = packageCache.get(dir);
		if (cached !== void 0) return cached;
		const packageFile = join(dir, "package.json");
		if (existsSync(packageFile)) try {
			const name = JSON.parse(readFileSync(packageFile, "utf8")).name;
			if (typeof name === "string" && name) {
				packageCache.set(dir, name);
				return name;
			}
		} catch {}
		const parent = dirname(dir);
		packageCache.set(dir, void 0);
		if (parent === dir) return void 0;
		dir = parent;
	}
}
const FRAME_POSITION = /:\d+:\d+$/;
/** Package name of this module's own package (self-fallbacks are filtered). */
const selfPackage = packageNameFrom(selfUrl);
/**
* Resolve the registering package from a stack trace: walk frames from the
* innermost out, skipping this module's own frames and frames that resolve to
* this package, and return the package name of the first frame that resolves
* elsewhere. Works with both `file://` URLs and bare absolute paths
* (transpiled modules render without a scheme), with optional `fn (...)` and
* `async` wrappers.
* @param stack - `Error().stack`, or undefined when no fallback is desired.
*/
function callerPackageFrom(stack) {
	if (!stack) return void 0;
	for (const raw of stack.split("\n").slice(1)) {
		let line = raw.trim();
		if (!line.startsWith("at ")) continue;
		line = line.slice(3);
		if (line.startsWith("async ")) line = line.slice(6);
		line = line.replace(/\)\s*$/, "");
		const position = FRAME_POSITION.exec(line);
		if (!position) continue;
		let target = line.slice(0, -position[0].length);
		if (target.includes("(")) target = target.slice(target.lastIndexOf("(") + 1);
		if (target.startsWith("file://")) try {
			target = normalize(fileURLToPath(target));
		} catch {
			continue;
		}
		else if (!/^[A-Za-z]:[\\/]/.test(target) && !target.startsWith("/") && !target.startsWith("\\\\")) continue;
		else target = normalize(target);
		if (target === selfUrl) continue;
		const name = packageNameFrom(target);
		if (name !== void 0 && name !== selfPackage) return name;
	}
}
/**
* Install the runtime-attribution hook on a cordis app context. The hook
* rides the calling fiber's lifetime (`ctx.on`, and an effect that restores
* every patched `register`), so it is disposed with the plugin.
* @param ctx - the context the dsh-context plugin runs in; its fiber name is
* excluded from attributions.
*/
function createToolAttribution(ctx) {
	const live = /* @__PURE__ */ new Map();
	const wrapped = /* @__PURE__ */ new WeakSet();
	const self = ctx.fiber.name;
	let lastReader;
	const patched = [];
	const wrapInstance = (tools) => {
		if (!tools || typeof tools !== "object" || wrapped.has(tools)) return;
		const register = tools.register;
		if (typeof register !== "function") return;
		wrapped.add(tools);
		const original = register.attributedOriginal ?? register;
		if (typeof original !== "function") return;
		const instance = tools;
		const wrappedRegister = function(definition) {
			const toolName = definition?.name;
			let owner = lastReader?.fiber.name;
			if (!owner || owner === "root" || owner === self) owner = callerPackageFrom((/* @__PURE__ */ new Error()).stack);
			const dispose = original.call(this, definition);
			if (typeof toolName === "string" && owner && owner !== "root" && owner !== self && owner !== selfPackage) {
				live.set(toolName, owner);
				if (typeof dispose === "function") return () => {
					try {
						return dispose();
					} finally {
						live.delete(toolName);
					}
				};
			}
			return dispose;
		};
		wrappedRegister.attributedOriginal = original;
		instance.register = wrappedRegister;
		patched.push(() => {
			if (instance.register === wrappedRegister) instance.register = original;
		});
	};
	ctx.on("internal/get", (reader, name, _error, next) => {
		if (name !== "tools") return next();
		const tools = next();
		lastReader = reader;
		wrapInstance(tools);
		return tools;
	});
	ctx.effect(() => () => {
		for (const restore of patched.splice(0)) restore();
	}, "tools.register attribution");
	const toolsService = ctx.get("tools", false);
	wrapInstance(toolsService);
	const boot = /* @__PURE__ */ new Set();
	try {
		const toolEntries = toolsService?.layers?.global?.tools;
		if (toolEntries !== void 0 && typeof toolEntries.entries === "function") for (const [name] of toolEntries.entries()) boot.add(name);
	} catch {}
	return { ownerOf: (name) => mcpSourceOf(name) ?? live.get(name) ?? pinnedSourceOf(name) ?? (boot.has(name) ? "<unknown-plugin>" : void 0) };
}
//#endregion
//#region src/host/config.ts
/**
* dsh-context host configuration — the `config:` block of the `dsh-context`
* loader row in cordis.yml.
*
* Cordis validates the entry config against this exported `Config` schema
* (any Standard Schema v1 validator — zod is ours) before `apply` runs, fills
* per-field defaults, and fails the load loudly on invalid or unknown keys
* (`.strict()`). The official plugin-config principle this answers: "anything
* that two deployments may want to set differently is a configuration field".
*
* The persisted projection state shape is independent of these bounds — they
* only tune the fold's retention / presentation slice, so changing them never
* requires a projection `stateVersion` bump.
*/
const DEFAULT_BOUNDS = {
	maxRequestSteps: 1500,
	maxKeptTurns: 300,
	maxEvents: 400,
	maxNodes: 2e3,
	maxArchiveNodes: 400
};
/**
* The cordis `Config` validator: strict on keys, defaults on the schema fields; tolerates `undefined` (a patch row without a `config:`
* block — defaults win).
*/
const Config = z.preprocess((v) => v ?? {}, z.object({
	maxRequestSteps: z.number().int().min(1).default(DEFAULT_BOUNDS.maxRequestSteps),
	maxKeptTurns: z.number().int().min(1).default(DEFAULT_BOUNDS.maxKeptTurns),
	maxEvents: z.number().int().min(1).default(DEFAULT_BOUNDS.maxEvents),
	maxNodes: z.number().int().min(1).default(DEFAULT_BOUNDS.maxNodes),
	maxArchiveNodes: z.number().int().min(1).default(DEFAULT_BOUNDS.maxArchiveNodes)
}).strict());
function resolveBounds(config) {
	return Config.parse(config ?? {});
}
//#endregion
//#region src/shared/imageTokens.ts
/**
* Per-image token estimate for DeepSeek's vision model — a faithful port of
* the official "图片 Token 计算器" (Image Token Calculator) shipped on the
* DeepSeek API docs (https://api-docs.deepseek.com/zh-cn/quick_start/token_usage),
* which implements the provider's own image→token conversion:
*
*   - every image is aspect-preserved rescaled before entering the model:
*     below ~384×384 total pixels it is enlarged, above it is shrunk;
*   - tokens follow the patch grid (patch 14px, downsample 3), so every
*     image costs at least 117 and at most ~384 tokens (the documented cap).
*
* Verified against the docs calculator itself: 2048×1365→313, 800×600→341,
* 2048×2048→349, 512×512→201, 100×100→117, 1920×1080→369, 400×900→249.
* The DSH request pipeline's own 640k-pixel pre-resize does not change the
* result (the provider formula rescales to the same patch grid), so the
* durable attachment dimensions can be fed in directly.
*
* Pure math shared by the Host fold (message pricing) and the Client
* (attachment card token badges) — no dependencies, never mutates.
*/
const PATCH_SIZE = 14;
const DOWNSAMPLE_RATIO = 3;
const MAX_WH_RATIO = 8;
/** ~384×384 total pixels: smaller images are enlarged before patching. */
const MIN_PIXELS = 147456;
const floorDiv = (a, b) => Math.floor(a / b);
const ceilDiv = (a, b) => Math.floor((a + b - 1) / b);
function gridTokens(rows, cols) {
	let n = rows * (cols + 1) + 2;
	if (rows % 2 === 1) n += cols + 1;
	n += ceilDiv(rows, 2) * (cols + 1) % 2 * 2;
	return n;
}
/** Solve the largest in-grid resize whose token count fits `budget`. */
function solveResizeRatio(height, width, budget) {
	const ratio = height / width;
	const gridW = Math.sqrt((budget - 2) / ratio + .25) - .5;
	const gridH = gridW * ratio;
	const unit = 42;
	let bestHeight;
	let bestWidth;
	if (gridW < 1) {
		let rows = floorDiv(budget - 2, 2);
		/* v8 ignore else -- budget enters at 381 and the tall solve always fits
		(never decrements), so rows is always odd here; parity-defensive. */
		if (rows % 2 === 1) rows -= 1;
		bestWidth = unit;
		bestHeight = rows * unit;
	} else if (gridH < 2) {
		const cols = floorDiv(budget - 2, 2) - 1;
		if (cols <= 1) throw new Error("image tokens: budget too small to solve");
		bestHeight = 84;
		bestWidth = cols * unit;
	} else {
		const cols = Math.trunc(gridW);
		let rows = Math.trunc(gridH);
		if (rows % 2 === 1) rows -= 1;
		const scale = Math.min(cols * unit / width, rows * unit / height);
		bestWidth = Math.trunc(width * scale / PATCH_SIZE) * PATCH_SIZE;
		bestHeight = Math.trunc(height * scale / PATCH_SIZE) * PATCH_SIZE;
	}
	const nLlmH = ceilDiv(floorDiv(bestHeight, PATCH_SIZE), DOWNSAMPLE_RATIO);
	const nLlmW = ceilDiv(floorDiv(bestWidth, PATCH_SIZE), DOWNSAMPLE_RATIO);
	return {
		nLlmH,
		nLlmW,
		bestHeight,
		bestWidth,
		numTokens: gridTokens(nLlmH, nLlmW)
	};
}
/** Resize so the patch grid fits the cap, then re-add the pad reserve. */
function safeResize(height, width, paddedHeight, paddedWidth) {
	const nLlmH = ceilDiv(floorDiv(paddedHeight, PATCH_SIZE), DOWNSAMPLE_RATIO);
	const nLlmW = ceilDiv(floorDiv(paddedWidth, PATCH_SIZE), DOWNSAMPLE_RATIO);
	const pad = 3;
	const budget = 381;
	let result = {
		nLlmH,
		nLlmW,
		bestHeight: paddedHeight,
		bestWidth: paddedWidth,
		numTokens: gridTokens(nLlmH, nLlmW)
	};
	if (result.numTokens > budget) {
		result = solveResizeRatio(height, width, budget);
		let nextBudget = budget;
		while (result.numTokens > budget) {
			nextBudget -= 1;
			result = solveResizeRatio(height, width, nextBudget);
		}
	}
	result.numTokens += pad;
	return result;
}
function calcResizeInner(width, height) {
	let w = width;
	let h = height;
	if (w > h * MAX_WH_RATIO) w = h * MAX_WH_RATIO;
	const pixels = w * h;
	if (pixels < MIN_PIXELS && pixels > 0) {
		const scale = Math.sqrt(MIN_PIXELS / pixels);
		w = Math.trunc(w * scale);
		h = Math.trunc(h * scale);
	}
	const paddedWidth = ceilDiv(w, PATCH_SIZE) * PATCH_SIZE;
	const paddedHeight = ceilDiv(h, PATCH_SIZE) * PATCH_SIZE;
	return safeResize(h, w, paddedHeight, paddedWidth);
}
/**
* Estimate the tokens one image consumes in a DeepSeek vision request from its pixel dimensions. Returns null for non-positive/non-finite
* dimensions or when the official iteration fails to converge — callers fall back to the generic structural price.
*/
function estimateImageTokens(width, height) {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	try {
		let result = calcResizeInner(width, height);
		for (let i = 1; i < 10; i++) {
			const next = calcResizeInner(result.bestWidth, result.bestHeight);
			if (next.nLlmH === result.nLlmH && next.nLlmW === result.nLlmW && next.bestHeight === result.bestHeight && next.bestWidth === result.bestWidth && next.numTokens === result.numTokens) return result.numTokens;
			result = next;
		}
		return null;
	} catch {
		/* v8 ignore next -- the only throw site is the clamped-away budget guard
		above; the catch keeps a hostile dimension from ever breaking the fold. */
		return null;
	}
}
//#endregion
//#region src/host/pricing.ts
/**
* Token pricing — the same fixed-density heuristic as the harness's own
* token-meter (`dsh-token-meter/estimate.ts`): ~4 chars ≈ 1 token, +4 per
* content block, +4 role framing. Pure functions over message payloads.
*
* One deliberate refinement over the meter: `image` blocks. The meter prices
* them through its generic JSON branch (~40 tokens for the durable ref),
* while DeepSeek's vision model actually bills 117-384 tokens per image by
* pixel dimensions (https://api-docs.deepseek.com/zh-cn/guides/vision/).
* Image blocks therefore price through the official docs calculator port
* (shared/imageTokens.ts), falling back to the meter's JSON price when the
* attachment's dimensions are unknown.
*/
const CHARS_PER_TOKEN$1 = 4;
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD$1 = 4;
function estimateToolsTotal(tools) {
	return tools.length > 0 ? Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN$1) + BLOCK_OVERHEAD : 0;
}
/** The `ContentBlock` walkers take `unknown`: block arrays ride the untrusted
* log, so their element shapes (null and primitives included) are re-proved
* here, not trusted from the declared message types. */
function estimateBlocks(blocks) {
	let tokens = 0;
	if (!Array.isArray(blocks)) return 0;
	for (const item of blocks) {
		if (item === null || typeof item !== "object") {
			tokens += BLOCK_OVERHEAD;
			continue;
		}
		const block = item;
		switch (block.type) {
			case "text":
			case "reasoning":
				tokens += Math.ceil((block.text || "").length / CHARS_PER_TOKEN$1) + BLOCK_OVERHEAD;
				break;
			case "tool-call":
				tokens += Math.ceil((block.name || "").length / CHARS_PER_TOKEN$1) + Math.ceil((block.arguments || "").length / CHARS_PER_TOKEN$1) + BLOCK_OVERHEAD;
				break;
			case "tool-result":
				tokens += estimateBlocks(block.content) + BLOCK_OVERHEAD;
				break;
			case "image": {
				const ref = block.attachment;
				const priced = ref !== null && typeof ref === "object" && typeof ref.width === "number" && typeof ref.height === "number" ? estimateImageTokens(ref.width, ref.height) : null;
				tokens += (priced ?? Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN$1)) + BLOCK_OVERHEAD;
				break;
			}
			default: tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN$1);
		}
	}
	return tokens;
}
/**
* Price one surface message exactly like dsh's token-meter estimate:
* an empty-content assistant/message projects to NO message (it only hosts
* usage), so it prices 0; every other message pays content + role framing.
*/
function estimateMessage(message, emptyIsZero = false) {
	if (emptyIsZero && (message === null || message === void 0 || !Array.isArray(message.content) || message.content.length === 0)) return 0;
	return estimateBlocks(message?.content) + ROLE_OVERHEAD$1;
}
/** The shared meter heuristic over rendered system-prompt text (shared/estimate.ts). */
/** Per-tool price for the top-tools display (the total uses dsh's whole-array price). */
function estimateToolSchema(tool) {
	return Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN$1) + BLOCK_OVERHEAD;
}
/**
* Count image blocks in a message payload, recursing into nested content (tool-result blocks carry their inner blocks) — seeds each node's
* `imgs`, which the stats board's image cell sums over the LIVE surface (compacted/pruned messages stop counting).
*/
function imageCountOf(blocks) {
	let count = 0;
	if (!Array.isArray(blocks)) return 0;
	for (const item of blocks) {
		if (item === null || typeof item !== "object") continue;
		const block = item;
		if (block.type === "image") count++;
		else if (Array.isArray(block.content)) count += imageCountOf(block.content);
	}
	return count;
}
function firstText(blocks) {
	if (!Array.isArray(blocks)) return "";
	for (const item of blocks) {
		if (item === null || typeof item !== "object") continue;
		const b = item;
		if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") return b.text.replace(/\s+/g, " ").trim().slice(0, 80);
	}
	return "";
}
function toolCallNames(blocks) {
	const names = [];
	if (!Array.isArray(blocks)) return names;
	for (const item of blocks) {
		if (item === null || typeof item !== "object") continue;
		const b = item;
		if (b.type === "tool-call" && typeof b.name === "string") names.push(b.name);
	}
	return names;
}
/**
* Producer label for an injection event, mirroring the dsh transcript's
* context provenance (client-runtime context-provenance.ts): workspace
* instructions name the files they were reconciled from, a plugin source its
* plugin id, and any other producer its own durable kind. Returns '' when
* the source carries no readable identity at all.
*/
function injectionSourceName(source) {
	if (source.kind === "agent-instructions" && Array.isArray(source.changes)) {
		const paths = [];
		for (const change of source.changes) {
			const path = change?.path;
			if (typeof path === "string" && path !== "" && !paths.includes(path)) paths.push(path);
		}
		if (paths.length > 0) return paths.join(", ");
	}
	if (typeof source.plugin === "string" && source.plugin !== "") return source.plugin;
	return typeof source.kind === "string" && source.kind !== "" ? source.kind : "";
}
function isInjection(source) {
	return source !== null && source !== void 0 && (typeof source.kind === "string" && source.kind !== "" && source.kind !== "user" || typeof source.form === "string");
}
//#endregion
//#region src/shared/estimate.ts
/**
* Token heuristics shared by the host fold and the client boundary — the
* harness token-meter's own fixed-density figure (dsh-token-meter/estimate.ts:
* ~4 chars ≈ 1 token, +4 role framing). Priced identically on both sides so a
* legacy value normalized at the client boundary matches what the host view
* would have served.
*/
const CHARS_PER_TOKEN = 4;
const ROLE_OVERHEAD = 4;
/** Price rendered system-prompt text; 0 for absent/empty/non-string input. */
function estimateSystemTokens(text) {
	if (typeof text !== "string" || text.length === 0) return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD;
}
//#endregion
//#region src/host/headers.ts
/**
* The `contextHeaders` session projection unit — the request-header EPOCH
* METADATA behind the timeline's envelope figures.
*
* The hot `contextTimeline` unit carries only token prices of the system
* prompt and tool schemas; this companion unit keeps the per-epoch METADATA
* (epoch seq/time boundaries, per-tool token prices and plugin attribution)
* so the Context browser can pick the header epoch in force at any step and
* size its sections immediately. The epoch CONTENT (full system prompt text,
* full tool JSON schemas) deliberately does NOT ride the projection VALUE:
* session projections are served whole in every `session.list` row, control
* baseline, push frame, and change notification, so carrying content here
* multiplied it by sessions × epochs across every channel. The client
* fetches one epoch's `request/header` event on demand — a seq-anchored
* history read off the epoch's `seq`, the same targeted read the browser
* already uses for message content — and caches it per session (history is
* immutable).
*
* Read-compat over the persisted state (the pinned decision behind keeping
* `stateVersion` at 1): the harness serves a cold session's projections from
* its CACHED checkpoint rows and has no refresh channel for an idle session
* — a version bump invalidates every row and orphans the key until the
* session goes live again (the #37 regression). The state therefore still
* ACCEPTS the v1 content-bearing record shape, current folds append
* metadata-only records alongside any seeded legacy ones, and the view
* normalizes BOTH to the metadata-only wire shape (pricing the legacy system
* text at read time). Cached v1 rows keep working, new checkpoint writes
* shrink as legacy epochs age out of the capped list, and the wire — the
* part every delivery channel carries — is metadata-only from day one.
*
* Same projection contract as the timeline unit: pure init/apply/view,
* `Object.is` reference stability for uninteresting events, plain-JSON
* bounded state (epoch list capped — see HEADERS_MAX).
*/
/** Retention cap on header epochs (metadata only; changes are rare; 50 is generous). */
const HEADERS_MAX = 50;
/**
* The persisted-state schema: the SUPERSET of both record generations, so a
* cached v1 row (content-bearing) seeds the fold instead of being discarded.
*/
const storedToolSchema = z.object({
	name: z.string(),
	tokens: z.number().int().nonnegative(),
	description: z.string().optional(),
	plugin: z.string().optional(),
	schema: z.unknown().optional()
}).strict();
const storedEpochSchema = z.object({
	seq: z.number(),
	time: z.number(),
	system: z.string().optional(),
	systemTokens: z.number().int().nonnegative().optional(),
	tools: z.array(storedToolSchema)
}).strict();
const contextHeadersStateSchema = z.object({ headers: z.array(storedEpochSchema) }).strict();
/** The wire schema: strict metadata — the shape every delivery channel carries. */
const headerToolWireSchema = z.object({
	name: z.string(),
	tokens: z.number().int().nonnegative(),
	plugin: z.string().optional()
}).strict();
const contextHeadersSchema = z.object({ headers: z.array(z.object({
	seq: z.number(),
	time: z.number(),
	systemTokens: z.number().int().nonnegative().optional(),
	tools: z.array(headerToolWireSchema)
}).strict()) }).strict();
function recordOf(event) {
	if (event.type !== "request/header") return null;
	const rawHeader = event.data.header;
	if (rawHeader === null || rawHeader === void 0 || typeof rawHeader !== "object") return null;
	const header = rawHeader;
	const tools = Array.isArray(header.tools) ? header.tools : [];
	const record = {
		seq: event.seq,
		time: event.time,
		tools: tools.map((t) => {
			const tool = t !== null && typeof t === "object" ? t : {};
			const entry = {
				name: typeof tool.name === "string" ? tool.name : "?",
				tokens: estimateToolSchema(t)
			};
			if (typeof tool.plugin === "string" && tool.plugin !== "") entry.plugin = tool.plugin;
			return entry;
		})
	};
	if (typeof header.system === "string" && header.system.length > 0) record.systemTokens = estimateSystemTokens(header.system);
	return record;
}
/**
* The context-headers projection unit; registered alongside the timeline unit (host/index.ts); clients read it through
* `useProjection('contextHeaders')` and fetch an epoch's full content on demand via the session history (historyPage.ts).
* Contract mirror with a REQUIRED `wire` block (see compat.ts).
* @param resolve - best-effort tool-to-plugin attribution (see toolSources.ts); fills a missing `plugin` at view time so
* epochs folded without attribution still render a tag when the source is known.
*/
function createContextHeadersDefinition(resolve) {
	const view = (state) => ({ headers: state.headers.map((h) => {
		const record = {
			seq: h.seq,
			time: h.time,
			tools: h.tools.map((t) => {
				const entry = {
					name: t.name,
					tokens: t.tokens
				};
				const plugin = t.plugin ?? (resolve !== void 0 ? resolve(t.name) : void 0);
				if (plugin !== void 0) entry.plugin = plugin;
				return entry;
			})
		};
		const systemTokens = h.systemTokens ?? (typeof h.system === "string" && h.system !== "" ? estimateSystemTokens(h.system) : void 0);
		if (systemTokens !== void 0) record.systemTokens = systemTokens;
		return record;
	}) });
	return {
		key: "contextHeaders",
		stateSchema: contextHeadersStateSchema,
		wire: {
			viewSchema: contextHeadersSchema,
			view
		},
		init: () => ({ headers: [] }),
		apply: (state, event) => {
			const record = recordOf(event);
			if (record === null) return state;
			const last = state.headers.at(-1);
			if (last !== void 0 && last.seq === record.seq) return state;
			const headers = [...state.headers, record];
			return { headers: headers.length > HEADERS_MAX ? headers.slice(-50) : headers };
		},
		stateVersion: 1
	};
}
//#endregion
//#region src/host/settings.ts
/** The namespace is the join key between the Host registration and the browser card. */
const SETTINGS_NAMESPACE = "dsh-context";
/** Section schema: also the wire envelope the browser scope validates against. */
const SettingsSchema = z$1.object({
	defaultGranularity: z$1.union(["step", "turn"]).default("step"),
	defaultTrendMode: z$1.union(["total", "delta"]).default("total").loose(),
	defaultFileSort: z$1.union([
		"count",
		"latest",
		"path"
	]).default("count").loose()
});
/** Serve the namespace while a settings provider is composed; inert otherwise. */
function installSettings(ctx) {
	ctx.inject(["settings"], (sctx) => {
		sctx.settings.register(SETTINGS_NAMESPACE, SettingsSchema);
	});
}
//#endregion
//#region src/host/fold.ts
function trimToLastTurns(requests, maxTurns) {
	let runs = 0;
	let start = requests.length;
	let prevTurn;
	for (let i = requests.length - 1; i >= 0; i--) {
		const turn = requests[i].turn;
		if (turn !== prevTurn) {
			if (runs >= maxTurns) break;
			runs++;
			prevTurn = turn;
		}
		start = i;
	}
	return requests.slice(start);
}
function countTurnRuns(requests) {
	let runs = 0;
	let prevTurn;
	for (const r of requests) if (r.turn !== prevTurn) {
		runs++;
		prevTurn = r.turn;
	}
	return runs;
}
function trimState(st, bounds) {
	if (countTurnRuns(st.requests) > bounds.maxKeptTurns) st.requests = trimToLastTurns(st.requests, bounds.maxKeptTurns);
	if (st.requests.length > bounds.maxRequestSteps) st.requests = st.requests.slice(-bounds.maxRequestSteps);
	if (st.events.length > bounds.maxEvents) st.events = st.events.slice(-bounds.maxEvents);
	if (st.archived.length > 0) {
		let drop = 0;
		const oldestReq = st.requests.length > 0 ? st.requests[0].seq : void 0;
		if (oldestReq !== void 0) while (drop < st.archived.length && (st.archived[drop].gone ?? Infinity) <= oldestReq) drop++;
		if (st.archived.length - drop > bounds.maxArchiveNodes) drop = st.archived.length - bounds.maxArchiveNodes;
		if (drop > 0) {
			const floor = st.archived[drop - 1].gone;
			if (floor !== void 0) st.archiveFloor = Math.max(st.archiveFloor ?? 0, floor);
			st.archived = st.archived.slice(drop);
		}
	}
}
function createTimelineState() {
	return {
		surface: [],
		sums: {
			user: 0,
			inject: 0,
			assistant: 0,
			tool: 0
		},
		systemTokens: 0,
		toolsTokens: 0,
		requests: [],
		events: [],
		archived: [],
		callNames: {}
	};
}
function categoryOf(type, message) {
	if (type === "assistant/message") return "assistant";
	if (type === "tool/result") return "tool";
	if (isInjection(message?.source)) return "inject";
	return "user";
}
/**
* Archive removed surface nodes as stamped COPIES — the objects leaving
* `st.surface` are shared with the persisted previous state, so `gone` must
* never be written onto them directly.
*/
function archiveRemoved(st, removed, goneSeq) {
	for (const n of removed) st.archived.push({
		...n,
		gone: goneSeq
	});
}
/**
* The first full text block, recursing through nested content blocks (a tool
* result wraps its text in a `tool-result` block). Unlike `firstText` this
* must NOT truncate/normalize: the skill name is matched off the raw
* `<skill_content name="…">` wrapper.
*/
function nestedText(blocks) {
	if (!Array.isArray(blocks)) return "";
	for (const item of blocks) {
		if (item === null || typeof item !== "object") continue;
		const block = item;
		if (block.type === "text" && typeof block.text === "string" && block.text !== "") return block.text;
		if (block.content !== void 0) {
			const nested = nestedText(block.content);
			if (nested !== "") return nested;
		}
	}
	return "";
}
/**
* The skill name a `skill`-tool result carries. Loaded skills are rendered as
* `<skill_content name="…">…</skill_content>` in the result's text, so the name
* is recovered from the content rather than trusted from the call envelope.
*/
function skillNameOf(msg) {
	const match = nestedText(msg?.content).match(/<skill_content\s+name="([^"]+)"/);
	return match === null ? "" : match[1];
}
function applySurface(st, ev, type, data, message) {
	const cat = categoryOf(type, message ?? void 0);
	const node = {
		seq: ev.seq,
		time: ev.time,
		cat,
		tokens: estimateMessage(message, type === "assistant/message")
	};
	const imgs = imageCountOf(message?.content);
	if (imgs > 0) node.imgs = imgs;
	const source = message?.source;
	const form = source?.form;
	if (typeof form === "string") node.form = form;
	if (type === "assistant/message") {
		const text = firstText(message?.content);
		if (text !== "") node.text = text;
		else {
			const names = toolCallNames(message?.content);
			if (names.length > 0) node.calls = names.slice(0, 3);
		}
	} else if (type === "tool/result") {
		const srcId = source?.callId;
		const blockId = (message?.content?.[0])?.toolCallId;
		const srcEntry = typeof srcId === "string" ? st.callNames[srcId] : void 0;
		const blockEntry = srcEntry === void 0 && typeof blockId === "string" ? st.callNames[blockId] : void 0;
		const toolEntry = srcEntry ?? blockEntry;
		if (toolEntry !== void 0) {
			node.tool = toolEntry.name;
			const timing = ensureTiming(st);
			const dur = durOf(toolEntry.start, ev.time);
			timing.toolsMs += dur;
			timing.toolCalls += 1;
			bumpToolTotals(timing, toolEntry.name, dur);
		}
		if (typeof srcId === "string" || typeof blockId === "string") {
			const kept = {};
			for (const k in st.callNames) if (k !== srcId && k !== blockId) kept[k] = st.callNames[k];
			st.callNames = kept;
		}
		if (data?.error) node.err = true;
	} else if (source?.kind === "skill-invocation") node.skill = typeof source.name === "string" ? source.name : "?";
	else if (source?.kind === "plugin") {
		if (source.form === "notice" && typeof source.summary === "string") node.text = source.summary;
		else if (source.form === "snapshot" && Array.isArray(source.sections)) node.text = source.sections.map((s) => s?.name).filter(Boolean).join(", ").slice(0, 80);
		else {
			const ptext = firstText(message?.content);
			if (ptext !== "") node.text = ptext;
		}
	} else {
		const utext = firstText(message?.content);
		if (utext !== "") node.text = utext;
	}
	const shadowedSeqs = st.pendingShadowedSeqs;
	const shadowEventSeq = st.pendingShadowEventSeq;
	delete st.pendingShadowedSeqs;
	delete st.pendingShadowEventSeq;
	const op = ev.surfaceOp;
	if (op !== null && typeof op === "object" && op.op === "replace") {
		if (Array.isArray(shadowedSeqs) && shadowedSeqs.length > 0) {
			const shadowed = new Set(shadowedSeqs);
			const kept = [];
			const removed = [];
			for (const n of st.surface) if (shadowed.has(n.seq)) {
				st.sums[n.cat] -= n.tokens;
				removed.push(n);
			} else kept.push(n);
			archiveRemoved(st, removed, ev.seq);
			st.surface = kept;
			st.sums[cat] += node.tokens;
			st.surface.push(node);
			if (shadowEventSeq !== void 0) {
				const removedSum = removed.reduce((sum, n) => sum + n.tokens, 0);
				const i = st.events.findIndex((e) => e.seq === shadowEventSeq);
				if (i >= 0) st.events[i] = {
					...st.events[i],
					tokens: Math.max(0, removedSum - node.tokens)
				};
			}
			return node;
		}
		let si = -1;
		let ei = -1;
		for (let i = 0; i < st.surface.length; i++) {
			if (si < 0 && st.surface[i].seq === op.start) si = i;
			if (st.surface[i].seq === op.end) {
				ei = i;
				break;
			}
		}
		if (si >= 0 && ei >= si) {
			const removed = st.surface.splice(si, ei - si + 1, node);
			archiveRemoved(st, removed, ev.seq);
			for (const r of removed) st.sums[r.cat] -= r.tokens;
			st.sums[cat] += node.tokens;
			return node;
		}
	}
	st.surface.push(node);
	st.sums[cat] += node.tokens;
	return node;
}
/**
* One provider-reported usage bucket as a billed count, or null when the
* field carries no readable number. Accepts finite numbers and numeric
* strings; fractions round (some gateways report fractional counts) and
* negatives clamp to 0 — a mis-accounting gateway that reports
* `cached_tokens > prompt_tokens` drives the disjoint uncached-input figure
* below zero, and one raw figure in the state would fail the wire and state
* schemas' `.int().nonnegative()` gates on EVERY later delivery, permanently
* freezing the projection feed for the session (issue #44). NaN, infinities,
* and non-numeric values read as absent.
*/
function tokenCountOf(value) {
	if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
	}
	return null;
}
/**
* The DeepSeek V4 model family a model name prices as — matched on the NAME
* alone (provider-agnostic: official API, proxies, OpenRouter spellings like
* `deepseek/deepseek-v4-flash` all land here). Null for any other model:
* non-V4 usage is simply not priced.
*/
function costFamilyOf(model) {
	if (model === void 0) return null;
	const m = model.toLowerCase();
	if (!m.includes("v4")) return null;
	if (m.includes("flash")) return "flash";
	if (m.includes("pro")) return "pro";
	return null;
}
/**
* DeepSeek's peak windows (Beijing Time, UTC+8): 09:00-12:00 and 14:00-18:00
* on weekdays; off-peak (half the peak rate) covers all other hours plus all
* of Saturday and Sunday.
*/
function isPeakUtc(time) {
	const bj = new Date(time + 288e5);
	const day = bj.getUTCDay();
	if (day === 0 || day === 6) return false;
	const h = bj.getUTCHours();
	return h >= 9 && h < 12 || h >= 14 && h < 18;
}
/**
* Fold one billed request into the session-cost totals, cloning along the
* mutated path only (the untouched branch stays shared with the persisted
* previous state — the apply contract never mutates it in place). The
* buckets arrive sanitized ({@link BilledUsage}), so the totals stay at the
* schemas' non-negative safe integers no matter what the provider reported.
*/
function accumulateCost(st, time, usage) {
	const family = costFamilyOf(st.model);
	if (family === null) return;
	const prev = st.cost ?? {};
	const fam = prev[family] ?? {};
	const period = isPeakUtc(time) ? "peak" : "off";
	const b = fam[period] ?? {
		uncached: 0,
		cacheRead: 0,
		cacheWrite: 0,
		output: 0
	};
	const nextFam = { ...fam };
	nextFam[period] = {
		uncached: b.uncached + usage.input,
		cacheRead: b.cacheRead + usage.cacheRead,
		cacheWrite: b.cacheWrite + usage.cacheWrite,
		output: b.output + usage.output
	};
	const next = { ...prev };
	next[family] = nextFam;
	st.cost = next;
}
/**
* Advance the fold over ONE committed session event under the projection
* contract. Uninteresting events return the same reference (`Object.is` gates
* the change feed); any change returns a new reference over a lazy shallow
* clone, so the persisted state is never mutated in place by the caller.
* `bounds` come from the plugin config (config.ts) — retention only, they
* never change the state shape.
*/
/** The timing card's per-tool ranking cap: the busiest 16 names are kept. */
const TOOL_TIMING_CAP = 16;
/** Non-negative, NaN-proof duration between two instants (hostile times degrade to 0). */
function durOf(from, to) {
	if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
	return Math.max(0, to - from);
}
/**
* Whether a stream chunk carries a non-empty token delta — the first-token
* marker the TTFT fold waits for (the same rule as the harness's own
* session-stats fold). Shape-guarded: a malformed chunk is just not a token.
*/
function isTokenDelta(chunk) {
	if (chunk === null || typeof chunk !== "object") return false;
	const c = chunk;
	switch (c.type) {
		case "text-delta":
		case "reasoning-delta": return typeof c.text === "string" && c.text !== "";
		case "tool-call-delta": return typeof c.argumentsDelta === "string" && c.argumentsDelta !== "" || c.name !== void 0;
		default: return false;
	}
}
/**
* The fold's private timing accumulator: created on first use, and CLONED on
* every later ensure() (see `applyTimeline`) — the object left in the
* persisted previous state is never written into in place.
*/
function ensureTiming(st) {
	if (st.timing === void 0) st.timing = {
		wallMs: 0,
		ttftMs: 0,
		genMs: 0,
		calls: 0,
		toolsMs: 0,
		toolCalls: 0,
		tools: {}
	};
	return st.timing;
}
/**
* Tally one completed tool call into the per-name ranking, bounded to
* TOOL_TIMING_CAP names: repeated names update in place, a new name beyond
* the cap evicts the smallest tally first (the ranking's tail), so state
* stays bounded even over a hostile log of unique names.
*/
function bumpToolTotals(timing, name, ms) {
	if (!Object.hasOwn(timing.tools, name)) {
		if (Object.keys(timing.tools).length >= TOOL_TIMING_CAP) {
			let minKey = "";
			let minMs = Infinity;
			for (const k in timing.tools) if (timing.tools[k].ms < minMs) {
				minMs = timing.tools[k].ms;
				minKey = k;
			}
			const kept = {};
			for (const k in timing.tools) if (k !== minKey) kept[k] = timing.tools[k];
			timing.tools = kept;
		}
		timing.tools[name] = {
			calls: 1,
			ms
		};
		return;
	}
	const cur = timing.tools[name];
	timing.tools[name] = {
		calls: cur.calls + 1,
		ms: cur.ms + ms
	};
}
function applyTimeline(state, event, bounds) {
	let st;
	const ensure = () => st ??= {
		...state,
		surface: [...state.surface],
		sums: { ...state.sums },
		requests: [...state.requests],
		events: [...state.events],
		archived: [...state.archived],
		callNames: { ...state.callNames },
		...state.timing !== void 0 ? { timing: {
			...state.timing,
			tools: { ...state.timing.tools }
		} } : {}
	};
	const data = event.data;
	try {
		switch (event.type) {
			case "request/header": {
				const header = data?.header ?? {};
				const tools = Array.isArray(header.tools) ? header.tools : [];
				const s = ensure();
				s.toolsTokens = estimateToolsTotal(tools);
				s.systemTokens = estimateSystemTokens(header.system);
				if (header.config && typeof header.config.model === "string") s.model = header.config.model;
				if (header.config && typeof header.config.provider === "string") s.provider = header.config.provider;
				if ((data?.reason === "change" || data?.reason === "resume") && s.model && s.lastModel && s.model !== s.lastModel) s.events.push({
					seq: event.seq,
					time: event.time,
					kind: "model",
					from: s.lastModel,
					to: s.model
				});
				if (s.model) s.lastModel = s.model;
				break;
			}
			case "request/context": {
				const s = ensure();
				if (data && typeof data.contextWindow === "number") s.contextWindow = data.contextWindow;
				if (data && typeof data.model === "string") s.model = data.model;
				if (data && typeof data.provider === "string") s.provider = data.provider;
				break;
			}
			case "tool/call":
				if (data && typeof data.callId === "string" && typeof data.name === "string") {
					const s = ensure();
					s.callNames[data.callId] = {
						name: data.name,
						start: event.time
					};
				}
				break;
			case "assistant/chunk": {
				const start = state.stepStart;
				if (start === void 0 || start.firstToken !== void 0) return state;
				if (!isTokenDelta(data?.chunk)) return state;
				const s = ensure();
				s.stepStart = {
					time: start.time,
					firstToken: event.time
				};
				break;
			}
			case "step/start": {
				const s = ensure();
				s.stepStart = { time: event.time };
				break;
			}
			case "step/end": {
				const start = state.stepStart;
				if (start === void 0) return state;
				const s = ensure();
				ensureTiming(s).wallMs += durOf(start.time, event.time);
				delete s.stepStart;
				break;
			}
			case "user/message": {
				const msg = deriveEventMessage(event);
				const s = ensure();
				const node = applySurface(s, event, event.type, data, msg);
				const source = msg?.source;
				if (isInjection(source)) {
					const rec = {
						seq: event.seq,
						time: event.time,
						kind: "inject",
						form: source.form || "context",
						tokens: node.tokens
					};
					if (source.kind === "skill-invocation") {
						rec.sub = "skill";
						rec.name = typeof source.name === "string" ? source.name : "?";
					} else {
						const label = injectionSourceName(source);
						if (label !== "") rec.name = label;
						if (source.form === "notice" && typeof source.summary === "string" && source.summary !== "") rec.detail = source.summary;
					}
					s.events.push(rec);
				}
				break;
			}
			case "tool/result": {
				const toolMsg = deriveEventMessage(event);
				const s = ensure();
				const node = applySurface(s, event, event.type, data, toolMsg);
				if (node.tool === "skill" || node.tool === void 0) {
					const name = skillNameOf(toolMsg);
					if (name !== "") {
						node.skill = name;
						s.events.push({
							seq: event.seq,
							time: event.time,
							kind: "inject",
							form: "instructions",
							sub: "skill",
							name,
							tokens: node.tokens
						});
					}
				}
				break;
			}
			case "assistant/message": {
				const usage = data?.usage;
				const s = ensure();
				const total = s.systemTokens + s.toolsTokens + s.sums.user + s.sums.inject + s.sums.assistant + s.sums.tool;
				const record = {
					time: event.time,
					seq: event.seq,
					system: s.systemTokens,
					tools: s.toolsTokens,
					user: s.sums.user,
					inject: s.sums.inject,
					assistant: s.sums.assistant,
					tool: s.sums.tool,
					total
				};
				if (data && typeof data.turn === "number") record.turn = data.turn;
				if (data && typeof data.step === "number") record.step = data.step;
				if (usage !== null && typeof usage === "object") {
					const input = tokenCountOf(usage.inputTokens);
					const cacheRead = tokenCountOf(usage.cacheReadTokens);
					const cacheWrite = tokenCountOf(usage.cacheWriteTokens);
					const output = tokenCountOf(usage.outputTokens);
					if (input !== null || cacheRead !== null || cacheWrite !== null || output !== null) {
						record.prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
						if (cacheRead !== null) record.cacheRead = cacheRead;
						if (output !== null) record.output = output;
						accumulateCost(s, event.time, {
							input: input ?? 0,
							cacheRead: cacheRead ?? 0,
							cacheWrite: cacheWrite ?? 0,
							output: output ?? 0
						});
					}
				}
				s.requests.push(record);
				const timing = ensureTiming(s);
				timing.calls += 1;
				const stepStart = state.stepStart;
				if (stepStart !== void 0 && stepStart.firstToken !== void 0) {
					timing.ttftMs += durOf(stepStart.time, stepStart.firstToken);
					timing.genMs += durOf(stepStart.firstToken, event.time);
				}
				const asstMsg = deriveEventMessage(event);
				applySurface(s, event, event.type, data, asstMsg);
				break;
			}
			case "plan/mode":
				if (data && typeof data.active === "boolean") ensure().events.push({
					seq: event.seq,
					time: event.time,
					kind: "mode",
					name: data.active ? "plan.on" : "plan.off"
				});
				break;
			case "compaction/summary":
			case "compaction/prune": {
				const s = ensure();
				if (data && Array.isArray(data.shadowedSeqs)) {
					s.pendingShadowedSeqs = data.shadowedSeqs.filter((x) => typeof x === "number");
					s.pendingShadowEventSeq = event.seq;
				}
				s.events.push({
					seq: event.seq,
					time: event.time,
					kind: event.type === "compaction/summary" ? "compaction" : "prune",
					tokens: data && typeof data.shadowedTokenCount === "number" ? data.shadowedTokenCount : 0,
					...event.type === "compaction/summary" && data && Array.isArray(data.shadowedSeqs) ? { count: data.shadowedSeqs.length } : {}
				});
				break;
			}
			default: return state;
		}
	} catch {
		st = void 0;
	}
	if (st !== void 0) {
		trimState(st, bounds);
		return st;
	}
	return state;
}
/**
* Serve the projection's wire view: bound the surface nodes to the newest tail and attach each event to the request around it; stamp
* COPIES
* — the persisted state objects are never mutated.
*/
function buildTimelineView(state, bounds) {
	const surfaceTotal = state.sums.user + state.sums.inject + state.sums.assistant + state.sums.tool;
	const result = {
		ok: true,
		...state.model !== void 0 ? { model: state.model } : {},
		...state.provider !== void 0 ? { provider: state.provider } : {},
		...state.contextWindow !== void 0 ? { contextWindow: state.contextWindow } : {},
		current: {
			system: state.systemTokens,
			tools: state.toolsTokens,
			user: state.sums.user,
			inject: state.sums.inject,
			assistant: state.sums.assistant,
			tool: state.sums.tool,
			total: surfaceTotal + state.systemTokens + state.toolsTokens
		},
		images: state.surface.reduce((n, node) => n + (node.imgs ?? 0), 0),
		toolCalls: state.surface.reduce((n, node) => node.cat === "tool" ? n + 1 : n, 0),
		requests: state.requests.map((r) => ({ ...r })),
		events: state.events.map((e) => ({ ...e })),
		nodes: [],
		droppedNodes: 0,
		archive: state.archived.map((n) => ({ ...n }))
	};
	if (state.cost !== void 0) {
		const copyFam = (f) => {
			if (f === void 0) return void 0;
			const out = {};
			if (f.peak !== void 0) out.peak = { ...f.peak };
			if (f.off !== void 0) out.off = { ...f.off };
			return out;
		};
		const cost = {};
		const flash = copyFam(state.cost.flash);
		if (flash !== void 0) cost.flash = flash;
		const pro = copyFam(state.cost.pro);
		if (pro !== void 0) cost.pro = pro;
		result.cost = cost;
	}
	if (state.timing !== void 0) {
		const tools = {};
		for (const k in state.timing.tools) tools[k] = { ...state.timing.tools[k] };
		result.timing = {
			...state.timing,
			tools
		};
	}
	const overflowCount = Math.max(0, state.surface.length - bounds.maxNodes);
	const overflow = state.surface.slice(0, overflowCount);
	const tail = state.surface.slice(overflowCount);
	const pinned = overflow.filter((n) => n.cat === "inject");
	result.nodes = pinned.length > 0 ? [...pinned, ...tail] : tail;
	result.droppedNodes = overflowCount - pinned.length;
	if (result.droppedNodes > 0) {
		let floor = 0;
		for (const n of overflow) if (n.cat !== "inject") floor = Math.max(floor, n.seq);
		result.surfaceFloor = floor;
	}
	if (state.archiveFloor !== void 0) result.archiveFloor = state.archiveFloor;
	const requests = result.requests;
	const events = result.events;
	let ri = 0;
	for (const ev of events) {
		while (ri < requests.length && requests[ri].seq <= ev.seq) ri++;
		const next = requests.at(ri);
		const prev = ri > 0 ? requests.at(ri - 1) : void 0;
		if (next !== void 0 && typeof next.turn === "number" && typeof next.step === "number") {
			ev.turn = next.turn;
			ev.step = next.step;
		}
		if (prev !== void 0 && typeof prev.turn === "number" && typeof prev.step === "number") {
			ev.fromTurn = prev.turn;
			ev.fromStep = prev.step;
		}
	}
	return result;
}
//#endregion
//#region src/host/timeline.ts
/**
* The `contextTimeline` session projection unit — the plugin's data plane.
*
* This is the whole Host half after the v0.9 data-path migration: instead of
* serving snapshots over a custom `/dsh-context` RPC channel, the plugin
* registers one pure projection unit on the harness's
* `ctx.sessionProjections` registry. The framework then:
*   - drives the fold per committed `session/event` (eager, incremental),
*   - persists the unit state through `ctx.sessionProjectionCache`
*     (checkpointed rows, cold-read ladder, resume-safe),
*   - delivers finished values to the browser as a `session/projection` push
*     frame plus a tail-page baseline, where the Client reads them through
*     the framework-standard `useProjection('contextTimeline')` seat.
*
* The unit is pure mathematics (init/apply/view) — it holds no subscriptions
* and never touches the client. The wire value is the same Snapshot the UI
* has always rendered (shared/types.ts), so the Client renders unchanged.
*/
/** Validate the wire payload before it leaves the host (strict: no drift). */
const surfaceNodeSchema = z.object({
	seq: z.number().int().nonnegative(),
	time: z.number().optional(),
	cat: z.enum([
		"user",
		"inject",
		"assistant",
		"tool"
	]),
	tokens: z.number().int().nonnegative(),
	imgs: z.number().int().nonnegative().optional(),
	gone: z.number().int().nonnegative().optional(),
	form: z.string().optional(),
	text: z.string().optional(),
	tool: z.string().optional(),
	err: z.boolean().optional(),
	skill: z.string().optional(),
	calls: z.array(z.string()).optional()
}).strict();
const requestRecordSchema = z.object({
	turn: z.number().optional(),
	step: z.number().optional(),
	time: z.number(),
	seq: z.number(),
	system: z.number().int().nonnegative(),
	tools: z.number().int().nonnegative(),
	user: z.number().int().nonnegative(),
	inject: z.number().int().nonnegative(),
	assistant: z.number().int().nonnegative(),
	tool: z.number().int().nonnegative(),
	total: z.number().int().nonnegative(),
	prompt: z.number().int().nonnegative().optional(),
	cacheRead: z.number().int().nonnegative().optional(),
	output: z.number().int().nonnegative().optional(),
	stepCount: z.number().int().positive().optional()
}).strict();
const contextEventSchema = z.object({
	seq: z.number(),
	time: z.number(),
	kind: z.enum([
		"compaction",
		"prune",
		"inject",
		"model",
		"mode"
	]),
	form: z.string().optional(),
	tokens: z.number().optional(),
	count: z.number().optional(),
	sub: z.string().optional(),
	name: z.string().optional(),
	detail: z.string().optional(),
	from: z.string().optional(),
	to: z.string().optional(),
	fromTurn: z.number().optional(),
	fromStep: z.number().optional(),
	turn: z.number().optional(),
	step: z.number().optional()
}).strict();
const currentSchema = z.object({
	system: z.number().int().nonnegative(),
	tools: z.number().int().nonnegative(),
	user: z.number().int().nonnegative(),
	inject: z.number().int().nonnegative(),
	assistant: z.number().int().nonnegative(),
	tool: z.number().int().nonnegative(),
	total: z.number().int().nonnegative()
}).strict();
const costBucketsSchema = z.object({
	uncached: z.number().int().nonnegative(),
	cacheRead: z.number().int().nonnegative(),
	cacheWrite: z.number().int().nonnegative(),
	output: z.number().int().nonnegative()
}).strict();
const costFamilySchema = z.object({
	peak: costBucketsSchema.optional(),
	off: costBucketsSchema.optional()
}).strict();
const toolTimingSchema = z.object({
	calls: z.number().int().nonnegative(),
	ms: z.number().nonnegative()
}).strict();
const timingTotalsSchema = z.object({
	wallMs: z.number().nonnegative(),
	ttftMs: z.number().nonnegative(),
	genMs: z.number().nonnegative(),
	calls: z.number().int().nonnegative(),
	toolsMs: z.number().nonnegative(),
	toolCalls: z.number().int().nonnegative(),
	tools: z.record(z.string(), toolTimingSchema)
}).strict();
const contextTimelineSchema = z.object({
	ok: z.literal(true),
	model: z.string().optional(),
	provider: z.string().optional(),
	contextWindow: z.number().optional(),
	current: currentSchema,
	images: z.number().int().nonnegative().optional(),
	toolCalls: z.number().int().nonnegative().optional(),
	requests: z.array(requestRecordSchema),
	events: z.array(contextEventSchema),
	cost: z.object({
		flash: costFamilySchema.optional(),
		pro: costFamilySchema.optional()
	}).strict().optional(),
	timing: timingTotalsSchema.optional(),
	nodes: z.array(surfaceNodeSchema),
	droppedNodes: z.number().int().nonnegative(),
	archive: z.array(surfaceNodeSchema),
	surfaceFloor: z.number().int().nonnegative().optional(),
	archiveFloor: z.number().int().nonnegative().optional()
}).strict();
/**
* The persisted fold-state schema (the dsh 0.1.1-rc.1+ `stateSchema`
* contract). Validates the plain-JSON `TimelineState` before a checkpoint
* row seeds a fold — the same shape guarantee the projection cache's
* plain-JSON precondition already enforces at write time.
*/
const timelineStateSchema = z.object({
	surface: z.array(surfaceNodeSchema),
	sums: z.object({
		user: z.number().int().nonnegative(),
		inject: z.number().int().nonnegative(),
		assistant: z.number().int().nonnegative(),
		tool: z.number().int().nonnegative()
	}).strict(),
	systemTokens: z.number().int().nonnegative(),
	toolsTokens: z.number().int().nonnegative(),
	model: z.string().optional(),
	provider: z.string().optional(),
	lastModel: z.string().optional(),
	contextWindow: z.number().optional(),
	requests: z.array(requestRecordSchema),
	events: z.array(contextEventSchema),
	archived: z.array(surfaceNodeSchema),
	cost: z.object({
		flash: costFamilySchema.optional(),
		pro: costFamilySchema.optional()
	}).strict().optional(),
	archiveFloor: z.number().optional(),
	timing: timingTotalsSchema.optional(),
	stepStart: z.object({
		time: z.number(),
		firstToken: z.number().optional()
	}).strict().optional(),
	callNames: z.record(z.string(), z.object({
		name: z.string(),
		start: z.number()
	}).strict()),
	pendingShadowedSeqs: z.array(z.number()).optional(),
	pendingShadowEventSeq: z.number().optional()
});
/**
* The context-timeline projection unit, created per plugin instance with its
* config-resolved retention bounds (config.ts), and registered on
* `ctx.sessionProjections`. Registry lifecycle notes (mirrored from the
* harness contract): registration is an effect on the caller's fiber — an
* unloaded Host half removes the key, and clients read it as capability
* absence. `stateVersion` must be bumped whenever the persisted state shape
* or fold semantics change (invalidation of cached rows); config-only
* changes never require it (bounds tune retention, not state shape).
*
* The definition carries the session-projection contract served by every
* supported harness (see compat.ts): `stateSchema` + a REQUIRED `wire` block.
* (The return type is the mirrored contract, not the installed dts
* `ProjectionDefinition`: the registry's wired-register overload demands
* `wire` PRESENT, which the dts's optional `wire?` fails.) Without the
* `wire` block the registry treats the unit as host-only and never delivers
* `contextTimeline` to the browser (the Context tab would stay on its
* loading screen forever).
*/
function createContextTimelineDefinition(config) {
	const bounds = resolveBounds(config);
	const view = (state) => buildTimelineView(state, bounds);
	return {
		key: "contextTimeline",
		stateSchema: timelineStateSchema,
		wire: {
			viewSchema: contextTimelineSchema,
			view
		},
		init: () => createTimelineState(),
		apply: (state, event) => applyTimeline(state, event, bounds),
		stateVersion: 13
	};
}
//#endregion
//#region src/host/index.ts
const name = "dsh-context";
const inject = ["sessionProjections"];
function apply(ctx, config) {
	const attribution = createToolAttribution(ctx);
	ctx.sessionProjections.register(createContextTimelineDefinition(config));
	ctx.sessionProjections.register(createContextHeadersDefinition((name) => attribution.ownerOf(name)));
	installSettings(ctx);
}
//#endregion
export { Config, apply, inject, name };
