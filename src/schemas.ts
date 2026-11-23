/** The parts of Forgejo's REST answers the provider reads, validated where they enter. */

import { z } from 'zod'

/** An account as Forgejo reports it. */
export const userSchema = z.object({
  login: z.string(),
  avatar_url: z.string().nullish(),
  /** `bot` accounts are Forgejo's marker for a non-person; its API names no such field, so this stays optional. */
  type: z.string().nullish(),
})
/** A validated account. */
export type UserNode = z.infer<typeof userSchema>

const branchInfo = z.object({ ref: z.string(), sha: z.string() })

/** A pull request: its branches, state, requested reviewers, labels, and times. */
export const pullSchema = z.object({
  number: z.number(),
  html_url: z.string(),
  title: z.string(),
  body: z.string().nullish(),
  state: z.string(),
  draft: z.boolean(),
  merged: z.boolean(),
  mergeable: z.boolean(),
  user: userSchema.nullable(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
  head: branchInfo.extend({ repo_id: z.number().nullish(), repo: z.object({ full_name: z.string() }).nullish() }),
  base: branchInfo.extend({ repo: z.object({ full_name: z.string() }).nullish() }),
  merge_base: z.string().nullish(),
  requested_reviewers: z.array(userSchema).nullish(),
  requested_reviewers_teams: z.array(z.object({ name: z.string(), organization: z.object({ username: z.string() }).nullish() })).nullish(),
  labels: z.array(z.object({ name: z.string(), color: z.string().nullish() })).nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullish(),
  merged_at: z.string().nullish(),
})
/** A validated pull request. */
export type PullNode = z.infer<typeof pullSchema>

/** A repository: the signed-in user's permissions and the merge and update methods it enables. */
export const repoSchema = z.object({
  default_branch: z.string(),
  permissions: z.object({ admin: z.boolean(), push: z.boolean(), pull: z.boolean() }).nullish(),
  allow_merge_commits: z.boolean().nullish(),
  allow_rebase: z.boolean().nullish(),
  allow_rebase_explicit: z.boolean().nullish(),
  allow_squash_merge: z.boolean().nullish(),
  default_merge_style: z.string().nullish(),
  default_update_style: z.string().nullish(),
  allow_rebase_update: z.boolean().nullish(),
})
/** A validated repository. */
export type RepoNode = z.infer<typeof repoSchema>

/** A branch's protection summary for the signed-in user. */
export const branchSchema = z.object({
  required_approvals: z.number().nullish(),
  enable_status_check: z.boolean().nullish(),
  user_can_merge: z.boolean().nullish(),
})
/** A validated branch. */
export type BranchNode = z.infer<typeof branchSchema>

/** The latest commit status of each context of a commit, with their combined state. */
export const combinedStatusSchema = z.object({
  state: z.string(),
  total_count: z.number(),
  statuses: z.array(z.object({
    context: z.string(),
    status: z.string(),
    target_url: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })).nullish().transform(statuses => statuses ?? []),
})

/** The Actions runs of a commit. */
export const runsSchema = z.object({
  workflow_runs: z.array(z.object({
    id: z.number(),
    index_in_repo: z.number(),
    workflow_id: z.string().nullish(),
    status: z.string(),
    started: z.string().nullish(),
    stopped: z.string().nullish(),
    html_url: z.string().nullish(),
  })),
})
/** One validated Actions run. */
export type RunNode = z.infer<typeof runsSchema>['workflow_runs'][number]

/** A review of a pull request; the listing holds only the signed-in user's pending review. */
export const reviewSchema = z.object({
  id: z.number(),
  user: userSchema.nullable(),
  state: z.string(),
  body: z.string().nullish(),
  commit_id: z.string().nullish(),
  dismissed: z.boolean().nullish(),
  comments_count: z.number().nullish(),
  html_url: z.string().nullish(),
  submitted_at: z.string().nullish(),
})
/** A validated review. */
export type ReviewNode = z.infer<typeof reviewSchema>

/** A review comment: `position` numbers a new-side line, `original_position` an old-side line, both 0 for a file comment. */
export const reviewCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  user: userSchema.nullable(),
  resolver: userSchema.nullish(),
  pull_request_review_id: z.number(),
  created_at: z.string(),
  path: z.string(),
  commit_id: z.string().nullish(),
  diff_hunk: z.string().nullish(),
  position: z.number(),
  original_position: z.number(),
  extra_lines_count: z.number().nullish(),
  html_url: z.string().nullish(),
})
/** A validated review comment. */
export type ReviewCommentNode = z.infer<typeof reviewCommentSchema>

/** A commit of a pull request. */
export const commitSchema = z.object({
  sha: z.string(),
  parents: z.array(z.object({ sha: z.string() })).nullish(),
  commit: z.object({ message: z.string(), author: z.object({ name: z.string().nullish(), date: z.string() }).nullish() }),
  author: z.object({ login: z.string() }).nullish(),
})
/** A validated commit. */
export type CommitNode = z.infer<typeof commitSchema>

/** An issue a pull request description names. */
export const issueSchema = z.object({ number: z.number(), title: z.string(), state: z.string(), html_url: z.string() })
