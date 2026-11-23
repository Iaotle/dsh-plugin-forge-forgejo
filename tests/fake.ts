import { ForgejoApi } from '../src/api.ts'
import { ForgejoProvider } from '../src/provider.ts'

export const HOST = 'git.example.test'
export const repository = { forge: 'forgejo', host: HOST, owner: 'owner', name: 'app' }
export const ref = { repository, number: 7 }
export const HEAD = 'a'.repeat(40)
export const BASE = 'b'.repeat(40)
export const OLD = 'c'.repeat(40)

/** One request the fake host received. */
export interface Call { readonly method: string; readonly path: string; readonly body: unknown }

type Answer = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }

/** A fake Forgejo: `routes` maps `METHOD /path` (without `/api/v1/` and the query) to an answer or a function of the request. */
export function fakeHost(
  routes: Record<string, Answer | ((call: Call) => Answer)>, token: string | null = 'secret', serverPageSize = 50, sendTotal = true,
) {
  const calls: Call[] = []
  const transport = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/api/v1/', '')
    const method = init?.method ?? 'GET'
    expectAuthorized(init, token)
    const call = { method, path: path + url.search, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined }
    calls.push(call)
    const route = routes[`${method} ${path}`]
    const answer = typeof route === 'function' ? route(call) : route ?? { status: 404, body: { message: `no route ${method} ${path}` } }
    const page = pageOf(answer.body, url, serverPageSize)
    const body = answer.text ?? (page === undefined ? answer.body === undefined ? '' : JSON.stringify(answer.body) : JSON.stringify(page.items))
    const headers = { ...page === undefined || !sendTotal ? {} : { 'x-total-count': String(page.total) }, ...answer.headers }
    const responseInit = { status: answer.status ?? 200, headers }
    return new Response(answer.status === 204 ? null : body, responseInit)
  }) as typeof fetch
  const api = new ForgejoApi(async () => token ?? undefined, { timeoutMs: 5_000, maxResponseBytes: 1_000_000 }, transport)
  const limits = { maxReviewThreads: 100, maxCommits: 100, maxConcurrentRequests: 2, maxViewerItems: 50 }
  const provider = new ForgejoProvider(api, [HOST], limits)
  return { calls, api, provider }
}

/** The requested page of a list answer, as a host that serves at most `size` items per page. */
function pageOf(body: unknown, url: URL, size: number): { items: unknown[]; total: number } | undefined {
  if (!Array.isArray(body) || !url.searchParams.has('page')) return undefined
  const limit = Math.min(Number(url.searchParams.get('limit') ?? size), size)
  const start = (Number(url.searchParams.get('page')) - 1) * limit
  return { items: body.slice(start, start + limit), total: body.length }
}

function expectAuthorized(init: RequestInit | undefined, token: string | null): void {
  const header = (init?.headers as Record<string, string> | undefined)?.authorization
  if (token !== null && header !== `token ${token}`) throw new Error(`unexpected authorization ${String(header)}`)
}

export const user = (login: string) => ({ login, avatar_url: `/avatars/${login}` })

export function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 7, html_url: `https://${HOST}/owner/app/pulls/7`, title: 'Change app', body: 'Fixes #3, closes #7 and fixes #99', state: 'open',
    draft: false, merged: false, mergeable: true, user: user('alice'), additions: 2, deletions: 1,
    head: { ref: 'feature', sha: HEAD, repo: { full_name: 'owner/app' } }, base: { ref: 'main', sha: BASE, repo: { full_name: 'owner/app' } },
    merge_base: BASE, requested_reviewers: [user('bob')], requested_reviewers_teams: [], labels: [{ name: 'bug', color: 'ff0000' }],
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', closed_at: null, merged_at: null, ...overrides,
  }
}

export const repo = {
  default_branch: 'main', permissions: { admin: false, push: true, pull: true }, allow_merge_commits: true, allow_rebase: true,
  allow_squash_merge: true, default_merge_style: 'squash',
}
