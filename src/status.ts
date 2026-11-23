/** Maps Forgejo pull request reads onto a change request snapshot. */

import type {
  BranchUpdateMethod, ChangeRequestCheck, ChangeRequestIssue, ChangeRequestRef, ChangeRequestReviewer, ChangeRequestSnapshot,
  ChangeRequestSummary, CheckState, ChecksRollup, ForgeCheckId, MergeMethod, ReviewDecision, ReviewVerdict,
} from '@deepseek-ai/dsh-experimental-forge'
import type { BranchNode, PullNode, RepoNode, ReviewNode, RunNode } from './schemas.ts'
import { combinedStatusSchema } from './schemas.ts'
import type { z } from 'zod'
import { absoluteUrl } from './urls.ts'

/** A combined commit status as Forgejo reports it. */
export type CombinedStatus = z.infer<typeof combinedStatusSchema>

/** Everything one snapshot is made from. */
export interface StatusParts {
  readonly ref: ChangeRequestRef
  readonly pull: PullNode
  readonly repo: RepoNode
  readonly branch: BranchNode | undefined
  readonly combined: CombinedStatus
  /** Whether the combined status lists fewer checks than the host holds. */
  readonly checksTruncated: boolean
  readonly runs: readonly RunNode[]
  readonly reviews: readonly ReviewNode[]
  readonly unresolvedThreads: number
  readonly threadsTruncated: boolean
  readonly closingIssues: readonly ChangeRequestIssue[]
  readonly closingIssuesTruncated: boolean
  /** Signed-in login, or null when unknown. */
  readonly viewer: string | null
}

/**
 * Issue numbers a pull request description closes with Forgejo's keywords (`closes #1`, `fixes: #2`, `resolved #3`).
 * @param body - description Markdown.
 * @param self - the pull request's own number, which never closes itself.
 * @returns the distinct numbers in order of appearance.
 */
export function closingNumbers(body: string | null | undefined, self: number): number[] {
  const numbers = new Set<number>()
  for (const match of (body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi)) {
    const number = Number(match[1])
    if (Number.isSafeInteger(number) && number > 0 && number !== self) numbers.add(number)
  }
  return [...numbers]
}

/** A commit status state as a check state; states outside Forgejo's documented set read as pending. */
function checkState(status: string): CheckState {
  switch (status) {
    case 'success': return 'success'
    case 'failure':
    case 'error': return 'failure'
    case 'warning': return 'neutral'
    case 'skipped': return 'skipped'
    case 'cancelled': return 'cancelled'
    default: return 'pending'
  }
}

/** The run index in a status target such as `/owner/name/actions/runs/5/jobs/0`, or undefined for a status that is not an Actions job. */
function runIndexOf(target: string | null | undefined): number | undefined {
  const match = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(target ?? '')
  return match === null ? undefined : Number(match[1])
}

/**
 * Map the commit statuses of the head commit to checks. Forgejo Actions reports each job as a commit status named
 * `<workflow> / <job> (<event>)`, whose target names the run, so a status whose run is listed can be rerun.
 * @param host - Forgejo host, for relative target URLs.
 * @param combined - latest status of each context.
 * @param runs - Actions runs of the head commit.
 * @returns one check per status context in host order.
 */
export function checksOf(host: string, combined: CombinedStatus, runs: readonly RunNode[]): ChangeRequestCheck[] {
  return combined.statuses.map((status) => {
    const run = runs.find(candidate => candidate.index_in_repo === runIndexOf(status.target_url))
    const match = /^(?:(.*?) )?\/ (.+)$/.exec(status.context)
    const state = checkState(status.status)
    return {
      name: match?.[2] ?? status.context,
      state,
      url: absoluteUrl(host, status.target_url),
      workflow: match === null ? null : match[1] ?? run?.workflow_id ?? null,
      startedAt: run?.started ?? status.created_at ?? null,
      completedAt: state === 'pending' ? null : run?.stopped ?? status.updated_at ?? null,
      rerun: run === undefined ? null : String(run.id) as ForgeCheckId,
    }
  })
}

/**
 * The combined outcome: no statuses, any failure, any pending, else success.
 * @param combined - latest status of each context.
 * @returns the rollup.
 */
export function rollupOf(combined: CombinedStatus): ChecksRollup {
  if (combined.total_count === 0 || combined.statuses.length === 0) return 'none'
  switch (combined.state) {
    case 'success':
    case 'warning': return 'success'
    case 'failure':
    case 'error': return 'failure'
    default: return 'pending'
  }
}

/** One account's latest verdict: a deciding review beats a plain comment, a later one beats an earlier one. */
interface Verdict {
  readonly verdict: ReviewVerdict
  readonly sha: string | null
  readonly bot: boolean
  readonly avatar: string | null
}

function verdictsOf(reviews: readonly ReviewNode[], host: string): Map<string, Verdict> {
  const latest = new Map<string, { verdict: ReviewVerdict; at: string; deciding: boolean; node: ReviewNode }>()
  for (const review of reviews) {
    const login = review.user?.login
    if (login === undefined || review.state === 'PENDING' || review.state === 'REQUEST_REVIEW') continue
    const verdict: ReviewVerdict = review.dismissed === true ? 'dismissed' : review.state === 'APPROVED' ? 'approved'
      : review.state === 'REQUEST_CHANGES' ? 'changes-requested' : 'commented'
    const entry = { verdict, at: review.submitted_at ?? '', deciding: verdict !== 'commented', node: review }
    const kept = latest.get(login)
    const replaces = kept === undefined || (entry.deciding && !kept.deciding) || (entry.deciding === kept.deciding && entry.at >= kept.at)
    if (replaces) latest.set(login, entry)
  }
  return new Map([...latest].map(([login, entry]) => [login, {
    verdict: entry.verdict, sha: entry.node.commit_id ?? null, bot: entry.node.user?.type === 'bot', avatar: absoluteUrl(host, entry.node.user?.avatar_url),
  }]))
}

/** Reviewers whose review is requested, then the accounts that reviewed; the author is never listed. */
function reviewersOf(parts: StatusParts, verdicts: ReadonlyMap<string, Verdict>): ChangeRequestReviewer[] {
  const { pull, ref } = parts
  const host = ref.repository.host
  const author = pull.user?.login.toLowerCase()
  const listed: ChangeRequestReviewer[] = []
  const seen = new Set<string>()
  for (const user of pull.requested_reviewers ?? []) {
    if (user.login.toLowerCase() === author || seen.has(user.login)) continue
    seen.add(user.login)
    const verdict = verdicts.get(user.login)
    listed.push({
      kind: user.type === 'bot' ? 'bot' : 'user', login: user.login, avatarUrl: absoluteUrl(host, user.avatar_url), requested: true,
      codeOwner: false, verdict: verdict?.verdict ?? null, reviewedSha: verdict?.sha ?? null,
    })
  }
  for (const team of pull.requested_reviewers_teams ?? []) {
    const login = `${team.organization?.username ?? ref.repository.owner}/${team.name}`
    if (seen.has(login)) continue
    seen.add(login)
    listed.push({ kind: 'team', login, avatarUrl: null, requested: true, codeOwner: false, verdict: null, reviewedSha: null })
  }
  for (const [login, verdict] of verdicts) {
    if (login.toLowerCase() === author || seen.has(login)) continue
    seen.add(login)
    listed.push({
      kind: verdict.bot ? 'bot' : 'user', login, avatarUrl: verdict.avatar, requested: false, codeOwner: false, verdict: verdict.verdict,
      reviewedSha: verdict.sha,
    })
  }
  return listed
}

/** A reviewer who requested changes decides first; then enough approvals, as the base branch's protection demands, or any approval. */
function decisionOf(verdicts: ReadonlyMap<string, Verdict>, required: number): ReviewDecision {
  const all = [...verdicts.values()]
  if (all.some(entry => entry.verdict === 'changes-requested')) return 'changes-requested'
  const approvals = all.filter(entry => entry.verdict === 'approved').length
  if (required > 0) return approvals >= required ? 'approved' : 'review-required'
  return approvals > 0 ? 'approved' : 'none'
}

/**
 * Merge methods the repository accepts with its default first; `rebase-merge` has no neutral name and is left out.
 * @param repo - the repository.
 * @returns the methods.
 */
export function mergeMethodsOf(repo: RepoNode): MergeMethod[] {
  const allowed: [MergeMethod, boolean | null | undefined][] = [
    ['merge', repo.allow_merge_commits], ['rebase', repo.allow_rebase], ['squash', repo.allow_squash_merge],
  ]
  const methods = allowed.filter(([, on]) => on === true).map(([method]) => method)
  const preferred = methods.find(method => method === repo.default_merge_style)
  return preferred === undefined ? methods : [preferred, ...methods.filter(method => method !== preferred)]
}

/** Update methods in the repository's preferred order. */
function updateMethodsOf(repo: RepoNode): BranchUpdateMethod[] {
  return repo.default_update_style === 'rebase' && repo.allow_rebase_update !== false ? ['rebase', 'merge'] : ['merge', 'rebase']
}

/**
 * Build a snapshot from the pieces of one read.
 * @param parts - the pull request and what was read with it.
 * @returns the snapshot.
 */
export function snapshotOf(parts: StatusParts): ChangeRequestSnapshot {
  const { ref, pull, repo, branch, combined } = parts
  const host = ref.repository.host
  const state = pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open'
  const open = state === 'open'
  const push = repo.permissions?.push ?? false
  const verdicts = verdictsOf(parts.reviews, host)
  const decision = decisionOf(verdicts, branch?.required_approvals ?? 0)
  const checks = checksOf(host, combined, parts.runs)
  const rollup = rollupOf(combined)
  const mergeability = !open ? 'unknown' : pull.mergeable ? 'mergeable' : 'conflicting'
  const sameRepository = pull.head.repo != null && pull.head.repo.full_name === pull.base.repo?.full_name
  const behind = pull.merge_base != null && pull.merge_base !== pull.base.sha
  const canMerge = branch?.user_can_merge ?? push
  return {
    ref,
    url: pull.html_url,
    title: pull.title,
    state,
    draft: pull.draft,
    author: pull.user?.login ?? null,
    headBranch: pull.head.ref,
    headSha: pull.head.sha,
    baseBranch: pull.base.ref,
    ...pull.merge_base == null ? {} : { baseSha: pull.merge_base },
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    mergeability,
    mergeReady: open && !pull.draft && mergeability === 'mergeable' && canMerge && decision !== 'changes-requested' && decision !== 'review-required'
      && (branch?.enable_status_check !== true || rollup === 'success'),
    mergeMethods: mergeMethodsOf(repo),
    branchUpdates: open && behind && sameRepository && mergeability === 'mergeable' && push ? updateMethodsOf(repo) : [],
    reviewDecision: decision,
    reviewers: reviewersOf(parts, verdicts),
    reviewersTruncated: false,
    canRequestReviews: open && push,
    checks,
    checksRollup: rollup,
    checksTruncated: parts.checksTruncated,
    canRerunChecks: open && push && checks.some(check => check.rerun !== null),
    unresolvedThreads: parts.unresolvedThreads,
    threadsTruncated: parts.threadsTruncated,
    closingIssues: parts.closingIssues,
    closingIssuesTruncated: parts.closingIssuesTruncated,
    updatedAt: pull.updated_at,
    closedAt: state === 'merged' ? pull.merged_at ?? pull.closed_at ?? null : state === 'closed' ? pull.closed_at ?? null : null,
  }
}

/**
 * Build a viewer list entry from the pieces of one read.
 * @param parts - the pull request, its head status, reviews, and closing issues.
 * @param viewer - login of the signed-in user.
 * @returns the entry.
 */
export function summaryOf(
  parts: Pick<StatusParts, 'ref' | 'pull' | 'branch' | 'combined' | 'reviews' | 'closingIssues' | 'closingIssuesTruncated'>, viewer: string,
): ChangeRequestSummary {
  const { ref, pull } = parts
  const host = ref.repository.host
  const verdicts = verdictsOf(parts.reviews, host)
  const mine = [...verdicts].find(([login]) => login.toLowerCase() === viewer.toLowerCase())?.[1]
  return {
    ref,
    url: pull.html_url,
    title: pull.title,
    draft: pull.draft,
    author: pull.user === null ? null : { login: pull.user.login, avatarUrl: absoluteUrl(host, pull.user.avatar_url), bot: pull.user.type === 'bot' },
    headSha: pull.head.sha,
    checksRollup: rollupOf(parts.combined),
    reviewDecision: decisionOf(verdicts, parts.branch?.required_approvals ?? 0),
    viewerReview: mine === undefined ? null : { verdict: mine.verdict, reviewedSha: mine.sha },
    viewerRequest: (pull.requested_reviewers ?? []).some(user => user.login.toLowerCase() === viewer.toLowerCase()) ? { team: null } : null,
    closingIssues: parts.closingIssues,
    closingIssuesTruncated: parts.closingIssuesTruncated,
    updatedAt: pull.updated_at,
  }
}
