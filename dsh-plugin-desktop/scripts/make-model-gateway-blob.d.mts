/** Type surface of `scripts/make-model-gateway-blob.mjs` for test imports. */

/** Validated generator payload. */
export interface ModelGatewayBlobPayload {
  baseUrl: string
  apiKey: string
  models: string[]
}

/** Obfuscation codec shared with `src/model-gateway.ts` (XOR + base64). */
export function encodeModelGatewayBlob(payload: ModelGatewayBlobPayload): string

/** Render the generated TypeScript module text for one blob. */
export function renderModelGatewayBlobModule(blob: string): string

/** Read and validate the plaintext inputs from one environment. */
export function modelGatewayPayloadFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ModelGatewayBlobPayload

/** Programmatic entry point; writes the blob module and returns its path. */
export function makeModelGatewayBlob(argv?: string[]): Promise<string>
