/**
 * Shared domain types for the DAI notebook.
 *
 * These are host-side durable records persisted to
 * `<workspace>/<stateDir>/notebook.json`. The notebook is a pure-note app
 * (no tasks): notes live inside folders, and each note is also rendered as a
 * real Markdown file on disk at `<stateDir>/<folder>/<note>.md`, so the on-disk
 * layout mirrors the folder → note structure the user sees.
 */
export {};
