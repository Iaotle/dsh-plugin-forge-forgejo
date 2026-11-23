/**
 * Registers the Forgejo provider of `ctx.forge`, which reads and writes pull requests on the Forgejo hosts it is
 * configured for through their REST API with one access token.
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, resolveCredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-experimental-forge'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { ForgejoApi } from './api.ts'
import { ForgejoProvider } from './provider.ts'

export const name = 'forge-forgejo'
export const inject = ['forge']

/** Served hosts, the access token's credential, and read limits. */
export interface Config {
  /** Host names this provider serves, such as `git.example.com`, with the HTTPS port when it is not 443; required. */
  hosts: string[]
  /** Name of the credential that holds the access token, resolved at each request. */
  tokenEnv?: string
  /** Deadline in milliseconds for one request. */
  timeoutMs?: number
  /** Largest response body in bytes. */
  maxResponseBytes?: number
  /** Most review threads one review read returns, which reports itself truncated past it. */
  maxReviewThreads?: number
  /** Most commits one pull request commit listing returns, the oldest ones when there are more. */
  maxCommits?: number
  /** Most requests one status fetch runs at once. */
  maxConcurrentRequests?: number
  /** Most pull requests one viewer list returns. */
  maxViewerItems?: number
}

export const Config: z<Config> = z.object({
  hosts: z.array(z.string()).required(),
  tokenEnv: z.string().default('FORGEJO_TOKEN'),
  timeoutMs: z.number().default(30_000),
  maxResponseBytes: z.number().default(16_777_216),
  maxReviewThreads: z.number().default(1_000),
  maxCommits: z.number().default(250),
  maxConcurrentRequests: z.number().default(4),
  maxViewerItems: z.number().default(50),
})

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i

export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Config>
  if (resolved.hosts.length === 0) throw new Error('forge-forgejo: hosts must list at least one host')
  for (const host of resolved.hosts) {
    if (!HOST.test(host)) throw new Error(`forge-forgejo: invalid host ${JSON.stringify(host)}`)
  }
  if (resolved.tokenEnv.trim().length === 0) throw new Error('forge-forgejo: tokenEnv must not be empty')
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0 || resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`forge-forgejo: timeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  for (const key of ['maxResponseBytes', 'maxReviewThreads', 'maxCommits', 'maxConcurrentRequests', 'maxViewerItems'] as const) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) throw new Error(`forge-forgejo: ${key} must be a positive safe integer`)
  }
  const ref = credentialRef(resolved.tokenEnv)
  const api = new ForgejoApi(async () => await resolveCredentialRef(ctx, ref), resolved)
  ctx.forge.register(new ForgejoProvider(api, resolved.hosts, resolved))
}
