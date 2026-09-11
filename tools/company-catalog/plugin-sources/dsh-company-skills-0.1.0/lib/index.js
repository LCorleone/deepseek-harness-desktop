import { existsSync, readFileSync, statSync } from "node:fs";
import { BUNDLED_SKILL_RANK } from "@deepseek-ai/dsh-skill";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/codec.ts
/**
* Company skill bundle codec (P6 batch 2) — the decoder the shipped plugin owns.
*
* This is an independent re-implementation of the algorithm in
* `tools/company-skills/lib/codec.mjs`, on purpose: the plugin is a standalone
* published artifact and must not import the author-machine tool. The key
* string, the cycled XOR, and the canonical-standard-base64 check are
* identical by construction, and `tests/container.spec.ts` packs real skills
* with that tool (through its CLI) and decrypts the artifact through this
* module, so the two copies cannot drift silently.
*
* Only the decode direction ships. Writing a bundle is an author-machine
* concern (`tools/company-skills/pack.mjs`); a runtime encoder would be dead
* code with a second chance to disagree.
*
* OBVIOUS DISCLAIMER: obfuscation is NOT encryption. The key is reproduced in
* this shipped file by necessity, so it only keeps skill bodies out of
* plaintext greps, out of `strings` on the asset, and out of casual copies of
* the profile directory. `tools/company-skills/README.zh.md` records the
* accepted bar ("防普通用户") and the single-shared-key gap.
*
* The key is never read from a file and never overridden by the environment:
* an env-selected key would only produce bundles nothing else can read back.
*/
/**
* Fixed XOR key. NOT a secret (see the header): it is reproduced here and in
* the author-machine packer by necessity, so treat it as a public constant
* that only raises the cost of accidental disclosure.
*/
const OBFUSCATION_KEY = "dsh-company-skill-bundle-obfuscation-key-v1";
/** Name of the single ESM export a generated `pack.mjs` module carries. */
const BUNDLE_BLOB_EXPORT_NAME = "COMPANY_SKILL_BUNDLE_BLOB";
const KEY_BYTES = Buffer.from(OBFUSCATION_KEY, "utf8");
/**
* XOR a byte sequence with the cycled key bytes. The transform is its own
* inverse, which is what makes {@link decodeBundleBlob} a one-liner.
* @param bytes - input bytes; the caller's buffer is copied.
* @returns the transformed bytes.
*/
function xorKeyBytes(bytes) {
	const out = Buffer.from(bytes);
	for (let index = 0; index < out.length; index += 1) out[index] = out[index] ^ KEY_BYTES[index % KEY_BYTES.length];
	return out;
}
/**
* Decode one line of canonical standard base64; anything else is rejected.
* Mirrors `tools/company-skills/lib/codec.mjs` so both sides fail the same way.
* @param value - the candidate base64 string.
* @param what - subject for error messages.
* @returns the decoded bytes.
*/
function decodeCanonicalBase64(value, what) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${what} must be a non-empty standard base64 string`);
	if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error(`${what} is not standard base64 (single line, no whitespace or padding noise)`);
	const buffer = Buffer.from(value, "base64");
	if (buffer.byteLength === 0 || buffer.toString("base64") !== value) throw new Error(`${what} is not canonical standard base64`);
	return buffer;
}
/**
* Decode one blob back into its JSON document. The caller is responsible for
* `JSON.parse` and for validating the document; this function only undoes the
* codec.
* @param blob - standard base64 blob, no whitespace.
* @param what - subject for error messages.
* @returns the decoded JSON document.
*/
function decodeBundleBlob(blob, what = "bundle blob") {
	return xorKeyBytes(decodeCanonicalBase64(blob, what)).toString("utf8");
}
/**
* Pull the blob out of either a raw base64 asset or a generated module, so the
* loader accepts both shipped forms. Surrounding whitespace is ignored, which
* keeps a checked-out asset with a trailing newline loadable.
* @param text - file contents.
* @returns the base64 blob.
*/
function extractBundleBlob(text) {
	if (typeof text !== "string") throw new TypeError("extractBundleBlob expects file text");
	const trimmed = text.trim();
	const match = trimmed.match(new RegExp(`export const ${BUNDLE_BLOB_EXPORT_NAME} = "([A-Za-z0-9+/=]+)"`, "u"));
	if (match !== null) return match[1];
	if (/^[A-Za-z0-9+/=]+$/u.test(trimmed)) return trimmed;
	throw new Error(`the input carries neither a raw base64 blob nor a generated bundle module (expected an \`export const ${BUNDLE_BLOB_EXPORT_NAME}\` export from pack.mjs)`);
}
//#endregion
//#region src/bundle.ts
/**
* One company skill bundle (P6 batch 2): the shape `tools/company-skills`
* packs and this plugin decodes.
*
* The field rules are a deliberate re-implementation of
* `tools/company-skills/lib/bundle.mjs`; the plugin cannot import that tool,
* and `tests/container.spec.ts` pins the two implementations against each
* other (the same packed bytes must decode to the same canonical document
* here). Kept identical:
*
*  - the exact top-level field set `{name, description, body, scripts, assets}`;
*  - the exact entry field set `{path, content}`;
*  - the kebab-case name grammar shared with the runtime registry;
*  - the 500-character description bound, which is the catalog truncation
*    bound (`catalogDescriptionMaxLength`), so an index entry is never
*    silently cut;
*  - the per-file (1 MiB) and whole-document (4 MiB) byte bounds;
*  - bundle-root-relative POSIX entry paths, which is the addressing
*    `resourceBase: { kind: 'opaque' }` implies (a script reads
*    `reference/pptd.md`, never `../reference/pptd.md`).
*
* Entry paths are keyed by their **source-skill-relative** location, so the
* layout a collected skill shipped with is preserved verbatim:
* `scripts/**` entries form the executable addressing index (`scripts[]`) and
* every other regular file rides in `assets[]` at its own relative path
* (`editor/index.html`, `reference/pptd.md`, `LICENSE.txt`). The batch-3
* executor materializes both arrays back into exactly that tree.
*
* Deliberately NOT re-checked here: the packed-reference closure (every
* `scripts/…`/`assets/…` literal a body or script mentions must be carried).
* That is an authoring invariant the packer enforces before the blob is
* written; re-deriving it at runtime would only add a second place for the
* two implementations to disagree, and a missed reference is a batch-3
* execution-time concern, not a catalog one.
*/
/** The public skill-name grammar, shared with the runtime registry. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/**
* Largest single carried file (body, one script, or one asset). Sized for
* the first real collected skill set: ppt-designer ships a 4.7 MiB font
* table and a 2.4 MiB WASM binary inside its editor mirror.
*/
const FILE_MAX_BYTES = 8 * 1024 * 1024;
/**
* Largest canonical bundle JSON document — the unit a container element
* carries. ppt-designer's canonical document measures ≈ 43 MiB (33 MiB of
* sources base64-encoded), so the bound is set above it with headroom.
*/
const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
/** Directory prefix every `scripts[]` entry must carry — the executable index. */
const SCRIPTS_DIR = "scripts";
/**
* The directory name the first collected skill set happens to use for
* resources. It is no longer a required prefix: every entry outside
* `scripts/` is an `assets[]` entry at its own source-relative path.
*/
/** Canonical fields of one bundle element, in document order. */
const BUNDLE_FIELDS = Object.freeze([
	"name",
	"description",
	"body",
	"scripts",
	"assets"
]);
/** Canonical fields of one `scripts[]`/`assets[]` entry, in document order. */
const ENTRY_FIELDS = Object.freeze(["path", "content"]);
const CONTROL_PATTERN$1 = /[\u0000-\u001f\u007f]/u;
const PATH_PATTERN = /^[A-Za-z0-9._@%+~/-]+$/u;
const invalid$1 = (message) => /* @__PURE__ */ new Error(`invalid skill bundle: ${message}`);
/** Code-point ordering — the comparator the skill registry sorts with. */
function compareCodePoints(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}
function isPlainObject$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sameKeySet$1(keys, expected) {
	const actual = [...keys].sort(compareCodePoints);
	const wanted = [...expected].sort(compareCodePoints);
	return actual.length === wanted.length && wanted.every((name, index) => actual[index] === name);
}
/** Decode one entry's content after its shape checks pass. */
function decodeEntryContent(entry, site) {
	const bytes = decodeCanonicalBase64(entry.content, `${site}.content`);
	if (bytes.byteLength > 8388608) throw invalid$1(`${site}.content is ${String(bytes.byteLength)} bytes; the per-file bound is ${String(FILE_MAX_BYTES)}`);
	return bytes;
}
/**
* Validate one `scripts[]`/`assets[]` entry path.
* @param path - the candidate bundle-relative path.
* @param site - subject for error messages.
* @param kind - `script` requires the `scripts/` prefix; `asset` forbids it.
*/
function validateEntryPath(path, site, kind) {
	if (typeof path !== "string" || path.length === 0) throw invalid$1(`${site}.path must be a non-empty bundle-relative POSIX path`);
	if (path.length > 200) throw invalid$1(`${site}.path is longer than the ${String(200)}-character bound`);
	if (path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.includes("\\")) throw invalid$1(`${site}.path must be relative and use forward slashes ("${path}")`);
	if (!PATH_PATTERN.test(path)) throw invalid$1(`${site}.path carries characters the loader cannot address ("${path}")`);
	if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw invalid$1(`${site}.path must be a normalized relative path without "." or ".." segments ("${path}")`);
	if (kind === "script") {
		if (!path.startsWith(`scripts/`)) throw invalid$1(`${site}.path must live under ${SCRIPTS_DIR}/ ("${path}")`);
		return path;
	}
	if (path === "scripts" || path.startsWith(`scripts/`)) throw invalid$1(`${site}.path must not live under ${SCRIPTS_DIR}/ — that tree is the executable index ("${path}")`);
	return path;
}
/** Read one array field, enforcing shape, role, uniqueness, and content bounds. */
function validateEntryArray(value, field, kind) {
	if (!Array.isArray(value)) throw invalid$1(`${field} must be an array of {path, content} entries`);
	const seen = /* @__PURE__ */ new Set();
	const entries = [];
	for (const [index, candidate] of value.entries()) {
		const site = `${field}[${String(index)}]`;
		if (!isPlainObject$1(candidate)) throw invalid$1(`${site} must be an object`);
		if (!sameKeySet$1(Object.keys(candidate), ENTRY_FIELDS)) throw invalid$1(`${site} must carry exactly path and content`);
		const path = validateEntryPath(candidate.path, site, kind);
		if (seen.has(path)) throw invalid$1(`${site}.path "${path}" duplicates an earlier entry`);
		seen.add(path);
		const content = candidate.content;
		if (typeof content !== "string") throw invalid$1(`${site}.content must be a base64 string`);
		const entry = {
			path,
			content
		};
		decodeEntryContent(entry, site);
		entries.push(entry);
	}
	return entries;
}
/** Sort entries by path so a decoded document never depends on element order. */
function sortEntries(entries) {
	return [...entries].sort((left, right) => compareCodePoints(left.path, right.path)).map((entry) => ({
		path: entry.path,
		content: entry.content
	}));
}
/**
* Validate one container element and return it in canonical field and entry
* order. This is the only path that reads a body, so `list()` stays
* index-only; it throws on the first violation and names the offending field.
* @param document - the candidate element.
* @returns the canonical bundle.
*/
function validateSkillBundle(document) {
	if (!isPlainObject$1(document)) throw invalid$1("the document must be an object");
	if (!sameKeySet$1(Object.keys(document), BUNDLE_FIELDS)) throw invalid$1(`the document must carry exactly ${BUNDLE_FIELDS.join(", ")}`);
	const { name, description, body } = document;
	if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name)) throw invalid$1(`name must be kebab-case matching ^[a-z0-9]+(?:-[a-z0-9]+)*$ (got ${JSON.stringify(name)})`);
	if (typeof description !== "string" || description.length === 0) throw invalid$1(`${name}: description must be a non-empty string (the catalog index needs it)`);
	if (description.length > 500) throw invalid$1(`${name}: description is ${String(description.length)} characters; the catalog bound is ${String(500)} and a longer one would be silently truncated`);
	if (CONTROL_PATTERN$1.test(description)) throw invalid$1(`${name}: description must be a single line without control characters`);
	if (description !== description.trim()) throw invalid$1(`${name}: description must not carry leading or trailing whitespace`);
	if (typeof body !== "string" || body.length === 0) throw invalid$1(`${name}: body must be a non-empty string`);
	if (Buffer.byteLength(body, "utf8") > 8388608) throw invalid$1(`${name}: body exceeds the ${String(FILE_MAX_BYTES)}-byte per-file bound`);
	const scripts = validateEntryArray(document.scripts, "scripts", "script");
	const assets = validateEntryArray(document.assets, "assets", "asset");
	const canonical = {
		name,
		description,
		body,
		scripts: sortEntries(scripts),
		assets: sortEntries(assets)
	};
	const bytes = Buffer.byteLength(JSON.stringify(canonical), "utf8");
	if (bytes > 67108864) throw invalid$1(`${name}: the bundle is ${String(bytes)} bytes; the bound is ${String(BUNDLE_MAX_BYTES)}`);
	return canonical;
}
/** Canonical fields of the container document, in order. */
const CONTAINER_FIELDS = Object.freeze(["version", "skills"]);
/** Largest accepted container document, bytes of canonical JSON; 2 × the per-skill bound. */
const CONTAINER_MAX_BYTES = 2 * BUNDLE_MAX_BYTES;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const invalid = (message) => /* @__PURE__ */ new Error(`invalid skill container: ${message}`);
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sameKeySet(keys, expected) {
	const actual = [...keys].sort(compareCodePoints);
	const wanted = [...expected].sort(compareCodePoints);
	return actual.length === wanted.length && wanted.every((name, index) => actual[index] === name);
}
/**
* Validate one element's index fields. A body, script, or asset is never
* inspected here: an element with a broken payload still lists, and fails
* loudly at `get()` instead of emptying the whole catalog.
* @param value - the candidate element.
* @param site - subject for error messages.
* @returns the validated index entry.
*/
function validateElementIndex(value, site) {
	if (!isPlainObject(value)) throw invalid(`${site} must be an object`);
	if (!sameKeySet(Object.keys(value), BUNDLE_FIELDS)) throw invalid(`${site} must carry exactly ${BUNDLE_FIELDS.join(", ")}`);
	const { name, description } = value;
	if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name)) throw invalid(`${site}.name must be kebab-case matching ^[a-z0-9]+(?:-[a-z0-9]+)*$ (got ${JSON.stringify(name)})`);
	if (typeof description !== "string" || description.length === 0) throw invalid(`${site}.description must be a non-empty string (the catalog index needs it)`);
	if (description.length > 500) throw invalid(`${site}.description is ${String(description.length)} characters; the catalog bound is ${String(500)} and a longer one would be silently truncated`);
	if (CONTROL_PATTERN.test(description) || description !== description.trim()) throw invalid(`${site}.description must be a single trimmed line without control characters`);
	return {
		name,
		description,
		element: value
	};
}
/**
* Parse one canonical container JSON document into per-skill index entries.
*
* A duplicate name is rejected outright rather than resolved first-wins: the
* catalog is authored, not user data, so a duplicate is a packaging bug that
* must fail the load loudly instead of silently hiding one skill. (The writer
* rejects it too, so a duplicate can only appear in a hand-edited or corrupt
* asset.)
* @param document - the candidate document.
* @returns the validated index entries, in document order.
*/
function parseContainer(document) {
	if (!isPlainObject(document)) throw invalid("the document must be an object");
	if (!sameKeySet(Object.keys(document), CONTAINER_FIELDS)) throw invalid(`the document must carry exactly ${CONTAINER_FIELDS.join(", ")}`);
	if (document.version !== 1) throw invalid(`version must be ${String(1)} (got ${JSON.stringify(document.version)})`);
	const skills = document.skills;
	if (!Array.isArray(skills)) throw invalid("skills must be an array of skill bundles");
	if (skills.length === 0) throw invalid("skills must carry at least one skill; an empty container ships nothing");
	const entries = skills.map((value, index) => validateElementIndex(value, `skills[${String(index)}]`));
	const seen = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		if (seen.has(entry.name)) throw invalid(`skills repeats the name "${entry.name}"`);
		seen.add(entry.name);
	}
	const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
	if (bytes > CONTAINER_MAX_BYTES) throw invalid(`the container is ${String(bytes)} bytes; the bound is ${String(CONTAINER_MAX_BYTES)}`);
	return entries;
}
/**
* Decode one shipped asset — raw base64 blob or a generated module — into
* per-skill index entries.
* @param text - the asset file contents.
* @returns the validated index entries.
*/
function decodeContainer(text) {
	return parseContainer(JSON.parse(decodeBundleBlob(extractBundleBlob(text), "company skills container")));
}
//#endregion
//#region src/catalog.ts
/**
* The company-skill catalog: one shipped container asset → N indexed skills.
*
* Load policy (the "does not blow up the host" choice): a missing, unreadable,
* corrupt, empty, or future-versioned asset yields an *empty catalog with a
* reason*, never a throw. Two things follow, and both are deliberate:
*
*  - the module can be imported and the provider registered on any profile,
*    even one whose asset was lost or tampered with, so a bad skill bundle can
*    never take the whole boot down (a throw during plugin import fails the
*    profile composition, which is far worse than an empty catalog);
*  - `list()` returns an empty catalog and `get()` returns `undefined`, which
*    is exactly what the registry already handles for a provider with nothing
*    to offer, so every consumer keeps its existing behaviour.
*
* The reason travels with the catalog instead of being logged at import time,
* where no context logger exists yet; the provider logs it once at its first
* `list()` and once per unloadable skill.
*/
/** Registry name this provider registers under. */
const PROVIDER_NAME = "company-skills";
/**
* Discovery source bucket. Company skills are product-shipped content, so they
* report `bundled` and rank with the other packaged roots.
*/
const SKILL_SOURCE = "bundled";
/**
* Precedence of every company skill. `BUNDLED_SKILL_RANK` is the packaged-root
* rank, which is the lowest: a project (`project-dsh`/`project-agents`) or a
* user (`user-dsh`/`user-agents`) skill of the same name keeps winning. That is
* the intended product behaviour — the company catalog is always available but
* never silently overrides a skill the repository or the user deliberately
* wrote down.
*/
const SKILL_RANK = BUNDLED_SKILL_RANK;
/** Both surfaces may invoke a company skill: the model by routing, the user by command. */
const SKILL_INVOCATION = Object.freeze({
	modelInvocable: true,
	userInvocable: true
});
/**
* Relative resources are carried inside the plugin, not on the local disk, so
* the skill loader renders an opaque hint instead of a directory or URL. That
* is the zero-change consumption path: consumers only render the hint
* (`packages/skill/skill/src/index.ts`), and the batch-3 execution tool is what
* resolves `scripts/…` and `assets/…` names.
*/
const RESOURCE_BASE = Object.freeze({
	kind: "opaque",
	description: "These company skills travel inside the dsh-company-skills plugin bundle; their referenced scripts and resources are not files on this machine, so they cannot be read as local paths. Use the company_skill_read tool to load a referenced text resource and company_skill_run to run a declared script."
});
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function buildCatalog(elements, reason) {
	const byName = new Map(elements.map((entry) => [entry.name, entry]));
	return {
		entries: elements.map((entry) => ({
			name: entry.name,
			description: entry.description,
			rank: SKILL_RANK,
			locator: entry.name
		})),
		reason,
		skill(name) {
			const entry = byName.get(name);
			if (entry === void 0) return {
				ok: false,
				reason: `unknown company skill "${name}"`
			};
			try {
				return {
					ok: true,
					bundle: validateSkillBundle(entry.element)
				};
			} catch (error) {
				return {
					ok: false,
					reason: `company skill "${name}" is not loadable: ${errorMessage(error)}`
				};
			}
		}
	};
}
/** The empty catalog a failed or empty load degrades to. */
function emptyCatalog(reason) {
	return buildCatalog([], reason);
}
/**
* Decode one asset's text into a catalog. Never throws.
* @param text - the raw blob or generated-module text.
* @returns the catalog, or an empty one carrying the failure reason.
*/
function loadCatalogFromText(text) {
	try {
		const elements = decodeContainer(text);
		if (elements.length === 0) return emptyCatalog("the company skills container carries no skills");
		return buildCatalog(elements, void 0);
	} catch (error) {
		return emptyCatalog(`the company skills container did not load: ${errorMessage(error)}`);
	}
}
/**
* Read and decode the shipped container asset at module initialization. A
* missing or unreadable file is a degraded catalog, not an exception.
* @param url - the asset URL inside the owning package.
* @returns the catalog, or an empty one carrying the failure reason.
*/
function loadCatalogFromFile(url) {
	let text;
	try {
		text = readFileSync(url, "utf8");
	} catch (error) {
		return emptyCatalog(`the company skills container is unreadable: ${errorMessage(error)}`);
	}
	return loadCatalogFromText(text);
}
//#endregion
//#region src/provider.ts
function candidateOf(entry) {
	return {
		name: entry.name,
		description: entry.description,
		invocation: SKILL_INVOCATION,
		provider: PROVIDER_NAME,
		source: SKILL_SOURCE,
		resourceBase: RESOURCE_BASE,
		rank: entry.rank,
		locator: entry.locator
	};
}
/**
* Build the provider for one loaded catalog.
* @param catalog - the loaded (possibly empty) catalog.
* @param warn - optional sink for load and per-skill degradation messages.
* @returns the provider the plugin registers.
*/
function createProvider(catalog, warn) {
	let reportedCatalog = false;
	const report = (message) => {
		warn?.(`${PROVIDER_NAME}: ${message}`);
	};
	return {
		name: PROVIDER_NAME,
		list(_options) {
			if (!reportedCatalog && catalog.reason !== void 0) {
				reportedCatalog = true;
				report(catalog.reason);
			}
			return Promise.resolve(catalog.entries.map((entry) => candidateOf(entry)));
		},
		get(candidate, _options) {
			const locator = candidate.locator;
			if (typeof locator !== "string") {
				report(`ignored a candidate for "${candidate.name}" whose locator is not a skill name`);
				return Promise.resolve(void 0);
			}
			const loaded = catalog.skill(locator);
			if (!loaded.ok) {
				report(loaded.reason);
				return Promise.resolve(void 0);
			}
			const { bundle } = loaded;
			return Promise.resolve({
				name: bundle.name,
				description: bundle.description,
				invocation: SKILL_INVOCATION,
				provider: PROVIDER_NAME,
				source: SKILL_SOURCE,
				resourceBase: RESOURCE_BASE,
				content: bundle.body
			});
		}
	};
}
/** Environment variable carrying the staged skill root (scripts + assets) to the child. */
const ASSETS_ENV_VAR = "DSH_SKILL_ASSETS";
/** Prefix of the per-run staged-skill directory under the temp root. */
const ASSETS_TMP_PREFIX = "dsh-skill-assets-";
/** Node's largest representable timer delay: a longer bound would overflow its timer. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
/** Extension → interpreter family, resolved to a command by {@link resolveInterpreter}. */
const INTERPRETER_BY_EXTENSION = /* @__PURE__ */ new Map([
	[".mjs", "node"],
	[".js", "node"],
	[".py", "python"]
]);
/** Desktop-published absolute Node command; preferred over the `PATH` lookup. */
const DESKTOP_NODE_EXECUTABLE_ENV = "DSH_DESKTOP_NODE_EXECUTABLE";
/** Desktop-published absolute Python command; preferred over the `PATH` lookup. */
const DESKTOP_PYTHON_EXECUTABLE_ENV = "DSH_DESKTOP_PYTHON_EXECUTABLE";
/** Electron's "run as a plain Node CLI" switch, paired with `process.execPath`. */
const ELECTRON_RUN_AS_NODE_ENV = "ELECTRON_RUN_AS_NODE";
/**
* Every rejection this module raises. The message names the skill and script
* (both catalog metadata) and never carries body, asset, or output bytes.
*/
var SkillRunError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "SkillRunError";
	}
};
/** Map one script path to its interpreter family, or `undefined` when unsupported. */
function interpreterFor(scriptPath) {
	return INTERPRETER_BY_EXTENSION.get(extname(scriptPath).toLowerCase());
}
/** The extensions this executor can launch, in a stable display order. */
function supportedScriptExtensions() {
	return [...INTERPRETER_BY_EXTENSION.keys()];
}
/** Whether one command is executable on the environment's `PATH`.
*
* Windows only accepts a native image (`.exe`/`.com`): a `.cmd` shim on `PATH`
* is not executable by a shell-less spawn, which is exactly the packaged-desktop
* case the injected variable exists to bypass. */
function executableOnPath(command, environment, platform) {
	const rawPath = platform === "win32" ? Object.entries(environment).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "" : environment.PATH ?? "";
	const delimiter = platform === "win32" ? ";" : ":";
	const extensions = platform === "win32" ? [".exe", ".com"] : [""];
	for (const directory of rawPath.split(delimiter)) {
		if (directory.length === 0) continue;
		for (const extension of extensions) try {
			const stat = statSync(join(directory, command + extension));
			if (stat.isFile() && (platform === "win32" || (stat.mode & 73) !== 0)) return true;
		} catch {}
	}
	return false;
}
/**
* Resolve one interpreter family to a concrete command.
*
* Order: the desktop-published absolute command, then the bare family name on
* the child's `PATH`, then — for Node only — the host executable itself with
* `ELECTRON_RUN_AS_NODE=1` (Node in a CLI host, Electron-as-Node in the
* desktop). Python has no host-executable fallback.
* @param family - the extension-selected interpreter family.
* @param inputs - environment, platform, host-executable, and `PATH`-probe seams.
* @returns the command and its required child environment, or `undefined` when
* no Python interpreter is available.
*/
function resolveInterpreter(family, inputs = {}) {
	const environment = inputs.environment ?? process.env;
	const platform = inputs.platform ?? process.platform;
	const injected = environment[family === "node" ? DESKTOP_NODE_EXECUTABLE_ENV : DESKTOP_PYTHON_EXECUTABLE_ENV];
	if (injected !== void 0 && injected.length > 0 && (inputs.exists ?? existsSync)(injected)) return {
		command: injected,
		env: {}
	};
	if ((inputs.commandOnPath ?? ((command) => executableOnPath(command, environment, platform)))(family)) return {
		command: family,
		env: {}
	};
	if (family === "python") return void 0;
	return {
		command: inputs.execPath ?? process.execPath,
		env: { [ELECTRON_RUN_AS_NODE_ENV]: "1" }
	};
}
function assertPositiveInteger(name, value) {
	if (!Number.isInteger(value) || value < 1) throw new Error(`dsh-company-skills: ${name} must be a positive integer`);
}
function resolveLimits(options) {
	const limits = {
		timeoutMs: options.timeoutMs ?? 12e4,
		graceMs: options.graceMs ?? 5e3,
		maxOutputBytes: options.maxOutputBytes ?? 65536,
		maxConcurrentPerSession: options.maxConcurrentPerSession ?? 1,
		maxReadBytes: options.maxReadBytes ?? 262144
	};
	assertPositiveInteger("timeoutMs", limits.timeoutMs);
	assertPositiveInteger("graceMs", limits.graceMs);
	assertPositiveInteger("maxOutputBytes", limits.maxOutputBytes);
	assertPositiveInteger("maxConcurrentPerSession", limits.maxConcurrentPerSession);
	assertPositiveInteger("maxReadBytes", limits.maxReadBytes);
	if (limits.timeoutMs > MAX_TIMER_DELAY_MS || limits.graceMs > MAX_TIMER_DELAY_MS) throw new Error(`dsh-company-skills: timeoutMs and graceMs must be no greater than ${String(MAX_TIMER_DELAY_MS)}`);
	return limits;
}
/** Locate one declared script by exact path equality — never by path arithmetic. */
function findScript(bundle, script) {
	const entry = bundle.scripts.find((candidate) => candidate.path === script);
	return entry === void 0 ? void 0 : {
		path: entry.path,
		content: entry.content
	};
}
/** Locate one carried entry (script or asset) by exact path equality — never by path arithmetic. */
function findEntry(bundle, path) {
	const entry = [...bundle.scripts, ...bundle.assets].find((candidate) => candidate.path === path);
	return entry === void 0 ? void 0 : {
		path: entry.path,
		content: entry.content
	};
}
/** Render the declared script paths for a rejection message (paths are catalog metadata). */
function describeScripts(bundle) {
	return bundle.scripts.length === 0 ? "none" : bundle.scripts.map((entry) => `"${entry.path}"`).join(", ");
}
/** Strict UTF-8 decoder: invalid bytes throw instead of becoming U+FFFD. */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
/**
* Reject an addressed script that is not valid UTF-8 before anything is
* staged or spawned (a binary script can never be decoded losslessly, and the
* error carries no bytes). Entry content in general is written as raw bytes:
* a collected skill legitimately carries binaries under `scripts/` (a WASM
* module), and only the entry actually handed to an interpreter must be text.
*/
function assertScriptText(bundle, script) {
	const bytes = decodeCanonicalBase64(script.content, `${bundle.name} script ${script.path}`);
	try {
		UTF8_DECODER.decode(bytes);
	} catch (cause) {
		throw new SkillRunError(`company skill "${bundle.name}" script "${script.path}" is not valid UTF-8 text`, { cause });
	}
}
/**
* Materialize the whole skill — every `scripts[]` and every `assets[]` entry —
* into one private temp directory that stands in for the skill root, at each
* entry's own bundle-relative path: `scripts/export_pptx.py` lands at
* `<dir>/scripts/export_pptx.py`, `editor/index.html` at
* `<dir>/editor/index.html`, `reference/pptd.md` at `<dir>/reference/pptd.md`.
* The root is created 0700 by `mkdtemp`; entry directories default to 0755
* under the process umask and files are written 0600 (`mode` is a no-op on
* Windows). On any failure the partial directory is removed before the error
* propagates, so a failed run leaves nothing behind.
* @param bundle - the skill whose entries are staged.
* @param tempRoot - the temp root to create the private directory under.
* @returns the directory published as `DSH_SKILL_ASSETS` and used as `cwd`.
*/
async function stageBundle(bundle, tempRoot) {
	const directory = await mkdtemp(join(tempRoot, ASSETS_TMP_PREFIX));
	try {
		for (const entry of [...bundle.scripts, ...bundle.assets]) {
			const target = join(directory, entry.path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, decodeCanonicalBase64(entry.content, `${bundle.name} entry ${entry.path}`), { mode: 384 });
		}
	} catch (error) {
		await rm(directory, {
			recursive: true,
			force: true
		});
		if (error instanceof SkillRunError) throw error;
		throw new SkillRunError(`company skill "${bundle.name}" could not be staged for execution`, { cause: error });
	}
	return directory;
}
/**
* Materialize exactly one entry into its own private per-read directory so it
* can be read back as text; the caller removes the directory in a `finally`
* block. The same `mkdtemp`/`ASSETS_TMP_PREFIX` staging root the run channel
* uses is reused, and the entry lands at its own relative path.
* @param bundle - the skill the entry belongs to.
* @param entry - the addressed entry.
* @param bytes - the entry's decoded bytes.
* @param tempRoot - the temp root to create the private directory under.
* @returns the private directory and the materialized file path.
*/
async function stageEntry(bundle, entry, bytes, tempRoot) {
	const directory = await mkdtemp(join(tempRoot, ASSETS_TMP_PREFIX));
	try {
		const file = join(directory, entry.path);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, bytes, { mode: 384 });
		return {
			directory,
			file
		};
	} catch (error) {
		await rm(directory, {
			recursive: true,
			force: true
		});
		if (error instanceof SkillRunError) throw error;
		throw new SkillRunError(`company skill "${bundle.name}" resource "${entry.path}" could not be staged`, { cause: error });
	}
}
/** Read one collected stream at offset 0; `lossy` is the seam's truncation fact. */
function collectOutput(reader) {
	if (reader === void 0) return {
		text: "",
		truncated: false
	};
	const read = reader.readFrom(0);
	return {
		text: read.text,
		truncated: read.lossy
	};
}
/**
* Build the executor for one catalog.
* @param options - catalog, spawn seam, and the resolved bounds.
* @returns the executor the tool layer registers.
*/
function createScriptExecutor(options) {
	const limits = resolveLimits(options);
	const tempRoot = options.tempRoot ?? tmpdir();
	const logWarning = options.logWarning ?? (() => {});
	const activeBySession = /* @__PURE__ */ new Map();
	const release = (sessionKey) => {
		const remaining = (activeBySession.get(sessionKey) ?? 1) - 1;
		if (remaining <= 0) activeBySession.delete(sessionKey);
		else activeBySession.set(sessionKey, remaining);
	};
	async function run(request) {
		const loaded = options.catalog.skill(request.skill);
		if (!loaded.ok) throw new SkillRunError(`cannot run company skill "${request.skill}": ${loaded.reason}`);
		const bundle = loaded.bundle;
		const script = findScript(bundle, request.script);
		if (script === void 0) throw new SkillRunError(`company skill "${bundle.name}" carries no script "${request.script}"; its scripts are ${describeScripts(bundle)}`);
		const family = interpreterFor(script.path);
		if (family === void 0) throw new SkillRunError(`company skill "${bundle.name}" script "${script.path}" has no supported interpreter (supported extensions: ${supportedScriptExtensions().join(", ")})`);
		assertScriptText(bundle, script);
		const interpreter = resolveInterpreter(family, options.interpreterResolution);
		if (interpreter === void 0) {
			const variable = family === "python" ? DESKTOP_PYTHON_EXECUTABLE_ENV : DESKTOP_NODE_EXECUTABLE_ENV;
			throw new SkillRunError(`company skill "${bundle.name}" script "${script.path}" cannot run: no ${family} interpreter was found (set ${variable} or put ${family} on PATH)`);
		}
		const running = activeBySession.get(request.sessionKey) ?? 0;
		if (running >= limits.maxConcurrentPerSession) throw new SkillRunError(`company skill "${bundle.name}" script "${script.path}" is already running for this session (at most ${String(limits.maxConcurrentPerSession)} concurrent run may be in flight)`);
		activeBySession.set(request.sessionKey, running + 1);
		const failLaunch = (command, error) => {
			if (timedOut) throw new SkillRunError(`company skill "${bundle.name}" script "${script.path}" timed out after ${String(limits.timeoutMs)} ms`);
			if (request.signal.aborted) throw new SkillRunError(`company skill "${bundle.name}" script "${script.path}" was cancelled`);
			throw new SkillRunError(`company skill "${bundle.name}" script "${script.path}" could not start (${command} launch failed)`, { cause: error });
		};
		const deadline = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			deadline.abort();
		}, limits.timeoutMs);
		const signal = AbortSignal.any([request.signal, deadline.signal]);
		let stagedRoot;
		try {
			stagedRoot = await stageBundle(bundle, tempRoot);
			const env = {
				...interpreter.env,
				[ASSETS_ENV_VAR]: stagedRoot
			};
			const spec = {
				argv: [
					interpreter.command,
					join(stagedRoot, script.path),
					...request.args ?? []
				],
				cwd: stagedRoot,
				stdio: {
					stdin: "ignore",
					stdout: { maxBytes: limits.maxOutputBytes },
					stderr: { maxBytes: limits.maxOutputBytes }
				},
				graceMs: limits.graceMs,
				signal,
				env
			};
			let handle;
			try {
				handle = options.spawn(spec);
			} catch (error) {
				failLaunch(interpreter.command, error);
			}
			let outcome;
			try {
				outcome = await handle.done;
			} catch (error) {
				failLaunch(interpreter.command, error);
			}
			if (timedOut) throw new SkillRunError(`company skill "${bundle.name}" script "${script.path}" timed out after ${String(limits.timeoutMs)} ms`);
			if (request.signal.aborted) throw new SkillRunError(`company skill "${bundle.name}" script "${script.path}" was cancelled`);
			if (outcome.exitCode === null) throw new SkillRunError(`company skill "${bundle.name}" script "${script.path}" was terminated by signal ${outcome.signal ?? "unknown"}`);
			return {
				skill: bundle.name,
				script: script.path,
				exitCode: outcome.exitCode,
				stdout: collectOutput(handle.collected.stdout),
				stderr: collectOutput(handle.collected.stderr)
			};
		} finally {
			clearTimeout(timer);
			release(request.sessionKey);
			if (stagedRoot !== void 0) try {
				await (options.removeStagedAssets ?? ((directory) => rm(directory, {
					recursive: true,
					force: true
				})))(stagedRoot);
			} catch (error) {
				try {
					logWarning(`dsh-company-skills: could not remove the staged skill files for company skill "${bundle.name}" script "${script.path}": ${error instanceof Error ? error.message : String(error)}`);
				} catch {}
			}
		}
	}
	async function read(request) {
		const bound = request.maxBytes ?? limits.maxReadBytes;
		if (!Number.isInteger(bound) || bound < 1) throw new SkillRunError(`company skill "${request.skill}" read bound must be a positive integer (got ${JSON.stringify(request.maxBytes)})`);
		const loaded = options.catalog.skill(request.skill);
		if (!loaded.ok) throw new SkillRunError(`cannot read from company skill "${request.skill}": ${loaded.reason}`);
		const bundle = loaded.bundle;
		const entry = findEntry(bundle, request.path);
		if (entry === void 0) throw new SkillRunError(`company skill "${bundle.name}" carries no resource "${request.path}"`);
		const bytes = decodeCanonicalBase64(entry.content, `${bundle.name} resource ${entry.path}`);
		if (bytes.byteLength > bound) throw new SkillRunError(`company skill "${bundle.name}" resource "${entry.path}" is ${String(bytes.byteLength)} bytes, over the ${String(bound)}-byte read bound`);
		let staged;
		try {
			staged = await stageEntry(bundle, entry, bytes, tempRoot);
			const stagedBytes = await readFile(staged.file);
			let text;
			try {
				text = UTF8_DECODER.decode(stagedBytes);
			} catch (cause) {
				throw new SkillRunError(`company skill "${bundle.name}" resource "${entry.path}" is not UTF-8 text; binary resources cannot be read`, { cause });
			}
			return {
				skill: bundle.name,
				path: entry.path,
				text,
				bytes: stagedBytes.byteLength
			};
		} finally {
			if (staged !== void 0) try {
				await (options.removeStagedAssets ?? ((directory) => rm(directory, {
					recursive: true,
					force: true
				})))(staged.directory);
			} catch (error) {
				try {
					logWarning(`dsh-company-skills: could not remove the staged files for company skill "${bundle.name}" resource "${entry.path}": ${error instanceof Error ? error.message : String(error)}`);
				} catch {}
			}
		}
	}
	return {
		limits,
		run,
		read
	};
}
//#endregion
//#region src/tool.ts
/**
* The model-facing company-skill tools (P6 batch 3/4).
*
* `company_skill_run` and `company_skill_read` are deliberately thin: they
* validate the model's addressing arguments, resolve the session identity from
* the execution context, and delegate every bound and every rejection to the
* {@link ScriptExecutor}. The executor — not this layer — owns interpreter
* selection, per-call materialization into the private staged directory,
* output/read caps, and the timeout, so a tool definition cannot accidentally
* bypass one of them.
*
* `company_skill_read` exists because the bundle is opaque: the upstream
* consumer only renders the resourceBase hint, so the prose a skill depends on
* (`reference/pptd.md`, `references/workflows.md`) is unreachable without a
* text channel. The read tool addresses one carried entry by exact path and
* returns its UTF-8 text.
*
* `presentCall` renders a card from the arguments alone (skill + path/script),
* so a replayed call never needs the body.
*
* @module dsh-company-skills/tool
*/
/** Tool name the model sees. */
const COMPANY_SKILL_RUN_TOOL_NAME = "company_skill_run";
/**
* Project one settled run onto the canonical tool value. Truncation is
* surfaced explicitly so the model knows the tail it sees is partial.
* @param result - the executor's settled run.
* @returns the lossless-JSON value declared by the tool's output schema.
*/
function toRunValue(result) {
	return {
		skill: result.skill,
		script: result.script,
		exitCode: result.exitCode,
		stdout: result.stdout.text,
		stderr: result.stderr.text,
		stdoutTruncated: result.stdout.truncated,
		stderrTruncated: result.stderr.truncated
	};
}
/** One labelled output section; an empty stream is rendered explicitly, never omitted ambiguously. */
function section(label, text, truncated) {
	const body = text.length === 0 ? "(empty)" : text.replace(/\n$/u, "");
	return `--- ${label}${truncated ? " (truncated)" : ""} ---\n${body}`;
}
/**
* Render the canonical value for the model. Only the script's own output is
* echoed; the script source is never part of the rendering path.
* @param value - the canonical run value.
* @returns the plain-text tool result.
*/
function renderRunValue(value) {
	return [
		`company skill "${value.skill}" ran ${value.script} (exit code ${String(value.exitCode)})`,
		section("stdout", value.stdout, value.stdoutTruncated),
		section("stderr", value.stderr, value.stderrTruncated)
	].join("\n\n");
}
/** Tool name the model sees for resource reads. */
const COMPANY_SKILL_READ_TOOL_NAME = "company_skill_read";
/**
* Project one decoded resource onto the canonical tool value.
* @param result - the executor's decoded resource.
* @returns the lossless-JSON value declared by the tool's output schema.
*/
function toReadValue(result) {
	return {
		skill: result.skill,
		path: result.path,
		text: result.text,
		bytes: result.bytes
	};
}
/**
* Render the canonical read value for the model: a one-line header naming the
* skill, resource, and byte length, then the text verbatim.
* @param value - the canonical read value.
* @returns the plain-text tool result.
*/
function renderReadValue(value) {
	return `company skill "${value.skill}" resource ${value.path} (${String(value.bytes)} bytes)\n\n${value.text}`;
}
/**
* Build the `company_skill_read` definition for one executor.
* @param executor - the catalog-backed script executor.
* @returns a registry-ready tool definition.
*/
function createCompanySkillReadTool(executor) {
	return defineTool({
		name: COMPANY_SKILL_READ_TOOL_NAME,
		description: `Read one referenced text resource that ships inside a company skill (for example a skill's \`reference/pptd.md\` or \`references/workflows.md\`). Company-skill resources are opaque to the workspace, so a \`read\` or \`bash\` sees nothing: this is the only way to load them. \`skill\` must be a company skill name from the skill catalog and \`path\` must be one of that skill's own carried entry paths, passed exactly as the skill declares it (for example "reference/pptd.md"). The entry is materialized into a private temp directory for the duration of the call and removed the moment it settles, so nothing persists. Only UTF-8 text can be read (a binary resource is refused), and an entry larger than ${String(Math.round(executor.limits.maxReadBytes / 1024))} KiB is refused rather than truncated (maxBytes raises the bound for one call). Returns the text and its byte length.`,
		parameters: {
			skill: {
				type: "string",
				required: true,
				description: "Company skill name exactly as the skill catalog lists it."
			},
			path: {
				type: "string",
				required: true,
				description: "Bundle-relative resource path exactly as the skill carries it, e.g. \"reference/pptd.md\". Must equal one of that skill's own entries."
			},
			maxBytes: {
				type: "integer",
				description: "Per-call read bound in bytes; defaults to the executor bound. An entry over the bound is refused."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					skill: {
						type: "string",
						required: true
					},
					path: {
						type: "string",
						required: true
					},
					text: {
						type: "string",
						required: true
					},
					bytes: {
						type: "integer",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderReadValue(value)
			}]
		},
		async execute(args) {
			return toReadValue(await executor.read({
				skill: args.skill,
				path: args.path,
				...args.maxBytes === void 0 ? {} : { maxBytes: args.maxBytes }
			}));
		},
		presentCall: (args) => ({
			card: "generic",
			kind: "read",
			title: `Read ${args.skill}/${args.path}`,
			rawInput: args.path
		})
	});
}
/**
* Build the `company_skill_run` definition for one executor.
* @param executor - the catalog-backed script executor.
* @returns a registry-ready tool definition.
*/
function createCompanySkillRunTool(executor) {
	return defineTool({
		name: COMPANY_SKILL_RUN_TOOL_NAME,
		description: `Run one script that ships inside a company skill. The skill is materialized at its own relative paths into a private temp directory (0700 root and 0600 files on POSIX; \`mode\` is ignored on Windows) for the duration of the run and removed the moment it settles, so the files never persist and this tool is the only way to run those scripts; a workspace \`bash\` or \`read\` cannot see them. \`skill\` must be a company skill name from the skill catalog and \`script\` must be one of that skill's own declared script paths (for example "scripts/report.mjs"), passed exactly as the skill declares it. The script runs with the staged skill root as its working directory, so bundle-relative reads such as \`reference/pptd.md\` resolve as written and \`__file__\` locates the skill root. \`args\` is appended to the interpreter argv verbatim. Use \`company_skill_read\` to load a referenced prose resource such as \`reference/pptd.md\` that a skill expects the caller to have read first. Returns the exit code plus stdout and stderr, each capped at ${String(Math.round(executor.limits.maxOutputBytes / 1024))} KiB (overflow keeps the tail and is reported as truncated). A run is limited to ${String(executor.limits.maxConcurrentPerSession)} in flight per session and to a ${String(Math.round(executor.limits.timeoutMs / 1e3))} s deadline.`,
		parameters: {
			skill: {
				type: "string",
				required: true,
				description: "Company skill name exactly as the skill catalog lists it."
			},
			script: {
				type: "string",
				required: true,
				description: "Bundle-relative script path exactly as the skill declares it, e.g. \"scripts/report.mjs\". Must be one of that skill's own scripts."
			},
			args: {
				type: "array",
				items: { type: "string" },
				description: "Extra argv appended after the script path; passed to the interpreter verbatim."
			}
		},
		timeoutMs: executor.limits.timeoutMs + executor.limits.graceMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					skill: {
						type: "string",
						required: true
					},
					script: {
						type: "string",
						required: true
					},
					exitCode: {
						type: "integer",
						required: true
					},
					stdout: {
						type: "string",
						required: true
					},
					stderr: {
						type: "string",
						required: true
					},
					stdoutTruncated: {
						type: "boolean",
						required: true
					},
					stderrTruncated: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderRunValue(value)
			}]
		},
		async execute(args, exec) {
			return toRunValue(await executor.run({
				skill: args.skill,
				script: args.script,
				...args.args === void 0 ? {} : { args: args.args },
				sessionKey: exec.agent?.id ?? "unscoped",
				signal: exec.signal
			}));
		},
		presentCall: (args) => ({
			card: "generic",
			kind: "execute",
			title: `Run ${args.skill}/${args.script}`,
			rawInput: args.args === void 0 || args.args.length === 0 ? args.script : args.args.join(" ")
		})
	});
}
//#endregion
//#region src/index.ts
/** Cordis plugin name. */
const name = "company-skills";
/** The skill registry this plugin contributes to. */
const inject = ["skills"];
/** The shipped container asset: one obfuscated block carrying every bundled skill. */
const SKILLS_BUNDLE_URL = new URL("../assets/skills.bundle", import.meta.url);
/** The catalog decoded from the shipped asset at module initialization. */
const catalog = loadCatalogFromFile(SKILLS_BUNDLE_URL);
/** Register the company-skill provider and the script-execution tool on their seams. */
function apply(ctx) {
	const provider = createProvider(catalog, (message) => {
		ctx.logger.warn(message);
	});
	ctx.inject(["skills"], (inner) => {
		inner.effect(() => inner.skills.registerProvider(() => provider));
	});
	ctx.inject(["tools", "subprocess"], (inner) => {
		const executor = createScriptExecutor({
			catalog,
			spawn: (spec) => inner.subprocess.spawn(spec),
			logWarning: (message) => {
				ctx.logger.warn(message);
			}
		});
		inner.effect(() => inner.tools.register(createCompanySkillRunTool(executor)));
		inner.effect(() => inner.tools.register(createCompanySkillReadTool(executor)));
	});
}
//#endregion
export { SKILLS_BUNDLE_URL, apply, catalog, inject, name };

//# sourceMappingURL=index.js.map