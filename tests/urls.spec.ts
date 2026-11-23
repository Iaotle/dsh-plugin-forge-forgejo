import { describe, expect, it } from 'vitest'
import { absoluteUrl, parsePullRequestUrl, parseRemoteUrl, repositoryPath } from '../src/urls.ts'

describe('Forgejo URLs', () => {
  it.each([
    ['https://git.example.test/owner/app.git', 'git.example.test', 'owner', 'app'],
    ['https://token@Git.Example.test:3000/owner/app/', 'git.example.test:3000', 'owner', 'app'],
    ['ssh://git@git.example.test:2222/owner/app.git', 'git.example.test', 'owner', 'app'],
    ['git@git.example.test:owner/app.git', 'git.example.test', 'owner', 'app'],
  ])('reads the remote %s', (url, host, owner, name) => {
    expect(parseRemoteUrl(url)).toEqual({ host, owner, name })
  })

  it.each(['https://git.example.test/owner', 'https://git.example.test/a/b/c', 'https://git.example.test/../app', 'nonsense'])(
    'rejects the remote %s', (url) => { expect(parseRemoteUrl(url)).toBeUndefined() },
  )

  it('reads a pull request page and rejects other pages', () => {
    expect(parsePullRequestUrl('https://git.example.test/owner/app/pulls/12/files')).toEqual({
      host: 'git.example.test', owner: 'owner', name: 'app', number: 12,
    })
    expect(parsePullRequestUrl('https://git.example.test/owner/app/issues/12')).toBeUndefined()
    expect(parsePullRequestUrl('https://git.example.test/owner/app/pulls/0')).toBeUndefined()
  })

  it('refuses to inline an unsafe repository or number', () => {
    const repository = { forge: 'forgejo', host: 'h', owner: 'o', name: 'a/../b' }
    expect(() => repositoryPath({ repository, number: 1 })).toThrow('invalid repository')
    expect(() => repositoryPath({ repository: { ...repository, name: 'app' }, number: -1 })).toThrow('invalid pull request number')
    expect(repositoryPath({ repository: { ...repository, name: 'app' }, number: 3 })).toBe('repos/o/app')
  })

  it('makes a relative target absolute', () => {
    expect(absoluteUrl('h', '/o/a/actions/runs/1')).toBe('https://h/o/a/actions/runs/1')
    expect(absoluteUrl('h', 'https://x/y')).toBe('https://x/y')
    expect(absoluteUrl('h', '')).toBeNull()
  })
})
