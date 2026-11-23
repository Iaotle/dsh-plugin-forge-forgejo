/** Forgejo remote URL and pull request URL parsing, and validation of the paths inlined into API requests. */

import type { ChangeRequestRef, ForgeRepository } from '@deepseek-ai/dsh-experimental-forge'

/** Characters Forgejo permits in a user, organization, or repository name. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/

/** Host, owner, and repository addressed by a URL. */
export interface ForgejoLocation {
  /** Lowercase host name, with the port of an HTTP(S) URL. */
  readonly host: string
  /** User or organization that owns the repository. */
  readonly owner: string
  /** Repository name without a `.git` suffix. */
  readonly name: string
}

/**
 * Check one owner or repository name.
 * @param value - candidate name.
 * @returns whether Forgejo permits the name and it is not a dot path.
 */
export function isSegment(value: string): boolean {
  return SEGMENT.test(value) && value !== '.' && value !== '..'
}

function location(host: string, parts: readonly string[]): ForgejoLocation | undefined {
  const [owner, name, ...rest] = parts
  if (owner === undefined || name === undefined || rest.length > 0 || !isSegment(owner) || !isSegment(name)) return undefined
  return { host: host.toLowerCase(), owner, name }
}

/**
 * Validate a pull request before its repository path and number are inlined into an API path.
 * @param ref - pull request on a Forgejo host.
 * @returns the API path prefix `repos/<owner>/<name>`.
 * @throws when a name is not permitted or the number is not a positive integer.
 */
export function repositoryPath(ref: ChangeRequestRef): string {
  const { owner, name } = ref.repository
  if (!isSegment(owner) || !isSegment(name)) throw new Error(`forge-forgejo: invalid repository ${JSON.stringify(`${owner}/${name}`)}`)
  if (!Number.isSafeInteger(ref.number) || ref.number <= 0) throw new Error(`forge-forgejo: invalid pull request number ${ref.number}`)
  return `repos/${owner}/${name}`
}

/**
 * Parse a Git remote URL. Accepts `http(s)://[user@]host[:port]/owner/name`, `ssh://[user@]host[:port]/…`, `git://host/…`,
 * and the scp-like `[user@]host:owner/name`, each with an optional `.git` suffix or trailing slash. HTTP(S) ports belong to
 * the host identity; SSH and Git transport ports do not.
 * @param url - fetch or push URL as Git reports it.
 * @returns the location, or undefined for other URL forms.
 */
export function parseRemoteUrl(url: string): ForgejoLocation | undefined {
  const trimmed = url.trim()
  const scheme = /^https?:\/\/(?:[^@/]+@)?([^/:]+(?::\d+)?)\/(.+)$/i.exec(trimmed)
    ?? /^(?:ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed)
  const scp = scheme === null ? /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(trimmed) : null
  const match = scheme ?? scp
  if (match === null) return undefined
  const [, host = '', path = ''] = match
  return location(host, path.replace(/\/+$/, '').replace(/\.git$/i, '').split('/'))
}

/**
 * Parse a pull request web URL such as `https://git.example.com/owner/name/pulls/12/files`.
 * @param url - web URL of a pull request.
 * @returns the location and number, or undefined for other URLs.
 */
export function parsePullRequestUrl(url: string): (ForgejoLocation & { readonly number: number }) | undefined {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pulls\/(\d+)(?:[/?#].*)?$/i.exec(url.trim())
  if (match === null) return undefined
  const [, host = '', owner = '', name = '', digits = ''] = match
  const number = Number(digits)
  const parsed = location(host, [owner, name])
  return parsed === undefined || !Number.isSafeInteger(number) || number <= 0 ? undefined : { ...parsed, number }
}

/**
 * Percent-encode each segment of a repository-relative path for a web or API URL.
 * @param path - repository-relative path.
 * @returns the encoded path with `/` kept between segments.
 * @throws when the path is absolute or has an empty, `.`, or `..` segment, which would leave the repository's API path.
 */
export function encodedPath(path: string): string {
  const segments = path.split('/')
  if (path.startsWith('/') || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`forge-forgejo: invalid repository path ${JSON.stringify(path)}`)
  }
  return segments.map(encodeURIComponent).join('/')
}

/**
 * Build the repository of a location.
 * @param location - parsed host, owner, and repository.
 * @returns the repository of the `forgejo` family.
 */
export function repositoryOf(location: ForgejoLocation): ForgeRepository {
  return { forge: 'forgejo', host: location.host, owner: location.owner, name: location.name }
}

/**
 * Resolve a URL Forgejo reports by its path on the host, such as a relative status target.
 * @param host - Forgejo host.
 * @param url - URL as Forgejo reports it.
 * @returns the absolute URL, or null when Forgejo names none.
 */
export function absoluteUrl(host: string, url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === '') return null
  return url.startsWith('/') ? `https://${host}${url}` : url
}
