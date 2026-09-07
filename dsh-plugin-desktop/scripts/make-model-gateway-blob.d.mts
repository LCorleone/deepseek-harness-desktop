/** Type surface of `scripts/make-model-gateway-blob.mjs` for test imports. */

/** One model entry: the wire id plus optional overrides. */
export interface ModelGatewayBlobModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

/** One validated provider entry of the generator payload. */
export interface ModelGatewayBlobProvider {
  route: string
  displayName: string
  apiKeyEnv: string
  baseUrl: string
  apiKey: string
  models: ModelGatewayBlobModel[]
}

/** Validated generator payload. */
export interface ModelGatewayBlobPayload {
  providers: ModelGatewayBlobProvider[]
}

/** Result of {@link makeModelGatewayBlob}. */
export interface MakeModelGatewayBlobResult {
  outputPath: string
  payload: ModelGatewayBlobPayload
}

/** Validate one parsed providers document (the payload the blob carries). */
export function validateProvidersDocument(document: unknown): ModelGatewayBlobPayload

/** Obfuscation codec shared with `src/model-gateway.ts` (XOR + base64). */
export function encodeModelGatewayBlob(payload: ModelGatewayBlobPayload): string

/** Render the generated TypeScript module text for one blob. */
export function renderModelGatewayBlobModule(blob: string): string

/** Read and validate the plaintext input from one environment. */
export function modelGatewayPayloadFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ModelGatewayBlobPayload

/** Programmatic entry point; writes the blob module and returns its path. */
export function makeModelGatewayBlob(argv?: string[]): Promise<MakeModelGatewayBlobResult>
