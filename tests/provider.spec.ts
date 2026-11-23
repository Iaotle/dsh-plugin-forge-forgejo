import { ForgejoApi } from '../src/api.ts'
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type { ForgeFailure, ForgeReviewData, ForgeThreadId } from '@deepseek-ai/dsh-experimental-forge'
import { describe, expect, it } from 'vitest'
import { BASE, fakeHost, HEAD, HOST, OLD, pull, ref, repo, repository, user } from './fake.ts'

const signal = new AbortController().signal

const combined = {
  state: 'failure', total_count: 2, statuses: [
    { context: 'ci / build (pull_request)', status: 'success', target_url: '/owner/app/actions/runs/4/jobs/0', created_at: 't0', updated_at: 't1' },
    { context: '/ second (pull_request)', status: 'failure', target_url: '/owner/app/actions/runs/4/jobs/1', created_at: 't0', updated_at: 't1' },
  ],
}
const runs = { workflow_runs: [{ id: 900, index_in_repo: 4, workflow_id: 'ci.yml', status: 'failure', started: 's', stopped: 'e' }] }

const review = (id: number, login: string, state: string, comments = 0, extra: Record<string, unknown> = {}) => ({
  id, user: user(login), state, comments_count: comments, commit_id: HEAD, submitted_at: `2026-01-0${id}T00:00:00Z`, ...extra,
})
const comment = (id: number, reviewId: number, over: Record<string, unknown> = {}) => ({
  id, body: `comment ${id}`, user: user('bob'), resolver: null, pull_request_review_id: reviewId, created_at: `2026-01-0${id}T00:00:00Z`,
  path: 'app.txt', commit_id: HEAD, diff_hunk: '@@ -1 +1 @@', position: 2, original_position: 0, extra_lines_count: 0, ...over,
})

function routes(over: Parameters<typeof fakeHost>[0] = {}): Parameters<typeof fakeHost>[0] {
  return {
    'GET user': { body: user('carol') },
    'GET repos/owner/app': { body: repo },
    'GET repos/owner/app/pulls/7': { body: pull() },
    'GET repos/owner/app/branches/main': { body: { required_approvals: 1, enable_status_check: true, user_can_merge: true } },
    [`GET repos/owner/app/commits/${HEAD}/status`]: { body: combined },
    'GET repos/owner/app/actions/runs': { body: runs },
    'GET repos/owner/app/pulls/7/reviews': { body: [
      review(1, 'bob', 'COMMENT', 2), review(2, 'dave', 'REQUEST_CHANGES'), review(3, 'dave', 'APPROVED'), review(4, 'carol', 'PENDING', 1),
    ] },
    'GET repos/owner/app/pulls/7/reviews/1/comments': { body: [
      comment(10, 1), comment(11, 1, { position: 0, original_position: 4, commit_id: BASE }),
      comment(12, 1, { position: 3, commit_id: OLD }),
    ] },
    'GET repos/owner/app/pulls/7/reviews/4/comments': { body: [comment(13, 4, { body: 'draft', user: user('carol'), commit_id: BASE })] },
    'GET repos/owner/app/issues/3': { body: { number: 3, title: 'Bug', state: 'open', html_url: 'https://x/3' } },
    'GET repos/owner/app/issues/99': { status: 404, body: { message: 'gone' } },
    ...over,
  }
}

describe('ForgejoProvider status', () => {
  it('reads a snapshot with checks, reviewers, threads and closing issues', async () => {
    const { provider } = fakeHost(routes())
    const result = await provider.fetch([ref], signal)
    const snapshot = result.get(changeRequestKey(ref))
    expect(snapshot).toMatchObject({
      title: 'Change app', state: 'open', author: 'alice', headSha: HEAD, baseBranch: 'main', mergeability: 'mergeable',
      mergeMethods: ['squash', 'merge', 'rebase'], checksRollup: 'failure', canRerunChecks: true, canRequestReviews: true,
      reviewDecision: 'approved', unresolvedThreads: 3, branchUpdates: [],
    })
    expect(snapshot).toMatchObject({
      checks: [
        { name: 'build (pull_request)', workflow: 'ci', state: 'success', rerun: '900', url: `https://${HOST}/owner/app/actions/runs/4/jobs/0` },
        { name: 'second (pull_request)', workflow: 'ci.yml', state: 'failure', rerun: '900' },
      ],
      reviewers: [
        { login: 'bob', requested: true, verdict: 'commented' },
        { login: 'dave', requested: false, verdict: 'approved' },
      ],
      closingIssues: [{ number: 3, title: 'Bug', state: 'open' }],
      closingIssuesTruncated: false,
    })
  })

  it('treats the pending review as no one else\'s thread and reports an outdated one', async () => {
    const { provider } = fakeHost(routes())
    const data = await provider.readReview(ref, HEAD, signal) as ForgeReviewData
    expect(data.viewer).toBe('carol')
    expect(data.pendingReview).toEqual({ id: '4', comments: 1 })
    expect(data.viewerCanReview).toBe(true)
    expect(data.reviewEvents).toEqual(['comment', 'approve', 'request-changes'])
    const shape = data.threads.map(thread => [
      thread.side, thread.current?.endLine ?? null, thread.original?.commit, thread.comments.length, thread.viewerCanResolve,
    ])
    expect(shape)
      .toEqual([['R', 2, HEAD, 2, false], ['L', 4, HEAD, 1, false], ['R', null, OLD, 1, false]])
    const draft = data.threads[0]?.comments.at(-1)
    expect(draft).toMatchObject({ body: 'draft', pending: true, viewerCanEdit: true, viewerCanDelete: true })
  })

  it('refuses a review read at a head that moved', async () => {
    const { provider } = fakeHost(routes())
    expect(await provider.readReview(ref, 'f'.repeat(40), signal)).toMatchObject({ code: 'stale' })
  })

  it('reads a commit without any status, which Forgejo answers with null statuses, as no checks', async () => {
    const { provider } = fakeHost(routes({
      [`GET repos/owner/app/commits/${HEAD}/status`]: { body: { state: '', total_count: 0, statuses: null } },
    }))
    expect(await provider.fetchChecks(ref, signal)).toMatchObject({ checks: [], checksRollup: 'none' })
  })

  it('offers branch updates when the head is behind and writable', async () => {
    const { provider } = fakeHost(routes({ 'GET repos/owner/app/pulls/7': { body: pull({ merge_base: OLD }) } }))
    const snapshot = await provider.fetchChecks(ref, signal)
    expect(snapshot).toMatchObject({ branchUpdates: ['merge', 'rebase'] })
  })

  it('reports a missing token as unauthenticated and a rejected one by status', async () => {
    const none = fakeHost(routes(), null)
    expect(await none.provider.readiness(HOST, signal)).toMatchObject({ state: 'unauthenticated' })
    const rejected = fakeHost({ 'GET user': { status: 401, body: { message: 'bad token' } } })
    expect(await rejected.provider.readiness(HOST, signal)).toEqual({ state: 'unauthenticated', message: 'bad token', signIn: null })
    expect(await rejected.provider.readiness('other.test', signal)).toMatchObject({ state: 'unavailable' })
  })

  it('never repeats the access token in a failure message', async () => {
    const token = 'tok-123'
    const echoed = fakeHost({ 'GET user': { status: 401, body: { message: `access token does not exist [sha: ${token}]`, errors: [`task with token "${token}"`] } } }, token)
    const readiness = await echoed.provider.readiness(HOST, signal)
    expect(JSON.stringify(readiness)).not.toContain(token)
    expect(readiness).toMatchObject({ state: 'unauthenticated' })
    const padded = ' tok-456\r\n'
    const api = new ForgejoApi(async () => padded, { timeoutMs: 1_000, maxResponseBytes: 1_000 }, (async () => {
      throw new TypeError(`Headers.append: "token ${padded}" is an invalid header value`)
    }) as typeof fetch)
    const failed = await api.get(HOST, 'user', signal)
    expect(failed).toMatchObject({ ok: false })
    expect(JSON.stringify(failed)).not.toContain('tok-456')
  })

  it('finds open pull requests by head branch but not from forks or the default branch', async () => {
    const { provider } = fakeHost({
      'GET repos/owner/app': { body: repo },
      'GET repos/owner/app/pulls': { body: [pull(), pull({ number: 8, head: { ref: 'feature', sha: HEAD, repo: { full_name: 'fork/app' } } })] },
    })
    expect(await provider.findByHead(repository, 'feature', signal)).toEqual([ref])
    expect(await provider.findByHead(repository, 'main', signal)).toEqual([])
  })
})

describe('ForgejoProvider writes', () => {
  it('merges with the confirmed head and maps a moved head to stale', async () => {
    const ok = fakeHost(routes({ 'POST repos/owner/app/pulls/7/merge': { status: 200 } }))
    expect(await ok.provider.merge(ref, { method: 'squash', headSha: HEAD }, signal)).toBeUndefined()
    expect(ok.calls.at(-1)?.body).toEqual({ Do: 'squash', head_commit_id: HEAD })
    const conflict = fakeHost(routes({ 'POST repos/owner/app/pulls/7/merge': { status: 409, body: { message: 'conflict' } } }))
    expect(await conflict.provider.merge(ref, { method: 'merge', headSha: HEAD }, signal)).toEqual({ code: 'failed', message: 'conflict' })
    const stale = fakeHost(routes({
      'POST repos/owner/app/pulls/7/merge': { status: 409, body: { message: 'head out of date' } },
      'GET repos/owner/app/pulls/7': { body: pull({ head: { ref: 'feature', sha: BASE } }) },
    }))
    expect(await stale.provider.merge(ref, { method: 'merge', headSha: HEAD }, signal)).toEqual({ code: 'stale', message: 'head out of date' })
    const busy = fakeHost(routes({
      'POST repos/owner/app/pulls/7/merge': { status: 405, body: { message: 'Please try again later' } },
      'GET repos/owner/app/pulls/7': { body: pull({ head: { ref: 'feature', sha: BASE } }) },
    }))
    expect(await busy.provider.merge(ref, { method: 'merge', headSha: HEAD }, signal)).toEqual({ code: 'stale', message: 'Please try again later' })
    await expect(ok.provider.merge(ref, { method: 'merge', headSha: 'short' }, signal)).rejects.toThrow('invalid head commit')
  })

  it('marks a draft ready by dropping the WIP prefix', async () => {
    const { provider, calls } = fakeHost(routes({
      'GET repos/owner/app/pulls/7': { body: pull({ draft: true, title: 'WIP: Change app' }) },
      'PATCH repos/owner/app/pulls/7': { status: 201 },
    }))
    expect(await provider.markReady(ref, signal)).toBeUndefined()
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { title: 'Change app' } })
  })

  it('reruns each failed run once, and refuses while a check is pending or the head moved', async () => {
    const rerun = fakeHost(routes({ 'POST repos/owner/app/actions/runs/900/rerun': { status: 204 } }))
    expect(await rerun.provider.rerunChecks(ref, { headSha: HEAD }, signal)).toBeUndefined()
    expect(rerun.calls.filter(call => call.path.endsWith('/rerun'))).toHaveLength(1)
    expect(await rerun.provider.rerunChecks(ref, { headSha: BASE }, signal)).toMatchObject({ code: 'stale' })
    const pending = fakeHost(routes({
      [`GET repos/owner/app/commits/${HEAD}/status`]: { body: { ...combined, statuses: [{ ...combined.statuses[1], status: 'pending' }] } },
    }))
    expect(await pending.provider.rerunChecks(ref, { headSha: HEAD }, signal)).toEqual({ code: 'failed', message: 'checks are still running' })
  })

  it('publishes a review with inline comments on the confirmed head', async () => {
    const { provider, calls } = fakeHost(routes({
      'POST repos/owner/app/pulls/7/reviews': { status: 200, body: review(5, 'carol', 'COMMENT', 1, { html_url: 'https://x/review' }) },
    }))
    const result = await provider.submitReview(ref, {
      headSha: HEAD, kind: 'review', event: 'request-changes', body: 'please fix',
      comments: [{ path: 'app.txt', side: 'R', startLine: 2, endLine: 4, body: 'here' }, { path: 'app.txt', side: 'L', startLine: 1, endLine: 1, body: 'there' }],
    }, signal)
    expect(result).toEqual({ ok: true, url: 'https://x/review' })
    expect(calls.at(-1)?.body).toEqual({
      commit_id: HEAD, event: 'REQUEST_CHANGES', body: 'please fix',
      comments: [{ path: 'app.txt', body: 'here', new_position: 4, extra_lines_count: 2 }, { path: 'app.txt', body: 'there', old_position: 1 }],
    })
    const moved = fakeHost(routes({ 'GET repos/owner/app/pulls/7': { body: pull({ head: { ref: 'feature', sha: BASE } }) } }))
    expect(await moved.provider.submitReview(ref, { headSha: HEAD, kind: 'comment', comment: { path: 'a', side: 'R', startLine: 1, endLine: 1, body: 'x' } }, signal))
      .toMatchObject({ ok: false, code: 'stale' })
  })

  it('removes the pending review it started when the comment is rejected, and keeps one that already existed', async () => {
    const add = { headSha: HEAD, kind: 'add-pending', comment: { path: 'app.txt', side: 'R', startLine: 1, endLine: 1, body: 'n' } } as const
    const fresh = fakeHost(routes({
      'GET repos/owner/app/pulls/7/reviews': { body: [] },
      'POST repos/owner/app/pulls/7/reviews': { status: 200, body: review(9, 'carol', 'PENDING', 0) },
      'POST repos/owner/app/pulls/7/reviews/9/comments': { status: 422, body: { message: 'bad line' } },
      'DELETE repos/owner/app/pulls/7/reviews/9': { status: 204 },
    }))
    expect(await fresh.provider.writeReview(ref, add, signal)).toMatchObject({ ok: false, message: 'bad line' })
    expect(fresh.calls.at(-1)).toMatchObject({ method: 'DELETE', path: 'repos/owner/app/pulls/7/reviews/9' })
    const kept = fakeHost(routes({ 'POST repos/owner/app/pulls/7/reviews/4/comments': { status: 422, body: { message: 'bad line' } } }))
    expect(await kept.provider.writeReview(ref, add, signal)).toMatchObject({ ok: false })
    expect(kept.calls.some(call => call.method === 'DELETE')).toBe(false)
  })

  it('reports a rejected comment as failed once the review started for it is deleted, even when Forgejo answered 500', async () => {
    const add = { headSha: HEAD, kind: 'add-pending', comment: { path: 'app.txt', side: 'R', startLine: 1, endLine: 1, body: 'n' } } as const
    const base = {
      'GET repos/owner/app/pulls/7/reviews': { body: [] },
      'POST repos/owner/app/pulls/7/reviews': { status: 200, body: review(9, 'carol', 'PENDING', 0) },
      'POST repos/owner/app/pulls/7/reviews/9/comments': { status: 500, body: { message: 'boom' } },
    }
    const removed = fakeHost(routes({ ...base, 'DELETE repos/owner/app/pulls/7/reviews/9': { status: 204 } }))
    expect(await removed.provider.writeReview(ref, add, signal)).toEqual({ ok: false, code: 'failed', message: 'boom' })
    const kept = fakeHost(routes({ ...base, 'DELETE repos/owner/app/pulls/7/reviews/9': { status: 500, body: { message: 'x' } } }))
    expect(await kept.provider.writeReview(ref, add, signal)).toMatchObject({ ok: false, code: 'unknown' })
  })

  it('writes to threads, the pending review and comments', async () => {
    const answer = { status: 200, body: review(4, 'carol', 'PENDING', 1) }
    const { provider, calls } = fakeHost(routes({
      'POST repos/owner/app/pulls/7/reviews': answer,
      'POST repos/owner/app/pulls/7/reviews/4/comments': { status: 200, body: comment(14, 4) },
      'POST repos/owner/app/pulls/7/reviews/4': { status: 200, body: answer.body },
      'DELETE repos/owner/app/pulls/7/reviews/4': { status: 204 },
      'PATCH repos/owner/app/issues/comments/10': { status: 200, body: comment(10, 1) },
      'DELETE repos/owner/app/issues/comments/10': { status: 204 },
    }))
    const read = await provider.readReview(ref, HEAD, signal) as ForgeReviewData
    const thread = read.threads[0]?.id as ForgeThreadId
    expect(await provider.writeReview(ref, { headSha: HEAD, kind: 'reply', thread, body: 'reply', pending: true }, signal)).toEqual({ ok: true })
    expect(calls.at(-1)).toMatchObject({ path: 'repos/owner/app/pulls/7/reviews/4/comments', body: { path: 'app.txt', body: 'reply', new_position: 2 } })
    expect(await provider.writeReview(ref, { headSha: HEAD, kind: 'reply', thread, body: 'now', pending: false }, signal)).toEqual({ ok: true })
    expect(calls.at(-1)?.body).toMatchObject({ event: 'COMMENT', comments: [{ body: 'now', new_position: 2 }] })
    expect(await provider.writeReview(ref, { headSha: HEAD, kind: 'add-pending', comment: { path: 'app.txt', side: 'R', startLine: 1, endLine: 1, body: 'n' } }, signal)).toEqual({ ok: true })
    expect(await provider.writeReview(ref, { headSha: HEAD, kind: 'submit-pending', review: '4' as never, event: 'approve', body: 'ok' }, signal)).toEqual({ ok: true })
    expect(calls.at(-1)?.body).toEqual({ event: 'APPROVED', body: 'ok' })
    expect(await provider.writeReview(ref, { headSha: HEAD, kind: 'discard-pending', review: '4' as never }, signal)).toEqual({ ok: true })
    expect(await provider.writeReview(ref, { headSha: HEAD, kind: 'edit-comment', comment: '10' as never, body: 'e' }, signal)).toEqual({ ok: true })
    expect(await provider.writeReview(ref, { headSha: HEAD, kind: 'delete-comment', comment: '10' as never }, signal)).toEqual({ ok: true })
    expect(await provider.writeReview(ref, { headSha: HEAD, kind: 'resolve', thread, resolved: true }, signal))
      .toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('requests reviews and lists candidates without the author', async () => {
    const { provider, calls } = fakeHost(routes({
      'GET repos/owner/app/reviewers': { body: [user('alice'), { ...user('bob'), full_name: 'Bob B' }, user('erin')] },
      'POST repos/owner/app/pulls/7/requested_reviewers': { status: 201 },
    }))
    expect(await provider.reviewerCandidates(ref, 'b', signal)).toEqual([
      { login: 'bob', name: 'Bob B', avatarUrl: `https://${HOST}/avatars/bob`, suggested: false },
    ])
    expect(await provider.requestReviews(ref, { reviewers: [{ kind: 'user', login: 'bob' }, { kind: 'team', login: 'org/core' }] }, signal)).toBeUndefined()
    expect(calls.at(-1)?.body).toEqual({ reviewers: ['bob'], team_reviewers: ['core'] })
  })

  it('updates a branch only while its head is the confirmed one', async () => {
    const { provider, calls } = fakeHost(routes({ 'POST repos/owner/app/pulls/7/update': { status: 200 } }))
    expect(await provider.updateBranch(ref, { method: 'rebase', headSha: HEAD }, signal)).toBeUndefined()
    expect(calls.at(-1)?.path).toBe('repos/owner/app/pulls/7/update?style=rebase')
    expect(await provider.updateBranch(ref, { method: 'merge', headSha: BASE }, signal)).toMatchObject({ code: 'stale' })
  })
})

describe('ForgejoProvider failures', () => {
  it('reports a write whose answer cannot be read as unknown, and one that was refused as failed', async () => {
    const garbled = fakeHost(routes({ 'POST repos/owner/app/pulls/7/update': { status: 200, text: '<html>' } }))
    expect(await garbled.provider.updateBranch(ref, { method: 'merge', headSha: HEAD }, signal)).toMatchObject({ code: 'unknown' })
    const refused = fakeHost(routes({ 'POST repos/owner/app/pulls/7/update': { status: 422, body: { message: 'no' } } }))
    expect(await refused.provider.updateBranch(ref, { method: 'merge', headSha: HEAD }, signal)).toEqual({ code: 'failed', message: 'no' })
  })

  it('refuses a file path that would leave the repository', async () => {
    const { provider, calls } = fakeHost(routes())
    await expect(provider.fileText(ref, HEAD, '../../../user', signal)).rejects.toThrow('invalid repository path')
    expect(calls).toHaveLength(0)
  })

  it('refuses writes that name an id Forgejo did not give or an outdated thread', async () => {
    const { provider } = fakeHost(routes())
    const bad = await provider.writeReview(ref, { headSha: HEAD, kind: 'delete-comment', comment: '../1' as never }, signal)
    expect(bad).toMatchObject({ ok: false, code: 'failed' })
    const read = await provider.readReview(ref, HEAD, signal) as ForgeReviewData
    const outdated = read.threads.find(thread => thread.current === null)?.id as ForgeThreadId
    expect(await provider.writeReview(ref, { headSha: HEAD, kind: 'reply', thread: outdated, body: 'x', pending: false }, signal))
      .toMatchObject({ ok: false, code: 'failed' })
  })

  it('reports a partly started rerun as unknown', async () => {
    const two = { ...combined, statuses: [
      { ...combined.statuses[1], target_url: '/owner/app/actions/runs/4/jobs/1' },
      { ...combined.statuses[1], context: '/ other (push)', target_url: '/owner/app/actions/runs/5/jobs/0' },
    ] }
    const { provider } = fakeHost(routes({
      [`GET repos/owner/app/commits/${HEAD}/status`]: { body: two },
      'GET repos/owner/app/actions/runs': { body: { workflow_runs: [...runs.workflow_runs, { ...runs.workflow_runs[0], id: 901, index_in_repo: 5 }] } },
      'POST repos/owner/app/actions/runs/900/rerun': { status: 204 },
      'POST repos/owner/app/actions/runs/901/rerun': { status: 500, body: { message: 'boom' } },
    }))
    expect(await provider.rerunChecks(ref, { headSha: HEAD }, signal)).toMatchObject({ code: 'unknown' })
  })
})

describe('ForgejoProvider content', () => {
  it('reads the diff at the head, file text, commits oldest first and compares by file text', async () => {
    const { provider } = fakeHost(routes({
      'GET repos/owner/app/pulls/7.diff': { text: 'diff --git a/x b/x\n' },
      'GET repos/owner/app/raw/dir/app.txt': call => ({ text: call.path.includes(`ref=${BASE}`) ? 'one\ntwo\n' : 'one\nTWO\n' }),
      'GET repos/owner/app/pulls/7/commits': { body: [
        { sha: HEAD, parents: [{ sha: OLD }], commit: { message: 'second\n\nbody', author: { name: 'A', date: 'd2' } }, author: { login: 'alice' } },
        { sha: OLD, parents: [{ sha: BASE }], commit: { message: 'first', author: { name: 'A', date: 'd1' } } },
      ] },
      [`GET repos/owner/app/compare/${BASE}...${HEAD}`]: { body: { files: [{ filename: 'dir/app.txt', status: 'modified' }] } },
    }))
    expect(await provider.diff(ref, HEAD, signal)).toBe('diff --git a/x b/x\n')
    expect(await provider.diff(ref, BASE, signal)).toMatchObject({ code: 'stale' })
    expect(await provider.fileText(ref, HEAD, 'dir/app.txt', signal)).toBe('one\nTWO\n')
    expect(await provider.commits(ref, signal)).toEqual({
      headSha: HEAD, truncated: false, commits: [
        { sha: OLD, parent: BASE, title: 'first', author: 'A', authoredAt: 'd1' },
        { sha: HEAD, parent: OLD, title: 'second', author: 'alice', authoredAt: 'd2' },
      ],
    })
    const patch = await provider.compare(ref, BASE, HEAD, signal) as string
    expect(patch).toContain('--- a/dir/app.txt\n+++ b/dir/app.txt\n')
    expect(patch).toContain('-two\n+TWO')
    expect(() => provider.fileUrl(ref, HEAD, '../../x')).toThrow('invalid repository path')
    expect(provider.fileUrl(ref, HEAD, 'dir/a b.txt')).toBe(`https://${HOST}/owner/app/src/commit/${HEAD}/dir/a%20b.txt`)
  })

  it('reads the description with its labels', async () => {
    const { provider } = fakeHost(routes())
    expect(await provider.readDescription(ref, signal)).toMatchObject({ body: expect.stringContaining('Fixes #3'), labels: [{ name: 'bug', color: 'ff0000' }] })
  })

  it('fails a read of an unserved host and maps host failures', async () => {
    const { provider } = fakeHost({ 'GET repos/owner/app/pulls/7': { status: 404, body: { message: 'nope' } }, 'GET repos/owner/app': { body: repo } })
    const other = { repository: { ...repository, host: 'other.test' }, number: 7 }
    expect((await provider.fetchChecks(other, signal) as ForgeFailure).message).toContain('does not serve other.test')
    expect(await provider.fetchChecks(ref, signal)).toEqual({ code: 'not-found', message: 'nope' })
  })
})

describe('ForgejoProvider viewer lists', () => {
  const hit = (number: number, updated: string) => ({
    number, updated_at: updated, title: `Pull ${number}`, html_url: `https://${HOST}/owner/app/pulls/${number}`, user: user('carol'),
    pull_request: { draft: number === 9 }, repository: { owner: 'owner', name: 'app' },
  })
  const search = (call: { path: string }) => {
    if (call.path.includes('created=true')) return { body: [hit(7, '2026-01-02T00:00:00Z')] }
    if (call.path.includes('review_requested=true')) return { body: [hit(8, '2026-01-03T00:00:00Z')] }
    if (call.path.includes('reviewed=true')) return { body: [hit(7, '2026-01-02T00:00:00Z'), hit(9, '2026-01-05T00:00:00Z'), hit(8, '2026-01-03T00:00:00Z')] }
    return { body: [hit(9, '2026-01-05T00:00:00Z')] }
  }
  const viewerRoutes = () => routes({
    'GET repos/issues/search': search,
    'GET repos/owner/app/pulls/8': { body: pull({ number: 8, requested_reviewers: [user('carol')] }) },
    'GET repos/owner/app/pulls/9': { body: pull({ number: 9, title: 'Nine' }) },
    'GET repos/owner/app/pulls/8/reviews': { body: [review(5, 'carol', 'APPROVED')] },
    'GET repos/owner/app/pulls/9/reviews': { body: [] },
  })

  it('lists the viewer\'s pull requests with checks, reviews, and the request that asks them', async () => {
    const { provider } = fakeHost(viewerRoutes())
    expect(provider.viewer).toMatchObject({ hosts: [HOST], maxItems: 50 })
    const list = await provider.listForViewer({ host: HOST, filter: 'review-requested', repository: null, limit: 10 }, signal)
    expect(list).toMatchObject({ viewer: 'carol', total: 1, items: [{ ref: { number: 8 }, viewerRequest: { team: null }, viewerReview: { verdict: 'approved' }, checksRollup: 'failure' }] })
    const authored = await provider.listForViewer({ host: HOST, filter: 'authored', repository: null, limit: 10 }, signal)
    expect(authored).toMatchObject({ items: [{ ref: { number: 7 }, viewerRequest: null, viewerReview: null }] })
  })

  it('keeps the involved list apart from the other two, newest first, and counts every list', async () => {
    const { provider } = fakeHost(viewerRoutes())
    const involved = await provider.listForViewer({ host: HOST, filter: 'involved', repository: null, limit: 10 }, signal)
    expect(involved).toMatchObject({ total: 1, items: [{ ref: { number: 9 }, title: 'Nine' }] })
    const counted = fakeHost(viewerRoutes())
    expect(await counted.provider.countForViewer(HOST, signal)).toEqual(new Map([['review-requested', 1], ['authored', 1], ['involved', 1]]))
    expect(counted.calls.filter(call => call.path === 'user')).toHaveLength(1)
    expect(counted.calls.filter(call => call.path.startsWith('repos/issues/search'))).toHaveLength(5)
    const other = await provider.listForViewer({ host: HOST, filter: 'authored', repository: { owner: 'x', name: 'y' }, limit: 10 }, signal)
    expect(other).toMatchObject({ total: 0, items: [] })
  })

  it('refuses an unserved host, a limit past the maximum, and reports a failed search', async () => {
    const { provider } = fakeHost(routes({ 'GET repos/issues/search': { status: 500, body: { message: 'down' } } }))
    expect(await provider.listForViewer({ host: 'other.test', filter: 'authored', repository: null, limit: 5 }, signal)).toMatchObject({ code: 'unavailable' })
    await expect(provider.listForViewer({ host: HOST, filter: 'authored', repository: null, limit: 51 }, signal)).rejects.toThrow('limit')
    expect(await provider.listForViewer({ host: HOST, filter: 'authored', repository: null, limit: 5 }, signal)).toMatchObject({ code: 'unavailable', message: 'down' })
    expect(await provider.countForViewer('other.test', signal)).toMatchObject({ code: 'unavailable' })
    expect(await provider.countForViewer(HOST, signal)).toMatchObject({ message: 'down' })
  })

  it('keeps a pull request whose status cannot be read in the list, with what the search reports', async () => {
    const { provider } = fakeHost(routes({
      'GET repos/issues/search': search,
      'GET repos/owner/app/pulls/8': { status: 500, body: { message: 'broken' } },
      'GET repos/owner/app/pulls/9': { body: pull({ number: 9, title: 'Nine' }) },
      'GET repos/owner/app/pulls/9/reviews': { body: [] },
    }))
    const list = await provider.listForViewer({ host: HOST, filter: 'review-requested', repository: null, limit: 10 }, signal)
    expect(list).toMatchObject({ total: 1, items: [{ ref: { number: 8 }, title: 'Pull 8', headSha: '', checksRollup: 'none' }] })
  })
})

describe('ForgejoApi paging', () => {
  const items = Array.from({ length: 7 }, (_, index) => ({ index }))

  it.each([[true], [false]])('reads every page of a host that serves fewer items than asked (total header: %s)', async (sendTotal) => {
    const { api } = fakeHost({ 'GET list': { body: items } }, 'secret', 3, sendTotal)
    expect(await api.list(HOST, 'list', 100, signal)).toEqual({ items, truncated: false })
    expect(await api.list(HOST, 'list', 5, signal)).toEqual({ items: items.slice(0, 5), truncated: true })
  })
})
