/** Authenticated HTTPS reads and writes against the REST API of a Forgejo host. */

import type { ForgeActionFailure, ForgeFailure } from '@deepseek-ai/dsh-experimental-forge'

/** Reads the access token, or undefined when none is stored; called for every request, so a rotated token applies at once. */
export type TokenSource = () => Promise<string | undefined>

/** Bounds of one request. */
export interface ApiLimits {
  /** Deadline in milliseconds for one request. */
  readonly timeoutMs: number
  /** Largest response body in bytes. */
  readonly maxResponseBytes: number
}

/** A request a host answered with success. */
export interface ApiSuccess {
  readonly ok: true
  readonly status: number
  /** Parsed JSON, or the text for `text` reads, or null for an empty body. */
  readonly body: unknown
  /** Value of the `X-Total-Count` header on list answers, or null. */
  readonly total: number | null
}

/** A request that failed, as a read failure and its HTTP status (0 when the host was not reached or did not answer in time). */
export interface ApiFailure {
  readonly ok: false
  readonly status: number
  readonly failure: ForgeFailure
  /** Whether the request may have reached the host before it failed, so a write's outcome is unknown. */
  readonly reached: boolean
}

/** The outcome of a request. */
export type ApiResult = ApiSuccess | ApiFailure

/** Options of one request. */
export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** JSON body of a write. */
  readonly json?: unknown
  /** Read the answer as text instead of JSON. */
  readonly text?: boolean
}

/** Pages of `limit` items: Forgejo caps one page at 50 items by default. */
export const PAGE_SIZE = 50

/** Reads and writes the Forgejo REST API of any host with one access token. */
export class ForgejoApi {
  /**
   * @param token - supplies the access token for each request.
   * @param limits - request bounds.
   * @param transport - `fetch` implementation; tests replace it.
   */
  constructor(
    private readonly token: TokenSource,
    private readonly limits: ApiLimits,
    private readonly transport: typeof fetch = fetch,
  ) {}

  /**
   * Send one request to `https://<host>/api/v1/<path>`.
   * @param host - Forgejo host, with its HTTP port when it has one.
   * @param path - API path below `/api/v1/`, with its query string.
   * @param signal - cancels the request.
   * @param options - method, JSON body, and answer form.
   * @returns the answer, or how the request failed; never throws for a failed request.
   */
  async request(host: string, path: string, signal: AbortSignal, options: RequestOptions = {}): Promise<ApiResult> {
    const token = await this.token()
    if (token === undefined) {
      return fail(0, 'unauthenticated', 'no Forgejo access token is stored; store it under the credential named by the tokenEnv setting', false)
    }
    const headers: Record<string, string> = { authorization: `token ${token}`, accept: options.text === true ? 'text/plain, */*' : 'application/json' }
    if (options.json !== undefined) headers['content-type'] = 'application/json'
    let response: Response
    try {
      response = await this.transport(`https://${host}/api/v1/${path}`, {
        method: options.method ?? 'GET',
        headers,
        ...options.json === undefined ? {} : { body: JSON.stringify(options.json) },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.limits.timeoutMs)]),
      })
    } catch (error) {
      const write = options.method !== undefined && options.method !== 'GET'
      if (signal.aborted && !write) throw error
      return redacted(fail(0, 'unavailable', `${host} did not answer: ${error instanceof Error ? error.message : String(error)}`, write), token)
    }
    return redacted(await this.answer(response, host, options.text === true), token)
  }

  /**
   * Read a JSON answer; shorthand for a `GET` request.
   * @param host - Forgejo host.
   * @param path - API path below `/api/v1/`.
   * @param signal - cancels the request.
   * @returns the answer, or how the request failed.
   */
  async get(host: string, path: string, signal: AbortSignal): Promise<ApiResult> {
    return await this.request(host, path, signal)
  }

  /**
   * Read every item of a paginated list, at most `max`.
   * @param host - Forgejo host.
   * @param path - list path, with a query string or without.
   * @param max - most items to read.
   * @param signal - cancels the reads.
   * @returns the items and whether the host holds more, or the failure of a page. Pages continue until the host's
   *   `X-Total-Count` is reached, or until an empty page when it reports none.
   */
  async list(host: string, path: string, max: number, signal: AbortSignal): Promise<{ items: unknown[]; truncated: boolean } | ApiFailure> {
    const items: unknown[] = []
    const joiner = path.includes('?') ? '&' : '?'
    for (let page = 1; items.length < max; page += 1) {
      const read = await this.get(host, `${path}${joiner}limit=${PAGE_SIZE}&page=${page}`, signal)
      if (!read.ok) return read
      if (!Array.isArray(read.body)) return fail(read.status, 'unavailable', 'unexpected Forgejo answer to a list read', true)
      items.push(...read.body)
      // A host may serve fewer items per page than asked (its MAX_RESPONSE_ITEMS setting), so a short page does not end the
      // list: the host's total does when it reports one, else an empty page.
      const done = read.body.length === 0 || (read.total !== null && items.length >= read.total)
      if (done) return { items: items.slice(0, max), truncated: false }
    }
    return { items: items.slice(0, max), truncated: true }
  }

  private async answer(response: Response, host: string, text: boolean): Promise<ApiResult> {
    if (Number(response.headers.get('content-length')) > this.limits.maxResponseBytes) {
      void response.body?.cancel()
      return fail(response.status, 'too-large', `the answer of ${host} exceeds maxResponseBytes`, true)
    }
    let raw: string
    try {
      raw = await response.text()
    } catch (error) {
      return fail(response.status, 'unavailable', `reading the answer of ${host} failed: ${error instanceof Error ? error.message : String(error)}`, true)
    }
    if (Buffer.byteLength(raw) > this.limits.maxResponseBytes) {
      return fail(response.status, 'too-large', `the answer of ${host} exceeds maxResponseBytes`, true)
    }
    if (response.ok) {
      const total = Number(response.headers.get('x-total-count'))
      const totalCount = response.headers.has('x-total-count') && Number.isSafeInteger(total) ? total : null
      if (text || raw === '') return { ok: true, status: response.status, body: raw === '' ? null : raw, total: totalCount }
      try {
        return { ok: true, status: response.status, body: JSON.parse(raw) as unknown, total: totalCount }
      } catch (error) {
        void error // The answer is not JSON; the failure names the host.
        return fail(response.status, 'unavailable', `${host} answered with something other than JSON`, true)
      }
    }
    return fail(response.status, failureCode(response.status), messageOf(raw, response), true)
  }
}

/** A failure whose message holds no occurrence of the token: Forgejo repeats a rejected token in its 401 answers. */
function redacted(result: ApiResult, token: string): ApiResult {
  if (result.ok) return result
  const secrets = [...new Set([token, token.trim()])].filter(secret => secret !== '').sort((a, b) => b.length - a.length)
  let message = result.failure.message
  for (const secret of secrets) message = message.split(secret).join('[token]')
  return message === result.failure.message ? result : { ...result, failure: { ...result.failure, message } }
}

function failureCode(status: number): ForgeFailure['code'] {
  if (status === 401) return 'unauthenticated'
  if (status === 404) return 'not-found'
  if (status === 429) return 'rate-limited'
  return 'unavailable'
}

function messageOf(raw: string, response: Response): string {
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; errors?: unknown }
    const detail = Array.isArray(parsed.errors) && parsed.errors.length > 0 ? `: ${parsed.errors.join('; ')}` : ''
    if (typeof parsed.message === 'string') return `${parsed.message}${detail}`
  } catch (error) {
    void error // Not JSON: the status line names the failure.
  }
  return `Forgejo answered ${response.status} ${response.statusText}`.trim()
}

function fail(status: number, code: ForgeFailure['code'], message: string, reached: boolean): ApiFailure {
  return { ok: false, status, failure: { code, message }, reached }
}

/**
 * The write failure of a failed request: `unauthenticated` for a rejected token, `unknown` when the request may have
 * been applied, else `failed`.
 * @param result - the failed request.
 * @returns the failure a write method reports.
 */
export function actionFailure(result: ApiFailure): ForgeActionFailure {
  if (result.status === 401 || result.failure.code === 'unauthenticated') return { code: 'unauthenticated', message: result.failure.message }
  if (result.reached && result.status < 400) return { code: 'unknown', message: result.failure.message }
  if (result.status === 0 && result.reached) return { code: 'unknown', message: result.failure.message }
  if (result.status >= 500) return { code: 'unknown', message: result.failure.message }
  return { code: 'failed', message: result.failure.message }
}
