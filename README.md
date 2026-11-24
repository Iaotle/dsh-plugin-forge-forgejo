# dsh-plugin-forge-forgejo

## Summary

Read and write Forgejo (and Gitea-compatible) pull requests for `ctx.forge` through the host's REST API with one access token. Each poll reads state, changed lines, commit statuses and Actions runs as checks, reviewers and reviews, mergeability, unresolved review conversations, and the issues the description closes; the changes view reads the pull request diff pinned to the head, the commits, and the review threads. It writes comments and reviews, replies, edits and deletes comments, keeps a pending review, marks drafts ready, merges, reruns Actions runs, requests reviews, and updates the head branch.

## Install

Requires DeepSeek Harness 0.2.3-alpha.1 or later with the "Change requests & worktrees" (forge) bundle enabled.

```sh
dsh plugin --profile <name> add dsh-plugin-forge-forgejo          # from npm
dsh plugin --profile <name> add github:Iaotle/dsh-plugin-forge-forgejo#<sha>   # from git (needs allowBuilds, see below)
```

Installing adds the `forge-forgejo` row **disabled**. Enable it and name your hosts in the profile's `cordis.patch.yml`:

```yaml
- id: forge-forgejo
  disabled: false
  config:
    hosts: [git.example.com]
```

Store an access token (scopes `read:user`, `write:repository`, `write:issue`) as the `FORGEJO_TOKEN` credential; see the configuration below.
A git install runs `prepare` to build `lib/`; pnpm requires `allowBuilds: { dsh-plugin-forge-forgejo: true }` in the profile's `pnpm-workspace.yaml`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider after the forge registry and list every Forgejo host explicitly; there is no default host. The Forge bundle does not mount it.

```yaml
- name: '@deepseek-ai/dsh-experimental-forge'
- name: '@deepseek-ai/dsh-forge-forgejo'
  config:
    hosts: [git.example.com]
    tokenEnv: FORGEJO_TOKEN
```

The access token is the credential named by `tokenEnv` (default `FORGEJO_TOKEN`), read from the credential store at every request, so rotating it needs no restart. Create it under the host's `Settings → Applications` with `read:user`, `write:repository`, and `write:issue`; a token without a write scope still serves the read side. Requests use HTTPS only. Numeric limits must be positive safe integers; `hosts`, `tokenEnv`, `timeoutMs`, `maxResponseBytes`, `maxReviewThreads`, `maxCommits`, and `maxConcurrentRequests` are the settings.

The provider names itself `Forgejo` and calls change requests pull requests. It serves `https`, `ssh`, and `git` remotes and scp-style remotes, and pull request URLs of the form `https://<host>/<owner>/<name>/pulls/<number>`; `fileUrl` returns `https://<host>/<owner>/<name>/src/commit/<commit>/<path>`. A readiness probe reads `user`: success is `ready`, a missing or refused token is `unauthenticated`, and anything else is `unavailable`. A head lookup lists up to 200 open pull requests whose head branch is the branch and whose head repository is the base repository.

A fetch reads the pull request, repository, and base branch rules, the combined commit status of the head, the Actions runs of the head commit, the reviews and their comments, and the issues the description closes, and runs at most `maxConcurrentRequests` pull requests at once. Mergeability is Forgejo's `mergeable` flag. A pull request is ready to merge when it is open, not a draft, mergeable, the user may merge into the base branch, no reviewer requests changes, the branch's required approvals are met, and its required status checks pass. Merge methods are the repository's enabled `merge`, `rebase`, and `squash` with its default first. Checks are the latest commit status of each context: Forgejo Actions reports each job as a status named `<workflow> / <job> (<event>)`, whose target names the run, and a status whose run is listed carries that run's id as its `rerun`. The review decision is `changes-requested` when a reviewer's latest deciding review requests changes, `approved` once the base branch's required approvals (or any one when it requires none) are met, and `review-required` otherwise when approvals are required. Closing issues are the numbers named by `closes`, `fixes`, or `resolves` keywords (and their inflections) in the description, read again only when the pull request's update time changes. `branchUpdates` offers `merge` and `rebase` while the head is behind its base, the branches do not conflict, the head is in the same repository, and the user may push.

`diff` reads `pulls/<n>.diff` once the head is the requested commit, else `stale`. `commits` lists the commits oldest first. `compare` builds the patch from the files that `compare` lists and their text at both commits, because Forgejo's API returns no patch for a range. `fileText` reads `raw/<path>?ref=<commit>`.

`readReview` reads every review's comments. Forgejo keeps no thread object, so a thread is the comments that share a path, side, and line. A comment on the new side is on the head when the commit it was written on is the head, and is outdated otherwise; its original position keeps that commit. A comment on the old side numbers the old file and is read as current. The signed-in user's pending review is the one in state `PENDING`, and its comments are marked pending. A multi-line comment is a comment on its last line spanning the lines above it. A thread is resolved when its first comment has a resolver.

`submitReview` publishes a comment or a review as one Forgejo review on the confirmed head. Replies without `pending` are published as one-comment reviews, `pending` replies and comments join the pending review, which is started when there is none and deleted again when its first comment is rejected (the write is then `failed`, whatever Forgejo answered), and `submit-pending` and `discard-pending` submit or delete it. Edits and deletions use the comment's id. `merge` posts the merge with `head_commit_id` set to the confirmed head, which Forgejo refuses with HTTP 409, or with 405 "Please try again later" after repeated attempts, and which is reported as `stale` when the head moved and as `failed` otherwise. `markReady` removes the `WIP:` or `[WIP]` prefix from the title, which is how Forgejo marks a draft. `rerunChecks` reruns each distinct run of the failed checks once no check is pending. `requestReviews` adds review requests; `reviewerCandidates` lists the repository's reviewers that match, never the author. `listForViewer` and `countForViewer` read the signed-in user's open pull requests as the `review-requested`, `authored`, and `involved` lists, at most `maxViewerItems` per list. `updateBranch` posts `pulls/<n>/update` after reading that the head is the confirmed one. Failure messages never contain the access token, which Forgejo echoes in some 401 answers. Writes are never retried: a 4xx answer is `failed`, HTTP 401 is `unauthenticated`, and a 5xx answer or a request that may have reached the host is `unknown`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Configuration validation and provider registration |
| [`src/provider.ts`](src/provider.ts) | URL mapping, reads, closing issue cache, and actions |
| [`src/api.ts`](src/api.ts) | Authenticated HTTPS requests, pagination, and failure mapping |
| [`src/schemas.ts`](src/schemas.ts) | The parts of Forgejo's answers the provider reads |
| [`src/viewer.ts`](src/viewer.ts) | Issue search behind the viewer lists |
| [`src/status.ts`](src/status.ts) | Snapshot mapping: checks, reviewers, decision, and merge rules |
| [`src/review.ts`](src/review.ts) | Review comments grouped into threads |
| [`src/writes.ts`](src/writes.ts) | Review submissions, replies, and the pending review |
| [`src/patch.ts`](src/patch.ts) | Unified patches from two texts |
| [`src/pool.ts`](src/pool.ts) | Bounded concurrency |
| [`src/urls.ts`](src/urls.ts) | Remote and pull request URL parsing, and path validation |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Forge registry](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/experimental/forge) — provider registration and shared polling.
- [Forge subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/forge.md) — provider contract and change request types.
- [GitLab provider](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/experimental/forge-gitlab) — the provider this one follows.

-----

<a id="model-experience"></a>
## Model Experience

None, as the provider reads and writes pull requests for host-side watchers and the panel without contributing model context.

#### KV Cache effect

None. Provider output reaches only host-side watchers.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Review reads** — a read lists at most 200 reviews, oldest first, and 1,000 comments per review; approvals count toward the decision whether or not Forgejo counts the reviewer as official or the review as stale.
- **Resolving conversations** — Forgejo's API has no way to resolve or unresolve a conversation, so `resolve` writes are `unsupported` and `viewerCanResolve` is always false. Conversations resolved on the web page are read as resolved.
- **Draft marker** — Forgejo has no draft flag in its API; a draft is a title prefix, which `markReady` removes. A pull request becomes a draft again only by editing its title on the host.
- **Reruns** — Forgejo reruns a whole Actions run, so the passing jobs of a failed run run again. A commit status that no Actions run produced has no `rerun`.
- **Check history** — the push and pull request runs of one commit both report their statuses, so a job can appear twice with different events in its name.
- **Mergeability while computing** — Forgejo reports `mergeable: false` while it recomputes after a push to the base branch, so a pull request can read `conflicting` until the next poll.
- **Merge methods** — `rebase-merge` and `fast-forward-only` have no neutral name and are not offered.
- **Closing issues** — Forgejo has no closing-issue read; the provider reads the keywords in the description only, not those in commit messages, and only issues of the same repository.
- **Teams** — team reviewers are requested by their slug within the host's organization; their review state is not tracked.
- **Viewer lists** — the lists come from Forgejo's issue search (`created`, `review_requested`, and `mentioned`, `assigned`, or `reviewed` for `involved`), which reads at most 200 results per search. Each listed pull request then costs four requests; one whose status cannot be read stays in the list with its title and no checks or review decision, and opening it reports the failure. Lists, reviews, and comments are read page by page until the host's `X-Total-Count`, so a host that serves fewer than 50 items per page loses nothing. The `review-requested` list holds requests that name the user, not the user's teams, so `viewerRequest.team` is always null. The `involved` total counts the pull requests that search found.
- **No viewed marks or merge base** — the provider declares no `viewedFiles` or `mergeBase`.
- **No session commands** — forge-session binds pull requests to a Session from commands of a code host's CLI; no Forgejo command rule is registered, so only pull requests the Session's branch resolves through `findByHead` bind.
- **Rate limits** — every poll costs about eight requests per pull request plus one per review with comments and per closing issue.

<a id="dev-note"></a>
## Contributing

Anyone is welcome to contribute: open an issue, start a discussion, or send a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).

See also [@dungsil/dsh-plugin-forge-forgejo](https://www.npmjs.com/package/@dungsil/dsh-plugin-forge-forgejo), another Forgejo provider for DSH, which works through the `tea` CLI.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
