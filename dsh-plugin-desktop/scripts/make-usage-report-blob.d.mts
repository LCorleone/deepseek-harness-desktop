/** Type surface of `scripts/make-usage-report-blob.mjs` for test imports. */

/** Validated generator payload. */
export interface UsageReportDbBlobPayload {
  host: string
  port: number
  user: string
  password: string
  database: string
}

/** Obfuscation codec shared with `src/model-usage-reporter.ts` (XOR + base64). */
export function encodeUsageReportDbBlob(payload: UsageReportDbBlobPayload): string

/** Render the generated TypeScript module text for one blob. */
export function renderUsageReportDbBlobModule(blob: string): string

/** Read and validate the plaintext inputs from one environment. */
export function usageReportDbPayloadFromEnvironment(
  environment: NodeJS.ProcessEnv,
): UsageReportDbBlobPayload

/** Programmatic entry point; writes the blob module and returns its path. */
export function makeUsageReportDbBlob(argv?: string[]): Promise<string>
