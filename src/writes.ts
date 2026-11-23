/** Review writes on a Forgejo pull request: submitted reviews, comments, and the viewer's pending review. */

import type {
  ChangeRequestRef, ForgeLineComment, ForgeReviewEvent, ForgeReviewRequest, ForgeReviewResult, ForgeReviewWrite, ForgeReviewWriteResult,
} from '@deepseek-ai/dsh-experimental-forge'
import { actionFailure } from './api.ts'
import type { ApiFailure, ForgejoApi } from './api.ts'
import { loadReviews, placeOf } from './review.ts'
import { pullSchema, reviewSchema, userSchema } from './schemas.ts'
import { repositoryPath } from './urls.ts'

type Refusal = Extract<ForgeReviewWriteResult, { ok: false }>

/** Forgejo's names of the review decisions. */
const EVENTS: Record<ForgeReviewEvent, string> = { comment: 'COMMENT', approve: 'APPROVED', 'request-changes': 'REQUEST_CHANGES' }

/** Body Forgejo demands of a pending review, which the body of its submission replaces. */
const PENDING_BODY = 'Pending review'

/** A host id from a comment or review the caller names, which must not reach a path as anything but a positive integer. */
function idOf(value: string): number | undefined {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

function refusal(result: ApiFailure): Refusal {
  const failure = actionFailure(result)
  return { ok: false, code: failure.code === 'unauthenticated' ? 'failed' : failure.code, message: failure.message }
}

/** One inline comment as Forgejo's review request spells it: the end line, and the lines above it the comment spans. */
function commentOf(comment: ForgeLineComment): Record<string, unknown> {
  const span = comment.endLine - comment.startLine
  return {
    path: comment.path,
    body: comment.body,
    ...comment.side === 'R' ? { new_position: comment.endLine } : { old_position: comment.endLine },
    ...span > 0 ? { extra_lines_count: span } : {},
  }
}

/** Refuse a write once the head is another commit than the one the user saw. */
async function checkHead(api: ForgejoApi, ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<Refusal | undefined> {
  const read = await api.get(ref.repository.host, `${repositoryPath(ref)}/pulls/${ref.number}`, signal)
  if (!read.ok) return { ok: false, code: 'failed', message: read.failure.message }
  const pull = pullSchema.safeParse(read.body)
  if (!pull.success) return { ok: false, code: 'failed', message: 'unexpected Forgejo answer to the pull request read' }
  return pull.data.head.sha === headSha ? undefined
    : { ok: false, code: 'stale', message: `the head of pull request ${ref.number} is no longer ${headSha}` }
}

/**
 * Publish a comment or a complete review as one Forgejo review.
 * @param api - Forgejo reads and writes.
 * @param ref - pull request.
 * @param request - the comment or review, with the head the user saw.
 * @param signal - cancels the writes.
 * @returns the review's page, or why nothing was published.
 */
export async function submitForgejoReview(
  api: ForgejoApi, ref: ChangeRequestRef, request: ForgeReviewRequest, signal: AbortSignal,
): Promise<ForgeReviewResult> {
  const stale = await checkHead(api, ref, request.headSha, signal)
  if (stale !== undefined) return stale
  const body = request.kind === 'comment'
    ? { event: EVENTS.comment, body: '', comments: [commentOf(request.comment)] }
    : { event: EVENTS[request.event], body: request.body, comments: request.comments.map(commentOf) }
  const written = await api.request(ref.repository.host, `${repositoryPath(ref)}/pulls/${ref.number}/reviews`, signal, {
    method: 'POST', json: { commit_id: request.headSha, ...body },
  })
  if (!written.ok) return refusal(written)
  const review = reviewSchema.safeParse(written.body)
  return { ok: true, url: review.success && review.data.html_url != null ? review.data.html_url : `https://${ref.repository.host}/${ref.repository.owner}/${ref.repository.name}/pulls/${ref.number}` }
}

/** The viewer's pending review, started with `headSha` when there is none. */
async function ensurePending(
  api: ForgejoApi, ref: ChangeRequestRef, headSha: string, signal: AbortSignal,
): Promise<{ id: number; created: boolean } | Refusal> {
  const { host } = ref.repository
  const user = await api.get(host, 'user', signal)
  if (!user.ok) return refusal(user)
  const login = userSchema.safeParse(user.body)
  if (!login.success) return { ok: false, code: 'failed', message: 'unexpected Forgejo answer to the user read' }
  const reviews = await loadReviews(api, ref, signal)
  if ('code' in reviews) return { ok: false, code: 'failed', message: reviews.message }
  const kept = reviews.find(review => review.state === 'PENDING' && review.user?.login === login.data.login)
  if (kept !== undefined) {
    return kept.commit_id == null || kept.commit_id === headSha ? { id: kept.id, created: false }
      : { ok: false, code: 'stale', message: 'the pending review was started on another commit than the head' }
  }
  const created = await api.request(host, `${repositoryPath(ref)}/pulls/${ref.number}/reviews`, signal, {
    method: 'POST', json: { commit_id: headSha, event: 'PENDING', body: PENDING_BODY },
  })
  if (!created.ok) return refusal(created)
  const review = reviewSchema.safeParse(created.body)
  return review.success ? { id: review.data.id, created: true } : { ok: false, code: 'unknown', message: 'Forgejo did not confirm the pending review it started' }
}

/**
 * Apply one write to the review comments or the pending review. Forgejo's API cannot resolve a conversation, so a
 * `resolve` write is `unsupported`.
 * @param api - Forgejo reads and writes.
 * @param ref - pull request.
 * @param write - the write, with the head the user saw.
 * @param signal - cancels the writes.
 * @returns whether Forgejo accepted the write.
 */
export async function writeForgejoReview(
  api: ForgejoApi, ref: ChangeRequestRef, write: ForgeReviewWrite, signal: AbortSignal,
): Promise<ForgeReviewWriteResult> {
  const { host } = ref.repository
  const base = repositoryPath(ref)
  const done = (result: { ok: true } | ApiFailure): ForgeReviewWriteResult => 'status' in result ? refusal(result) : result
  const send = async (method: 'POST' | 'PATCH' | 'DELETE', path: string, json?: unknown): Promise<ForgeReviewWriteResult> => {
    const written = await api.request(host, path, signal, { method, ...json === undefined ? {} : { json } })
    return written.ok ? { ok: true } : refusal(written)
  }
  if (write.kind === 'resolve') {
    return { ok: false, code: 'unsupported', message: 'the Forgejo API cannot resolve a conversation; resolve it on the pull request page' }
  }
  const stale = await checkHead(api, ref, write.headSha, signal)
  if (stale !== undefined) return stale
  const target = write.kind === 'edit-comment' || write.kind === 'delete-comment' ? idOf(write.comment)
    : write.kind === 'submit-pending' || write.kind === 'discard-pending' ? idOf(write.review) : 0
  if (target === undefined) return { ok: false, code: 'failed', message: 'the comment or review id was not read from Forgejo' }
  switch (write.kind) {
    case 'edit-comment': return await send('PATCH', `${base}/issues/comments/${target}`, { body: write.body })
    case 'delete-comment': return await send('DELETE', `${base}/issues/comments/${target}`)
    case 'submit-pending':
      return await send('POST', `${base}/pulls/${ref.number}/reviews/${target}`, { event: EVENTS[write.event], body: write.body })
    case 'discard-pending': return await send('DELETE', `${base}/pulls/${ref.number}/reviews/${target}`)
    case 'add-pending': {
      return await addToPending(api, ref, write.headSha, commentOf(write.comment), signal)
    }
    case 'reply': {
      const place = placeOf(write.thread)
      if (place === undefined) return { ok: false, code: 'failed', message: 'the thread was not read from Forgejo' }
      if (place.line === 0) return { ok: false, code: 'unsupported', message: 'Forgejo cannot reply to a comment on a whole file' }
      if (place.commit !== '') return { ok: false, code: 'failed', message: 'the thread is outdated; reply on the pull request page' }
      const comment = commentOf({
        path: place.path, side: place.side, startLine: place.line - place.extra, endLine: place.line, body: write.body,
      })
      if (write.pending) {
        return await addToPending(api, ref, write.headSha, comment, signal)
      }
      return done(await replyNow(api, ref, write.headSha, comment, signal))
    }
    default: return assertNever(write)
  }
}

/** Add a comment to the viewer's pending review; a review this call started is deleted again when the comment is rejected. */
async function addToPending(
  api: ForgejoApi, ref: ChangeRequestRef, headSha: string, comment: Record<string, unknown>, signal: AbortSignal,
): Promise<ForgeReviewWriteResult> {
  const { host } = ref.repository
  const base = repositoryPath(ref)
  const pending = await ensurePending(api, ref, headSha, signal)
  if ('ok' in pending) return pending
  const written = await api.request(host, `${base}/pulls/${ref.number}/reviews/${pending.id}/comments`, signal, { method: 'POST', json: comment })
  if (written.ok) return { ok: true }
  if (pending.created) {
    // The review was started for this comment only. Once it is deleted nothing of the write remains, so whatever the answer
    // to the comment, the write failed; when the deletion fails too, the outcome stays what the comment's answer says.
    const removed = await api.request(host, `${base}/pulls/${ref.number}/reviews/${pending.id}`, signal, { method: 'DELETE' })
    return removed.ok ? { ...refusal(written), code: 'failed' } : refusal(written)
  }
  return refusal(written)
}

async function replyNow(
  api: ForgejoApi, ref: ChangeRequestRef, headSha: string, comment: Record<string, unknown>, signal: AbortSignal,
): Promise<{ ok: true } | ApiFailure> {
  const written = await api.request(ref.repository.host, `${repositoryPath(ref)}/pulls/${ref.number}/reviews`, signal, {
    method: 'POST', json: { commit_id: headSha, event: EVENTS.comment, body: '', comments: [comment] },
  })
  return written.ok ? { ok: true } : written
}

function assertNever(value: never): never {
  throw new Error(`forge-forgejo: unhandled review write ${JSON.stringify(value)}`)
}
