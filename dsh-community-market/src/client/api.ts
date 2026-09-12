import type {
  MarketCatalogResponse,
  MarketDesktopActionResponse,
  MarketInstallableResponse,
  MarketInstallationsResponse,
  MarketOperationExecuteResponse,
  MarketOperationPreviewRequest,
  MarketOperationPreviewResponse,
  MarketSourceMutation,
  MarketStateResponse,
} from '../api-types.js'

const CATALOG_PAGE_LIMIT = 50

async function readJson<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: unknown; code?: unknown }
  if (!response.ok) {
    throw new MarketApiError(
      typeof value.error === 'string' ? value.error : `request failed: ${response.status}`,
      response.status,
      typeof value.code === 'string' ? value.code : undefined,
    )
  }
  return value
}

/** HTTP facts used to localize safe Client-facing Market failures. */
export class MarketApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'MarketApiError'
  }
}

/**
 * Upper bound for one long Market request the Host must answer (an
 * operation preview, a source change, or a desktop action).
 *
 * These legs only touch Host-side state and answer as soon as that work
 * finishes; this only bounds the case where the answer never arrives. A Market
 * generation disposed mid-operation used to leave the Client's `fetch` pending
 * forever (b91): the spinner never cleared. 120s guarantees the wait ends and
 * the Client maps the resulting error to a localized message. The confirmed
 * execute leg alone gets the longer {@link MARKET_EXECUTE_TIMEOUT_MS}.
 */
export const MARKET_OPERATION_TIMEOUT_MS = 120_000

/**
 * Upper bound for the execute leg alone ({@link executeMarketOperation}).
 *
 * Unlike every other bounded Market request, a confirmed install is pnpm-backed
 * on the user's machine: a cold install downloads, extracts, links, and wires
 * the profile, and on a loaded corporate laptop with real-time AV scanning that
 * legitimately runs past the 120s preview bound — reporting it as a timeout was
 * a false negative (the Host keeps going and commits). 300s (5 minutes) covers
 * that cold-install tail while staying the ceiling beyond which we would rather
 * surface the "refresh Installed" recovery hint than keep the spinner turning.
 */
export const MARKET_EXECUTE_TIMEOUT_MS = 300_000

/** The Client-side deadline elapsed before the Host answered a long operation. */
export class MarketOperationTimeoutError extends MarketApiError {
  constructor() {
    super('The market operation timed out before the Host answered.', 408, 'operation-timeout')
    this.name = 'MarketOperationTimeoutError'
  }
}

/**
 * Run one Market request under the given deadline bound (either
 * {@link MARKET_OPERATION_TIMEOUT_MS} or {@link MARKET_EXECUTE_TIMEOUT_MS}).
 *
 * The caller's own cancellation (the surface closed) is forwarded unchanged
 * and stays distinct from the deadline, so closing the view never surfaces as
 * a timeout.
 */
async function withMarketOperationDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    deadline.abort()
  }, timeoutMs)
  const forwardCallerAbort = () => { deadline.abort() }
  if (signal?.aborted === true) deadline.abort()
  else signal?.addEventListener('abort', forwardCallerAbort, { once: true })
  try {
    return await request(deadline.signal)
  } catch (cause) {
    if (timedOut) throw new MarketOperationTimeoutError()
    throw cause
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardCallerAbort)
  }
}

export async function readMarketState(signal?: AbortSignal): Promise<MarketStateResponse> {
  return await readJson(await fetch('/api/community-market/state', {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

function marketCatalogUrl(sourceRecordId: string, q: string, locale: string, categories: readonly string[]): URL {
  const url = new URL('/api/community-market/catalog', window.location.origin)
  url.searchParams.set('sourceRecordId', sourceRecordId)
  if (q.trim()) url.searchParams.set('q', q.trim())
  for (const category of categories) url.searchParams.append('category', category)
  url.searchParams.set('limit', String(CATALOG_PAGE_LIMIT))
  url.searchParams.set('locale', locale)
  return url
}

export async function readMarketCatalog(
  sourceRecordId: string,
  q: string,
  locale: string,
  categories: readonly string[],
  signal?: AbortSignal,
  refresh = false,
): Promise<MarketCatalogResponse> {
  const url = marketCatalogUrl(sourceRecordId, q, locale, categories)
  if (refresh) url.searchParams.set('refresh', '1')
  return await readJson(await fetch(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

export async function readMoreMarketCatalog(
  sourceRecordId: string,
  cursor: string,
  q: string,
  locale: string,
  categories: readonly string[],
  signal?: AbortSignal,
): Promise<MarketCatalogResponse> {
  const url = marketCatalogUrl(sourceRecordId, q, locale, categories)
  url.searchParams.set('cursor', cursor)
  return await readJson(await fetch(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

export async function mutateMarketSource(mutation: MarketSourceMutation, signal?: AbortSignal): Promise<MarketStateResponse['sources']> {
  const response = await withMarketOperationDeadline(signal, MARKET_OPERATION_TIMEOUT_MS, async deadline => readJson<{ sources: MarketStateResponse['sources'] }>(await fetch('/api/community-market/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mutation),
    signal: deadline,
  })))
  return response.sources
}

export async function readMarketInstallations(signal?: AbortSignal): Promise<MarketInstallationsResponse> {
  return await readJson(await fetch('/api/community-market/installations', {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

export async function readMarketInstallable(
  locale: string,
  refresh = false,
  signal?: AbortSignal,
): Promise<MarketInstallableResponse> {
  const url = new URL('/api/community-market/installable', window.location.origin)
  url.searchParams.set('locale', locale)
  if (refresh) url.searchParams.set('refresh', '1')
  return await readJson(await fetch(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

export async function previewMarketOperation(
  request: MarketOperationPreviewRequest,
  signal?: AbortSignal,
): Promise<MarketOperationPreviewResponse> {
  return await withMarketOperationDeadline(signal, MARKET_OPERATION_TIMEOUT_MS, async deadline => readJson(await fetch('/api/community-market/operations/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: deadline,
  })))
}

export async function executeMarketOperation(
  previewId: string,
  signal?: AbortSignal,
): Promise<MarketOperationExecuteResponse> {
  return await withMarketOperationDeadline(signal, MARKET_EXECUTE_TIMEOUT_MS, async deadline => readJson(await fetch('/api/community-market/operations/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId }),
    signal: deadline,
  })))
}

export async function openMarketTerminal(signal?: AbortSignal): Promise<MarketDesktopActionResponse> {
  return await withMarketOperationDeadline(signal, MARKET_OPERATION_TIMEOUT_MS, async deadline => readJson(await fetch('/api/community-market/desktop/open-terminal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    signal: deadline,
  })))
}

export async function requestMarketRestart(
  restartToken: string,
  signal?: AbortSignal,
): Promise<MarketDesktopActionResponse> {
  return await withMarketOperationDeadline(signal, MARKET_OPERATION_TIMEOUT_MS, async deadline => readJson(await fetch('/api/community-market/desktop/request-restart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ restartToken }),
    signal: deadline,
  })))
}
