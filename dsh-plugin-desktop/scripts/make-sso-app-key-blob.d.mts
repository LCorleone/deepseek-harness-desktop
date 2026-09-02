/** Type surface of `scripts/make-sso-app-key-blob.mjs` for test imports. */

/** Obfuscation codec shared with `src/company-sso.ts` (XOR + base64). */
export function encodeSsoAppKeyBlob(appKey: string): string

/** Render the generated TypeScript module text for one blob. */
export function renderSsoAppKeyBlobModule(blob: string): string

/** Read and validate the plaintext input from one environment. */
export function ssoAppKeyFromEnvironment(environment: NodeJS.ProcessEnv): string

/** Programmatic entry point; writes the blob module and returns its path. */
export function makeSsoAppKeyBlob(argv?: string[]): Promise<string>
