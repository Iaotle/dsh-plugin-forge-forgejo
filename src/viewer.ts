/** The signed-in user's open pull requests, found through Forgejo's issue search. */

import type { ChangeRequestRef, ForgeFailure, ForgeRepository, ForgeViewerFilter } from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { ForgejoApi } from './api.ts'
import { userSchema } from './schemas.ts'
import type { UserNode } from './schemas.ts'

/** Search results read for one list; the search pages are 50 items, so this is four of them. */
const SCAN = 200

/** The query parameters of each search whose results make up a list; `involved` is the union of three searches. */
const SEARCHES: Readonly<Record<ForgeViewerFilter, readonly string[]>> = {
  authored: ['created=true'],
  'review-requested': ['review_requested=true'],
  involved: ['mentioned=true', 'assigned=true', 'reviewed=true'],
}

const hitSchema = z.object({
  number: z.number(),
  html_url: z.string(),
  title: z.string(),
  user: userSchema.nullish(),
  updated_at: z.string(),
  pull_request: z.object({ draft: z.boolean().nullish() }).nullish(),
  repository: z.object({ owner: z.string(), name: z.string() }),
})

/** A pull request found by the search, with what the search itself reports of it. */
export interface Hit {
  readonly ref: ChangeRequestRef
  readonly url: string
  readonly title: string
  readonly draft: boolean
  readonly author: UserNode | null
  readonly updatedAt: string
}

/** The lists the search found, most recently updated first. */
export interface FoundLists {
  /** Login of the signed-in user. */
  readonly viewer: string
  /** Each asked list; its length is the number of pull requests found, at least the scan limit when the search held more. */
  readonly lists: ReadonlyMap<ForgeViewerFilter, readonly Hit[]>
}

const keyOf = (ref: ChangeRequestRef): string => `${ref.repository.owner}/${ref.repository.name}#${ref.number}`

async function search(api: ForgejoApi, host: string, params: string, signal: AbortSignal): Promise<Hit[] | ForgeFailure> {
  const read = await api.list(host, `repos/issues/search?state=open&type=pulls&${params}`, SCAN, signal)
  if ('ok' in read) return read.failure
  const parsed = z.array(hitSchema).safeParse(read.items)
  if (!parsed.success) return { code: 'unavailable', message: 'unexpected Forgejo answer to the pull request search' }
  return parsed.data.map(hit => ({
    ref: { repository: { forge: 'forgejo', host, owner: hit.repository.owner, name: hit.repository.name }, number: hit.number },
    url: hit.html_url,
    title: hit.title,
    draft: hit.pull_request?.draft === true,
    author: hit.user ?? null,
    updatedAt: hit.updated_at,
  }))
}

/**
 * Find lists of the signed-in user's open pull requests. `involved` holds the pull requests that mention, are
 * assigned to, or were reviewed by the user, without those in the `authored` and `review-requested` lists. The user
 * is read once and every search runs once, however many lists are asked.
 * @param api - Forgejo REST client.
 * @param host - Forgejo host.
 * @param filters - the lists.
 * @param repository - the one repository to list, or null for all.
 * @param signal - cancels the reads.
 * @returns the lists, or why a read failed.
 */
export async function findViewerLists(
  api: ForgejoApi, host: string, filters: readonly ForgeViewerFilter[], repository: Pick<ForgeRepository, 'owner' | 'name'> | null,
  signal: AbortSignal,
): Promise<FoundLists | ForgeFailure> {
  const user = await api.get(host, 'user', signal)
  if (!user.ok) return user.failure
  const login = userSchema.safeParse(user.body)
  if (!login.success) return { code: 'unavailable', message: 'unexpected Forgejo answer to the user read' }
  const needed = [...new Set(filters.flatMap(filter => filter === 'involved' ? [...SEARCHES.involved, ...SEARCHES.authored, ...SEARCHES['review-requested']] : SEARCHES[filter]))]
  const results = new Map<string, Hit[]>()
  const reads = await Promise.all(needed.map(async params => ({ params, hits: await search(api, host, params, signal) })))
  for (const { params, hits } of reads) {
    if ('code' in hits) return hits
    results.set(params, hits)
  }
  const hitsOf = (params: readonly string[]): Hit[] => params.flatMap(param => results.get(param) ?? [])
  const lists = new Map<ForgeViewerFilter, readonly Hit[]>()
  for (const filter of filters) {
    const others = filter === 'involved' ? hitsOf([...SEARCHES.authored, ...SEARCHES['review-requested']]) : []
    const skipped = new Set(others.map(hit => keyOf(hit.ref)))
    const found = new Map<string, Hit>()
    for (const hit of hitsOf(SEARCHES[filter])) {
      const { owner, name } = hit.ref.repository
      const here = repository === null
        || (owner.toLowerCase() === repository.owner.toLowerCase() && name.toLowerCase() === repository.name.toLowerCase())
      if (here && !skipped.has(keyOf(hit.ref))) found.set(keyOf(hit.ref), hit)
    }
    lists.set(filter, [...found.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
  }
  return { viewer: login.data.login, lists }
}

/** The filters this provider lists. */
export const VIEWER_FILTERS: ReadonlySet<ForgeViewerFilter> = new Set(['review-requested', 'authored', 'involved'])
