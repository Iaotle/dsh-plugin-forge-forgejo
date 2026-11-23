/**
 * Review threads of a Forgejo pull request. Forgejo keeps no thread object: review comments are listed per review, a
 * comment on the new side numbers its line in `position`, one on the old side in `original_position`, and a thread is
 * the comments that share a path, side, and line.
 */

import type {
  ChangeRequestRef, ForgeAnchor, ForgeCommentId, ForgeFailure, ForgePendingReview, ForgeReviewComment, ForgeReviewData, ForgeReviewEvent,
  ForgeReviewThread, ForgeThreadId,
} from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import { ForgejoApi } from './api.ts'
import { pool } from './pool.ts'
import { pullSchema, repoSchema, reviewCommentSchema, reviewSchema, userSchema } from './schemas.ts'
import type { ReviewCommentNode, ReviewNode } from './schemas.ts'
import { repositoryPath } from './urls.ts'

/** Bounds of one review read. */
export interface ReviewLimits {
  /** Most review threads one read returns. */
  readonly maxReviewThreads: number
  /** Most concurrent requests of one read. */
  readonly maxConcurrentRequests: number
}

/** Where a thread sits, which a reply names to place its comment on the same line. */
export interface ThreadPlace {
  readonly path: string
  readonly side: 'L' | 'R'
  readonly line: number
  /** Lines above `line` the comments span. */
  readonly extra: number
  /** Commit of an outdated thread, else empty. */
  readonly commit: string
}

/** The review comments of a pull request with the review that holds each. */
export interface LoadedComments {
  readonly comments: readonly ReviewCommentNode[]
  /** Whether more reviews or comments exist than were read. */
  readonly truncated: boolean
}

const MAX_REVIEWS = 200
const MAX_COMMENTS = 1_000

/**
 * Encode where a thread sits in its id.
 * @param place - path, side, and lines of the thread.
 * @returns the opaque thread id.
 */
export function threadIdOf(place: ThreadPlace): ForgeThreadId {
  return JSON.stringify([place.path, place.side, place.line, place.extra, place.commit]) as ForgeThreadId
}

/**
 * Decode a thread id made by {@link threadIdOf}.
 * @param id - thread id.
 * @returns where the thread sits, or undefined for an id this provider did not make.
 */
export function placeOf(id: ForgeThreadId): ThreadPlace | undefined {
  try {
    const parsed = z.tuple([z.string(), z.enum(['L', 'R']), z.number(), z.number(), z.string()]).safeParse(JSON.parse(id))
    if (!parsed.success) return undefined
    const [path, side, line, extra, commit] = parsed.data
    return { path, side, line, extra, commit }
  } catch (error) {
    void error // A string that is not JSON is not a thread id.
    return undefined
  }
}

/**
 * Read the comments of every review with comments.
 * @param api - Forgejo reads.
 * @param ref - pull request.
 * @param reviews - its reviews as listed.
 * @param concurrency - most concurrent reads.
 * @param signal - cancels the reads.
 * @returns the comments, or the failure of a read.
 */
export async function loadComments(
  api: ForgejoApi, ref: ChangeRequestRef, reviews: readonly ReviewNode[], concurrency: number, signal: AbortSignal,
): Promise<LoadedComments | ForgeFailure> {
  const withComments = reviews.filter(review => (review.comments_count ?? 0) > 0)
  const comments: ReviewCommentNode[] = []
  let failure: ForgeFailure | undefined
  let truncated = reviews.length >= MAX_REVIEWS
  await pool(withComments, concurrency, async (review) => {
    const read = await api.list(ref.repository.host, `${repositoryPath(ref)}/pulls/${ref.number}/reviews/${review.id}/comments`, MAX_COMMENTS, signal)
    if ('ok' in read) { failure ??= read.failure; return }
    const parsed = z.array(reviewCommentSchema).safeParse(read.items)
    if (!parsed.success) { failure ??= { code: 'unavailable', message: 'unexpected Forgejo answer to the review comment read' }; return }
    truncated ||= read.truncated
    comments.push(...parsed.data)
  })
  return failure ?? { comments: comments.sort((left, right) => left.id - right.id), truncated }
}

/**
 * List the reviews of a pull request, oldest first.
 * @param api - Forgejo reads.
 * @param ref - pull request.
 * @param signal - cancels the read.
 * @returns the reviews, or the failure.
 */
export async function loadReviews(api: ForgejoApi, ref: ChangeRequestRef, signal: AbortSignal): Promise<ReviewNode[] | ForgeFailure> {
  const read = await api.list(ref.repository.host, `${repositoryPath(ref)}/pulls/${ref.number}/reviews`, MAX_REVIEWS, signal)
  if ('ok' in read) return read.failure
  const parsed = z.array(reviewSchema).safeParse(read.items)
  return parsed.success ? parsed.data : { code: 'unavailable', message: 'unexpected Forgejo answer to the review read' }
}

/** Where one comment sits: the side and line it numbers, and whether it is a whole-file comment. */
function placeOfComment(comment: ReviewCommentNode): { side: 'L' | 'R'; line: number; file: boolean } {
  if (comment.position > 0) return { side: 'R', line: comment.position, file: false }
  if (comment.original_position > 0) return { side: 'L', line: comment.original_position, file: false }
  return { side: 'R', line: 0, file: true }
}

/**
 * Group review comments into threads. A comment on the new side is outdated once the commit it was made on is not the
 * head; one in a pending review always counts as current, because Forgejo records no commit for it.
 * @param comments - comments oldest first.
 * @param pendingReviews - ids of the viewer's pending reviews.
 * @param headSha - head commit of the read.
 * @param viewer - signed-in login, or null.
 * @param admin - whether the viewer administers the repository.
 * @param open - whether the pull request is open.
 * @param host - Forgejo host, for avatar URLs.
 * @returns the threads in order of their first comment.
 */
export function threadsOf(
  comments: readonly ReviewCommentNode[], pendingReviews: ReadonlySet<number>, headSha: string, viewer: string | null, admin: boolean,
  open: boolean, host: string,
): ForgeReviewThread[] {
  const groups = new Map<string, ReviewCommentNode[]>()
  for (const comment of comments) {
    const { side, line, file } = placeOfComment(comment)
    const outdated = side === 'R' && !file && !pendingReviews.has(comment.pull_request_review_id)
      && comment.commit_id != null && comment.commit_id !== headSha
    const key = JSON.stringify([comment.path, side, line, outdated ? comment.commit_id : ''])
    groups.set(key, [...groups.get(key) ?? [], comment])
  }
  return [...groups.values()].map((group): ForgeReviewThread => {
    const [first] = group as [ReviewCommentNode]
    const { side, line, file } = placeOfComment(first)
    const extra = first.extra_lines_count ?? 0
    const outdated = side === 'R' && !file && !pendingReviews.has(first.pull_request_review_id) && first.commit_id != null && first.commit_id !== headSha
    const anchor = (commit: string): ForgeAnchor => ({ commit, startLine: Math.max(1, line - extra), endLine: line })
    return {
      id: threadIdOf({ path: first.path, side, line, extra, commit: outdated ? first.commit_id ?? '' : '' }),
      path: first.path,
      side,
      subject: file ? 'file' : 'line',
      current: file || outdated ? null : anchor(headSha),
      original: file ? null : anchor(outdated ? first.commit_id ?? headSha : headSha),
      diffHunk: first.diff_hunk ?? null,
      resolved: first.resolver != null,
      viewerCanReply: open && viewer !== null,
      viewerCanResolve: false,
      comments: group.map(comment => commentOf(comment, pendingReviews, viewer, admin, host)),
    }
  })
}

function commentOf(
  comment: ReviewCommentNode, pendingReviews: ReadonlySet<number>, viewer: string | null, admin: boolean, host: string,
): ForgeReviewComment {
  const own = viewer !== null && comment.user?.login === viewer
  return {
    id: String(comment.id) as ForgeCommentId,
    author: comment.user === null ? null : { login: comment.user.login, avatarUrl: avatarOf(host, comment.user.avatar_url), bot: comment.user.type === 'bot' },
    body: comment.body,
    createdAt: comment.created_at,
    pending: pendingReviews.has(comment.pull_request_review_id),
    url: comment.html_url ?? null,
    viewerCanEdit: own,
    viewerCanDelete: own || admin,
  }
}

function avatarOf(host: string, url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === '') return null
  return url.startsWith('/') ? `https://${host}${url}` : url
}

/**
 * Count the threads of a pull request not marked resolved, over its submitted reviews only.
 * @param comments - loaded comments.
 * @param pendingReviews - ids of the viewer's pending reviews, which count for nobody else.
 * @param headSha - head commit.
 * @returns the number of unresolved threads.
 */
export function unresolvedCount(comments: readonly ReviewCommentNode[], pendingReviews: ReadonlySet<number>, headSha: string): number {
  return threadsOf(comments.filter(comment => !pendingReviews.has(comment.pull_request_review_id)), pendingReviews, headSha, null, false, false, '')
    .filter(thread => !thread.resolved).length
}

/**
 * Read the review threads of a pull request at one head.
 * @param api - Forgejo reads.
 * @param ref - pull request.
 * @param headSha - head the caller saw.
 * @param limits - read bounds.
 * @param signal - cancels the reads.
 * @returns the threads, `stale` once the head moved, or the failure.
 */
export async function readReviewThreads(
  api: ForgejoApi, ref: ChangeRequestRef, headSha: string, limits: ReviewLimits, signal: AbortSignal,
): Promise<ForgeReviewData | ForgeFailure> {
  const { host } = ref.repository
  const base = `${repositoryPath(ref)}`
  const [pullRead, userRead, repoRead] = await Promise.all([
    api.get(host, `${base}/pulls/${ref.number}`, signal), api.get(host, 'user', signal), api.get(host, base, signal),
  ])
  for (const read of [pullRead, userRead, repoRead]) if (!read.ok) return read.failure
  const pull = pullSchema.safeParse((pullRead as { body: unknown }).body)
  const user = userSchema.safeParse((userRead as { body: unknown }).body)
  const repo = repoSchema.safeParse((repoRead as { body: unknown }).body)
  if (!pull.success || !user.success || !repo.success) return { code: 'unavailable', message: 'unexpected Forgejo answer to the review read' }
  if (pull.data.head.sha !== headSha) return { code: 'stale', message: `the head of pull request ${ref.number} is no longer ${headSha}` }
  const reviews = await loadReviews(api, ref, signal)
  if ('code' in reviews) return reviews
  const viewer = user.data.login
  const pending = pendingOf(reviews, viewer)
  const loaded = await loadComments(api, ref, reviews, limits.maxConcurrentRequests, signal)
  if ('code' in loaded) return loaded
  const open = pull.data.state === 'open' && !pull.data.merged
  const threads = threadsOf(
    loaded.comments, new Set(pending === null ? [] : [Number(pending.id)]), headSha, viewer,
    repo.data.permissions?.admin ?? false, open, host,
  )
  return {
    headSha,
    viewer,
    threads: threads.slice(0, limits.maxReviewThreads),
    truncated: loaded.truncated || threads.length > limits.maxReviewThreads,
    pendingReview: pending,
    viewerCanReview: open,
    reviewEvents: !open ? [] : pull.data.user?.login === viewer ? ['comment'] : ['comment', 'approve', 'request-changes'] satisfies ForgeReviewEvent[],
  }
}

/**
 * The viewer's pending review among a pull request's reviews.
 * @param reviews - listed reviews, which hold only the viewer's pending one.
 * @param viewer - signed-in login.
 * @returns the pending review, or null.
 */
export function pendingOf(reviews: readonly ReviewNode[], viewer: string): ForgePendingReview | null {
  const review = reviews.find(candidate => candidate.state === 'PENDING' && candidate.user?.login === viewer)
  return review === undefined ? null : { id: String(review.id) as ForgePendingReview['id'], comments: review.comments_count ?? 0 }
}
