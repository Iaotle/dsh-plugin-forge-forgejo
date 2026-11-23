/** Forgejo implementation of the forge provider contract, read and written through the Forgejo REST API with an access token. */

import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type {
  BranchUpdateRequest, ChangeRequestDescription, ChangeRequestIssue, ChangeRequestKey, ChangeRequestRef, ChangeRequestSnapshot,
  ChangeRequestSummary,
  ForgeActionFailure, ForgeCommit, ForgeCommitList, ForgeFailure, ForgeProvider, ForgeReadiness, ForgeRepository, ForgeRerunRequest,
  ForgeReviewData, ForgeReviewerCandidate, ForgeReviewersRequest, ForgeReviewRequest, ForgeReviewResult, ForgeReviewWrite,
  ForgeReviewWriteResult, ForgeViewerCapability, ForgeViewerFilter, ForgeViewerList, ForgeViewerQuery, MergeRequest,
} from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import { actionFailure, ForgejoApi } from './api.ts'
import type { ApiFailure, ApiResult } from './api.ts'
import { isCommit, textPatch } from './patch.ts'
import { pool } from './pool.ts'
import { loadComments, loadReviews, readReviewThreads, unresolvedCount } from './review.ts'
import {
  branchSchema, combinedStatusSchema, commitSchema, issueSchema, pullSchema, repoSchema, runsSchema, userSchema,
} from './schemas.ts'
import type { PullNode } from './schemas.ts'
import { closingNumbers, snapshotOf, summaryOf } from './status.ts'
import { absoluteUrl, encodedPath, parsePullRequestUrl, parseRemoteUrl, repositoryOf, repositoryPath } from './urls.ts'
import type { Hit } from './viewer.ts'
import { findViewerLists, VIEWER_FILTERS } from './viewer.ts'
import { submitForgejoReview, writeForgejoReview } from './writes.ts'

/** Closing issues one snapshot lists. */
const CLOSING_ISSUES = 25

/** Open pull requests a head lookup reads. */
const HEAD_LOOKUP = 200

/** Checks one read lists; Forgejo returns at most this many statuses of a commit at once. */
const CHECKS = 50

/** Bounds of the provider's reads. */
export interface ForgejoLimits {
  /** Most review threads one review read returns. */
  readonly maxReviewThreads: number
  /** Most commits one commit listing returns. */
  readonly maxCommits: number
  /** Most requests one status fetch runs at once. */
  readonly maxConcurrentRequests: number
  /** Most pull requests one viewer list returns. */
  readonly maxViewerItems: number
}

/** The issues a pull request closes, kept until its update time changes. */
interface ClosingIssues {
  readonly updatedAt: string
  readonly issues: readonly ChangeRequestIssue[]
  readonly truncated: boolean
}

/** A viewer list entry for a pull request whose head, checks, or reviews could not be read. */
function unreadSummary(hit: Hit): ChangeRequestSummary {
  const { author } = hit
  return {
    ref: hit.ref,
    url: hit.url,
    title: hit.title,
    draft: hit.draft,
    author: author === null ? null : { login: author.login, avatarUrl: absoluteUrl(hit.ref.repository.host, author.avatar_url), bot: author.type === 'bot' },
    headSha: '',
    checksRollup: 'none',
    reviewDecision: 'none',
    viewerReview: null,
    viewerRequest: null,
    closingIssues: [],
    closingIssuesTruncated: false,
    updatedAt: hit.updatedAt,
  }
}

/** Reads and writes pull requests on Forgejo hosts. */
export class ForgejoProvider implements ForgeProvider {
  readonly forge = 'forgejo'
  readonly hosts: readonly string[]
  readonly label = 'Forgejo'
  readonly changeRequestNoun = 'pull-request'
  readonly viewer: ForgeViewerCapability
  private readonly served: ReadonlySet<string>
  /** Closing issues by pull request; one entry per pull request this provider polled. */
  private readonly closing = new Map<ChangeRequestKey, ClosingIssues>()

  /**
   * @param api - Forgejo REST client.
   * @param hosts - host names this provider serves.
   * @param limits - read bounds.
   */
  constructor(private readonly api: ForgejoApi, hosts: readonly string[], private readonly limits: ForgejoLimits) {
    this.hosts = [...new Set(hosts.map(host => host.toLowerCase()))]
    this.served = new Set(this.hosts)
    this.viewer = { hosts: this.hosts, filters: VIEWER_FILTERS, maxItems: limits.maxViewerItems }
  }

  repositoryFromRemote(url: string): ForgeRepository | undefined {
    const location = parseRemoteUrl(url)
    return location === undefined || !this.served.has(location.host) ? undefined : repositoryOf(location)
  }

  changeRequestFromUrl(url: string): ChangeRequestRef | undefined {
    const parsed = parsePullRequestUrl(url)
    return parsed === undefined || !this.served.has(parsed.host) ? undefined : { repository: repositoryOf(parsed), number: parsed.number }
  }

  changeRequestUrl(ref: ChangeRequestRef): string {
    const { host, owner, name } = ref.repository
    return `https://${host}/${owner}/${name}/pulls/${ref.number}`
  }

  async fetch(
    refs: readonly ChangeRequestRef[], signal: AbortSignal,
  ): Promise<ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>> {
    const results = new Map<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>()
    await pool(refs, this.limits.maxConcurrentRequests, async (ref) => {
      try {
        results.set(changeRequestKey(ref), await this.fetchChecks(ref, signal))
      } catch (error) {
        if (signal.aborted) throw error
        results.set(changeRequestKey(ref), { code: 'unavailable', message: error instanceof Error ? error.message : String(error) })
      }
    })
    return results
  }

  async fetchChecks(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestSnapshot | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    const { host } = ref.repository
    const base = repositoryPath(ref)
    const [pullRead, repoRead, userRead] = await Promise.all([
      this.api.get(host, `${base}/pulls/${ref.number}`, signal), this.api.get(host, base, signal), this.api.get(host, 'user', signal),
    ])
    if (!pullRead.ok) return pullRead.failure
    if (!repoRead.ok) return repoRead.failure
    const pull = pullSchema.safeParse(pullRead.body)
    const repo = repoSchema.safeParse(repoRead.body)
    if (!pull.success || !repo.success) return { code: 'unavailable', message: 'unexpected Forgejo answer to the status read' }
    const sha = pull.data.head.sha
    if (!isCommit(sha)) return { code: 'unavailable', message: 'Forgejo reported a head that is not a commit' }
    const [branchRead, statusRead, runsRead, reviews] = await Promise.all([
      this.api.get(host, `${base}/branches/${encodeURIComponent(pull.data.base.ref)}`, signal),
      this.api.get(host, `${base}/commits/${sha}/status?limit=${CHECKS}`, signal),
      this.api.get(host, `${base}/actions/runs?head_sha=${sha}&limit=${CHECKS}`, signal),
      loadReviews(this.api, ref, signal),
    ])
    if (!statusRead.ok) return statusRead.failure
    if (!branchRead.ok && branchRead.status !== 404) return branchRead.failure
    if ('code' in reviews) return reviews
    const combined = combinedStatusSchema.safeParse(statusRead.body)
    if (!combined.success) return { code: 'unavailable', message: 'unexpected Forgejo answer to the status read' }
    const branch = branchRead.ok ? branchSchema.safeParse(branchRead.body) : undefined
    // A repository without Actions, or a token without the scope, answers the run read with a failure: no check can be rerun.
    const runs = runsRead.ok ? runsSchema.safeParse(runsRead.body) : undefined
    const pending = new Set(reviews.filter(review => review.state === 'PENDING').map(review => review.id))
    const submitted = reviews.filter(review => !pending.has(review.id))
    const comments = await loadComments(this.api, ref, submitted, this.limits.maxConcurrentRequests, signal)
    if ('code' in comments) return comments
    const closing = await this.closingIssues(ref, pull.data, signal)
    return snapshotOf({
      ref, pull: pull.data, repo: repo.data, branch: branch?.success === true ? branch.data : undefined, combined: combined.data,
      checksTruncated: combined.data.total_count > combined.data.statuses.length,
      runs: runs?.success === true ? runs.data.workflow_runs : [], reviews,
      unresolvedThreads: unresolvedCount(comments.comments, pending, sha), threadsTruncated: comments.truncated,
      closingIssues: closing.issues, closingIssuesTruncated: closing.truncated,
      viewer: userRead.ok ? userSchema.safeParse(userRead.body).data?.login ?? null : null,
    })
  }

  /**
   * Read one viewer list: Forgejo's issue search finds the pull requests, then each one's head, checks, and reviews are read.
   * @throws when the limit is not a positive integer no greater than `maxViewerItems`.
   */
  async listForViewer(query: ForgeViewerQuery, signal: AbortSignal): Promise<ForgeViewerList | ForgeFailure> {
    const failure = this.hostFailure(query.host)
    if (failure !== undefined) return failure
    if (!Number.isSafeInteger(query.limit) || query.limit <= 0 || query.limit > this.limits.maxViewerItems) {
      throw new Error(`forge-forgejo: viewer list limit must be a positive integer no greater than ${this.limits.maxViewerItems}`)
    }
    const found = await findViewerLists(this.api, query.host.toLowerCase(), [query.filter], query.repository, signal)
    if ('code' in found) return found
    const hits = found.lists.get(query.filter) ?? []
    const shown = hits.slice(0, query.limit)
    const items: ChangeRequestSummary[] = new Array<ChangeRequestSummary>(shown.length)
    await pool(shown.map((hit, index) => ({ hit, index })), this.limits.maxConcurrentRequests, async ({ hit, index }) => {
      const read = await this.summaryOf(hit.ref, found.viewer, signal)
      // A pull request whose status cannot be read stays in the list with what the search knows; opening it reports the failure.
      items[index] = 'code' in read ? unreadSummary(hit) : read
    })
    return { viewer: found.viewer, items, total: hits.length }
  }

  /** Count every viewer list on one host from one set of searches. */
  async countForViewer(host: string, signal: AbortSignal): Promise<ReadonlyMap<ForgeViewerFilter, number> | ForgeFailure> {
    const failure = this.hostFailure(host)
    if (failure !== undefined) return failure
    const found = await findViewerLists(this.api, host.toLowerCase(), [...VIEWER_FILTERS], null, signal)
    if ('code' in found) return found
    return new Map([...found.lists].map(([filter, hits]) => [filter, hits.length]))
  }

  private async summaryOf(ref: ChangeRequestRef, viewer: string, signal: AbortSignal): Promise<ChangeRequestSummary | ForgeFailure> {
    const { host } = ref.repository
    const base = repositoryPath(ref)
    const pull = await this.pullOf(ref, signal)
    if ('code' in pull) return pull
    if (!isCommit(pull.head.sha)) return { code: 'unavailable', message: 'Forgejo reported a head that is not a commit' }
    const [branchRead, statusRead, reviews, closing] = await Promise.all([
      this.api.get(host, `${base}/branches/${encodeURIComponent(pull.base.ref)}`, signal),
      this.api.get(host, `${base}/commits/${pull.head.sha}/status?limit=${CHECKS}`, signal),
      loadReviews(this.api, ref, signal),
      this.closingIssues(ref, pull, signal),
    ])
    if (!statusRead.ok) return statusRead.failure
    if (!branchRead.ok && branchRead.status !== 404) return branchRead.failure
    if ('code' in reviews) return reviews
    const combined = combinedStatusSchema.safeParse(statusRead.body)
    if (!combined.success) return { code: 'unavailable', message: 'unexpected Forgejo answer to the status read' }
    const branch = branchRead.ok ? branchSchema.safeParse(branchRead.body) : undefined
    return summaryOf({
      ref, pull, branch: branch?.success === true ? branch.data : undefined, combined: combined.data, reviews,
      closingIssues: closing.issues, closingIssuesTruncated: closing.truncated,
    }, viewer)
  }

  async findByHead(repository: ForgeRepository, branch: string, signal: AbortSignal): Promise<readonly ChangeRequestRef[]> {
    const failure = this.hostFailure(repository.host)
    if (failure !== undefined) throw new Error(failure.message)
    const base = repositoryPath({ repository, number: 1 })
    const [settings, listing] = await Promise.all([
      this.api.get(repository.host, base, signal), this.api.list(repository.host, `${base}/pulls?state=open&sort=recentupdate`, HEAD_LOOKUP, signal),
    ])
    if (!settings.ok) throw new Error(`forge-forgejo: head branch lookup failed: ${settings.failure.message}`)
    if ('ok' in listing) throw new Error(`forge-forgejo: head branch lookup failed: ${listing.failure.message}`)
    const defaults = repoSchema.safeParse(settings.body)
    const pulls = z.array(pullSchema).safeParse(listing.items)
    if (!defaults.success || !pulls.success) throw new Error('forge-forgejo: unexpected Forgejo response to the head branch lookup')
    if (defaults.data.default_branch === branch) return []
    return pulls.data.filter(pull => pull.head.ref === branch && pull.head.repo?.full_name === pull.base.repo?.full_name)
      .map(pull => ({ repository, number: pull.number }))
  }

  async readiness(host: string, signal: AbortSignal): Promise<ForgeReadiness> {
    const failure = this.hostFailure(host)
    if (failure !== undefined) return { state: 'unavailable', message: failure.message, signIn: null }
    const read = await this.api.get(host, 'user', signal)
    if (read.ok) return { state: 'ready', message: null, signIn: null }
    return { state: read.failure.code === 'unauthenticated' ? 'unauthenticated' : 'unavailable', message: read.failure.message, signIn: null }
  }

  /** Mark a draft ready by removing the `WIP:` or `[WIP]` prefix Forgejo reads a draft from; a ready one stays ready. */
  async markReady(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const refused = this.writable(ref, null)
    if (refused !== undefined) return refused
    const pull = await this.pullOf(ref, signal)
    if ('code' in pull) return { code: pull.code === 'unauthenticated' ? 'unauthenticated' : 'failed', message: pull.message }
    if (!pull.draft) return undefined
    const title = pull.title.replace(/^(?:\s*(?:\[WIP\]|WIP:)\s*)+/i, '')
    return await this.send('PATCH', `${repositoryPath(ref)}/pulls/${ref.number}`, ref, signal, { title })
  }

  /** Merge through the REST merge endpoint with `head_commit_id` set to the confirmed head, which Forgejo refuses once the head moved. */
  async merge(ref: ChangeRequestRef, request: MergeRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const refused = this.writable(ref, request.headSha)
    if (refused !== undefined) return refused
    const written = await this.api.request(ref.repository.host, `${repositoryPath(ref)}/pulls/${ref.number}/merge`, signal, {
      method: 'POST', json: { Do: request.method, head_commit_id: request.headSha },
    })
    if (written.ok) return undefined
    if (written.status !== 409 && written.status !== 405) return actionFailure(written)
    const current = await this.pullOf(ref, signal)
    const moved = !('code' in current) && current.head.sha !== request.headSha
    return { code: moved ? 'stale' : 'failed', message: written.failure.message }
  }

  async submitReview(ref: ChangeRequestRef, request: ForgeReviewRequest, signal: AbortSignal): Promise<ForgeReviewResult> {
    const refused = this.writable(ref, request.headSha)
    return refused === undefined ? await submitForgejoReview(this.api, ref, request, signal) : { ok: false, code: 'failed', message: refused.message }
  }

  async writeReview(ref: ChangeRequestRef, write: ForgeReviewWrite, signal: AbortSignal): Promise<ForgeReviewWriteResult> {
    const refused = this.writable(ref, write.headSha)
    return refused === undefined ? await writeForgejoReview(this.api, ref, write, signal) : { ok: false, code: 'failed', message: refused.message }
  }

  async readReview(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<ForgeReviewData | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    return failure ?? await readReviewThreads(this.api, ref, headSha, this.limits, signal)
  }

  async readDescription(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestDescription | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    const pull = await this.pullOf(ref, signal)
    if ('code' in pull) return pull
    const labels = (pull.labels ?? []).map(label => ({ name: label.name, color: /^[0-9a-f]{6}$/i.test(label.color ?? '') ? label.color ?? null : null }))
    return { body: pull.body ?? '', labels, labelsTruncated: false, images: {}, imagesExpireAt: null, createdAt: pull.created_at }
  }

  /**
   * Rerun the Actions runs of the failed checks of the head commit once no check is pending. Forgejo reruns a whole
   * run, so the passing jobs of that run run again too.
   */
  async rerunChecks(ref: ChangeRequestRef, request: ForgeRerunRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const refused = this.writable(ref, request.headSha)
    if (refused !== undefined) return refused
    const read = await this.fetchChecks(ref, signal)
    if ('code' in read) return { code: read.code === 'unauthenticated' ? 'unauthenticated' : 'failed', message: read.message }
    if (read.headSha !== request.headSha) return { code: 'stale', message: `the head of pull request ${ref.number} is no longer ${request.headSha}` }
    if (read.checks.some(check => check.state === 'pending')) return { code: 'failed', message: 'checks are still running' }
    const runs = [...new Set(read.checks.filter(check => check.state === 'failure' && check.rerun !== null).map(check => check.rerun))]
    if (runs.length === 0) return { code: 'failed', message: 'no failed check can be rerun' }
    if (read.checksTruncated) return { code: 'failed', message: 'the checks of the head are more than one read lists; rerun them on the host' }
    const started: string[] = []
    for (const run of runs) {
      const failure = await this.send('POST', `${repositoryPath(ref)}/actions/runs/${run}/rerun`, ref, signal)
      if (failure !== undefined) {
        return started.length === 0 ? failure
          : { code: 'unknown', message: `runs ${started.join(', ')} were rerun before: ${failure.message}` }
      }
      started.push(String(run))
    }
    return undefined
  }

  async requestReviews(
    ref: ChangeRequestRef, request: ForgeReviewersRequest, signal: AbortSignal,
  ): Promise<ForgeActionFailure | undefined> {
    const refused = this.writable(ref, null)
    if (refused !== undefined) return refused
    const users = request.reviewers.filter(reviewer => reviewer.kind !== 'team').map(reviewer => reviewer.login)
    const teams = request.reviewers.filter(reviewer => reviewer.kind === 'team').map(reviewer => reviewer.login.split('/').pop() ?? reviewer.login)
    return await this.send('POST', `${repositoryPath(ref)}/pulls/${ref.number}/requested_reviewers`, ref, signal, { reviewers: users, team_reviewers: teams })
  }

  async reviewerCandidates(
    ref: ChangeRequestRef, query: string, signal: AbortSignal,
  ): Promise<readonly ForgeReviewerCandidate[] | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    const [read, pull] = await Promise.all([
      this.api.get(ref.repository.host, `${repositoryPath(ref)}/reviewers`, signal), this.pullOf(ref, signal),
    ])
    if (!read.ok) return read.failure
    if ('code' in pull) return pull
    const users = z.array(userSchema.extend({ full_name: z.string().nullish() })).safeParse(read.body)
    if (!users.success) return { code: 'unavailable', message: 'unexpected Forgejo answer to the reviewer read' }
    const needle = query.trim().toLowerCase()
    return users.data
      .filter(user => user.login !== pull.user?.login)
      .filter(user => needle === '' || user.login.toLowerCase().includes(needle) || (user.full_name ?? '').toLowerCase().includes(needle))
      .map(user => ({
        login: user.login, name: user.full_name === '' ? null : user.full_name ?? null,
        avatarUrl: user.avatar_url?.startsWith('/') === true ? `https://${ref.repository.host}${user.avatar_url}` : user.avatar_url ?? null,
        suggested: false,
      }))
  }

  /** Update the head branch through `pulls/{index}/update` after reading that its head is still the confirmed one. */
  async updateBranch(ref: ChangeRequestRef, request: BranchUpdateRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const refused = this.writable(ref, request.headSha)
    if (refused !== undefined) return refused
    const pull = await this.pullOf(ref, signal)
    if ('code' in pull) return { code: pull.code === 'unauthenticated' ? 'unauthenticated' : 'failed', message: pull.message }
    if (pull.head.sha !== request.headSha) return { code: 'stale', message: `the head of pull request ${ref.number} is no longer ${request.headSha}` }
    return await this.send('POST', `${repositoryPath(ref)}/pulls/${ref.number}/update?style=${request.method}`, ref, signal)
  }

  /** Read the pull request's `.diff` once its head is `headSha`; `base` is not needed because Forgejo names the merge base itself. */
  async diff(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    if (!isCommit(headSha)) throw new Error(`forge-forgejo: invalid head commit ${JSON.stringify(headSha)}`)
    const pull = await this.pullOf(ref, signal)
    if ('code' in pull) return pull
    if (pull.head.sha !== headSha) return { code: 'stale', message: `the head of pull request ${ref.number} is no longer ${headSha}` }
    const read = await this.api.request(ref.repository.host, `${repositoryPath(ref)}/pulls/${ref.number}.diff`, signal, { text: true })
    if (!read.ok) return read.failure
    const after = await this.pullOf(ref, signal)
    if ('code' in after) return after
    return after.head.sha === headSha ? String(read.body ?? '') : { code: 'stale', message: `the head of pull request ${ref.number} moved while its diff was read` }
  }

  async fileText(ref: ChangeRequestRef, commit: string, path: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    if (!isCommit(commit)) throw new Error(`forge-forgejo: invalid commit ${JSON.stringify(commit)}`)
    const read = await this.api.request(
      ref.repository.host, `${repositoryPath(ref)}/raw/${encodedPath(path)}?ref=${commit}`, signal, { text: true },
    )
    return read.ok ? String(read.body ?? '') : read.failure
  }

  fileUrl(ref: ChangeRequestRef, commit: string, path: string): string {
    const { host, owner, name } = ref.repository
    return `https://${host}/${owner}/${name}/src/commit/${commit}/${encodedPath(path)}`
  }

  async commits(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeCommitList | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    const pull = await this.pullOf(ref, signal)
    if ('code' in pull) return pull
    const headSha = pull.head.sha
    const read = await this.api.list(ref.repository.host, `${repositoryPath(ref)}/pulls/${ref.number}/commits?verification=false&files=false`, 5_000, signal)
    if ('ok' in read) return read.failure
    const parsed = z.array(commitSchema).safeParse(read.items)
    if (!parsed.success) return { code: 'unavailable', message: 'unexpected Forgejo answer to the commit read' }
    const after = await this.pullOf(ref, signal)
    if ('code' in after) return after
    if (after.head.sha !== headSha) return { code: 'stale', message: `the head of pull request ${ref.number} moved while its commits were read` }
    // Forgejo lists newest first; the contract is oldest first.
    const oldestFirst = parsed.data[0]?.sha === headSha ? [...parsed.data].reverse() : parsed.data
    const kept = oldestFirst.slice(0, this.limits.maxCommits)
    return {
      headSha,
      commits: kept.map((commit): ForgeCommit => ({
        sha: commit.sha, parent: commit.parents?.[0]?.sha ?? null, title: commit.commit.message.split('\n', 1)[0] ?? '',
        author: commit.author?.login ?? commit.commit.author?.name ?? null, authoredAt: commit.commit.author?.date ?? '',
      })),
      truncated: oldestFirst.length > kept.length,
    }
  }

  /** Compare the files `compare` lists by their text at both commits, since Forgejo's API gives no patch for a range. */
  async compare(ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    if (!isCommit(base) || !isCommit(head)) throw new Error(`forge-forgejo: invalid commits ${JSON.stringify(`${base}..${head}`)}`)
    const read = await this.api.get(ref.repository.host, `${repositoryPath(ref)}/compare/${base}...${head}`, signal)
    if (!read.ok) return read.failure
    const files = z.object({ files: z.array(z.object({ filename: z.string(), status: z.string() })).nullish() }).safeParse(read.body)
    if (!files.success) return { code: 'unavailable', message: 'unexpected Forgejo answer to the compare read' }
    const text = async (commit: string, path: string, present: boolean): Promise<string | ForgeFailure> =>
      present ? await this.fileText(ref, commit, path, signal) : ''
    const patches: string[] = []
    for (const file of files.data.files ?? []) {
      const [before, after] = await Promise.all([text(base, file.filename, file.status !== 'added'), text(head, file.filename, file.status !== 'deleted')])
      if (typeof before !== 'string') return before
      if (typeof after !== 'string') return after
      const oldName = file.status === 'added' ? '/dev/null' : `a/${file.filename}`
      const newName = file.status === 'deleted' ? '/dev/null' : `b/${file.filename}`
      patches.push(before.includes('\0') || after.includes('\0') ? `Binary files ${oldName} and ${newName} differ\n`
        : `diff --git a/${file.filename} b/${file.filename}\n${textPatch(oldName, newName, before, after)}`)
    }
    return patches.join('')
  }

  /** The issues a pull request closes by keyword in its description, read once per update time of the pull request. */
  private async closingIssues(ref: ChangeRequestRef, pull: PullNode, signal: AbortSignal): Promise<ClosingIssues> {
    const key = changeRequestKey(ref)
    const kept = this.closing.get(key)
    if (kept?.updatedAt === pull.updated_at) return kept
    const numbers = closingNumbers(pull.body, ref.number)
    const issues: ChangeRequestIssue[] = []
    let complete = true
    for (const number of numbers.slice(0, CLOSING_ISSUES)) {
      const read = await this.api.get(ref.repository.host, `${repositoryPath(ref)}/issues/${number}`, signal)
      if (!read.ok) {
        // A number that names no issue is not a closing issue; any other failure leaves the list incomplete.
        if (read.status !== 404) complete = false
        continue
      }
      const issue = issueSchema.safeParse(read.body)
      const isPull = typeof read.body === 'object' && read.body !== null && 'pull_request' in read.body && read.body.pull_request != null
      if (!issue.success) complete = false
      else if (!isPull) {
        issues.push({ repository: ref.repository, number, title: issue.data.title, state: issue.data.state === 'closed' ? 'closed' : 'open', url: issue.data.html_url })
      }
    }
    const entry = { updatedAt: pull.updated_at, issues, truncated: numbers.length > CLOSING_ISSUES || !complete }
    if (complete) this.closing.set(key, entry)
    return entry
  }

  private async pullOf(ref: ChangeRequestRef, signal: AbortSignal): Promise<PullNode | ForgeFailure> {
    const read = await this.api.get(ref.repository.host, `${repositoryPath(ref)}/pulls/${ref.number}`, signal)
    if (!read.ok) return read.failure
    const pull = pullSchema.safeParse(read.body)
    return pull.success ? pull.data : { code: 'unavailable', message: 'unexpected Forgejo answer to the pull request read' }
  }

  private async send(
    method: 'POST' | 'PATCH', path: string, ref: ChangeRequestRef, signal: AbortSignal, json?: unknown,
  ): Promise<ForgeActionFailure | undefined> {
    const written: ApiResult = await this.api.request(ref.repository.host, path, signal, { method, ...json === undefined ? {} : { json } })
    return written.ok ? undefined : actionFailure(written as ApiFailure)
  }

  /**
   * Refuse a write to a host this provider does not serve.
   * @throws when `headSha` is given and is not a full commit object name, which callers check before they write.
   */
  private writable(ref: ChangeRequestRef, headSha: string | null): ForgeActionFailure | undefined {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return { code: 'failed', message: failure.message }
    if (headSha !== null && !isCommit(headSha)) throw new Error(`forge-forgejo: invalid head commit ${JSON.stringify(headSha)}`)
    return undefined
  }

  private hostFailure(host: string): ForgeFailure | undefined {
    return this.served.has(host.toLowerCase()) ? undefined : {
      code: 'unavailable',
      message: `forge-forgejo does not serve ${host}; add it to the provider's hosts setting`,
    }
  }
}
