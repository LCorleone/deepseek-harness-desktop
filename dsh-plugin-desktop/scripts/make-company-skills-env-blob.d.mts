/** Type surface of `scripts/make-company-skills-env-blob.mjs` for test imports. */

/** The payload the blob carries. */
export interface CompanySkillsEnvPayload {
  routerUrl: string
  routerApiKey: string
}

/** Obfuscation codec shared with `src/company-skills-env.ts` (XOR + base64). */
export function encodeCompanySkillsEnvBlob(payload: CompanySkillsEnvPayload): string

/** Render the generated TypeScript module text for one blob. */
export function renderCompanySkillsEnvBlobModule(blob: string): string

/** The committed-empty payload: decodes to "inject nothing". */
export function emptyCompanySkillsEnvPayload(): CompanySkillsEnvPayload

/** Whether a decoded payload carries nothing to inject. */
export function isEmptyCompanySkillsEnvPayload(payload: CompanySkillsEnvPayload): boolean

/** Read and validate the plaintext input from one environment. */
export function companySkillsEnvFromEnvironment(environment: NodeJS.ProcessEnv): CompanySkillsEnvPayload

/** Programmatic entry point; writes the blob module. */
export function makeCompanySkillsEnvBlob(argv?: string[]): Promise<{ outputPath: string, payload: CompanySkillsEnvPayload }>
