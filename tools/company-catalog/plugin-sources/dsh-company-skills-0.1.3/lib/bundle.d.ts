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
export declare const SKILL_NAME_PATTERN: RegExp;
/** Description bound: the catalog's `catalogDescriptionMaxLength` default. */
export declare const DESCRIPTION_MAX_LENGTH = 500;
/**
 * Largest single carried file (body, one script, or one asset). Sized for
 * the first real collected skill set: ppt-designer ships a 4.7 MiB font
 * table and a 2.4 MiB WASM binary inside its editor mirror.
 */
export declare const FILE_MAX_BYTES: number;
/**
 * Largest canonical bundle JSON document — the unit a container element
 * carries. ppt-designer's canonical document measures ≈ 43 MiB (33 MiB of
 * sources base64-encoded), so the bound is set above it with headroom.
 */
export declare const BUNDLE_MAX_BYTES: number;
/** Longest accepted relative entry path. */
export declare const PATH_MAX_LENGTH = 200;
/** Directory prefix every `scripts[]` entry must carry — the executable index. */
export declare const SCRIPTS_DIR = "scripts";
/**
 * The directory name the first collected skill set happens to use for
 * resources. It is no longer a required prefix: every entry outside
 * `scripts/` is an `assets[]` entry at its own source-relative path.
 */
/** Canonical fields of one bundle element, in document order. */
export declare const BUNDLE_FIELDS: readonly string[];
/** Canonical fields of one `scripts[]`/`assets[]` entry, in document order. */
export declare const ENTRY_FIELDS: readonly string[];
/** One carried script or asset, base64-encoded. */
export interface SkillBundleEntry {
    /** Bundle-root-relative POSIX path, e.g. `scripts/run.mjs`. */
    readonly path: string;
    /** Canonical standard base64 of the file bytes. */
    readonly content: string;
}
/** One complete skill carried by the container. */
export interface SkillBundle {
    readonly name: string;
    readonly description: string;
    /** Markdown body, exactly the bytes after the `SKILL.md` frontmatter. */
    readonly body: string;
    readonly scripts: readonly SkillBundleEntry[];
    readonly assets: readonly SkillBundleEntry[];
}
/** Code-point ordering — the comparator the skill registry sorts with. */
export declare function compareCodePoints(left: string, right: string): number;
/** Sort entries by path so a decoded document never depends on element order. */
export declare function sortEntries(entries: readonly SkillBundleEntry[]): SkillBundleEntry[];
/**
 * Validate one container element and return it in canonical field and entry
 * order. This is the only path that reads a body, so `list()` stays
 * index-only; it throws on the first violation and names the offending field.
 * @param document - the candidate element.
 * @returns the canonical bundle.
 */
export declare function validateSkillBundle(document: unknown): SkillBundle;
