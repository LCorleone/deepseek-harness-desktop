/**
 * The container document (P6 batch 2): one plugin ships many skills.
 *
 * Wire format, confirmed by the product owner on 2026-09-10 and written by the
 * batch-1.5 packer (`tools/company-skills/pack.mjs --skills <root>`), carried
 * as a single XOR+base64 block in `assets/skills.bundle`:
 *
 *   {"version":1,"skills":[{"name":…,"description":…,"body":…,
 *                            "scripts":[…],"assets":[…]}, …]}
 *
 * Every element is exactly one `tools/company-skills` bundle (see
 * `bundle.ts`), so authoring stays per-skill and this file only adds the outer
 * frame. The frame rules mirror the writer's `validateContainer` exactly:
 * version 1, exactly `version` and `skills`, at least one skill, names unique
 * across the container, and a 128 MiB (2 × the per-skill 64 MiB) document
 * bound — the first real container (ppt-designer + skill-creator) measures
 * ≈ 43 MiB.
 *
 * The split with the writer is deliberate: the tool validates every element
 * eagerly because it is checking an artifact before it ships, while this
 * runtime validates an element's *index* fields at load and leaves the body,
 * scripts, and assets to `validateSkillBundle` on `get()`. That is what
 * `list()` needs and nothing more. The bytes are already in memory once the
 * one XOR block is decoded (a single block is indivisible), so "on demand"
 * here means *materialized on demand*: no body, script, or asset is parsed,
 * validated, or handed to the registry until a caller asks for that exact
 * skill, and a broken payload in one skill cannot empty the whole catalog.
 *
 * Version 1 is the only accepted version: a future frame bumps this number,
 * and an older plugin then degrades to an empty catalog instead of misreading
 * it.
 */
/** The only accepted container version. */
export declare const CONTAINER_VERSION = 1;
/** Canonical fields of the container document, in order. */
export declare const CONTAINER_FIELDS: readonly string[];
/** Largest accepted container document, bytes of canonical JSON; 2 × the per-skill bound. */
export declare const CONTAINER_MAX_BYTES: number;
/**
 * One container element whose name and description are already validated and
 * whose payload fields are deliberately still `unknown`: only `get()` decodes
 * them.
 */
export interface SkillElementIndex {
    readonly name: string;
    readonly description: string;
    /** Untouched element, validated by `validateSkillBundle` on demand. */
    readonly element: Record<string, unknown>;
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
export declare function parseContainer(document: unknown): SkillElementIndex[];
/**
 * Decode one shipped asset — raw base64 blob or a generated module — into
 * per-skill index entries.
 * @param text - the asset file contents.
 * @returns the validated index entries.
 */
export declare function decodeContainer(text: string): SkillElementIndex[];
