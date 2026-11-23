import { Context } from '@deepseek-ai/cordis'
import ForgeService from '@deepseek-ai/dsh-experimental-forge'
import { afterEach, describe, expect, it } from 'vitest'
import * as ForgeForgejo from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function forge(): Promise<Context> {
  ctx = new Context()
  await ctx.plugin(ForgeService)
  return ctx
}

describe('forge-forgejo plugin', () => {
  it('registers the Forgejo provider for the configured hosts and unregisters it with its fiber', async () => {
    const context = await forge()
    const fiber = context.plugin(ForgeForgejo, { hosts: ['Git.Example.test'] })
    await fiber
    expect(context.forge.changeRequestFromUrl('https://git.example.test/owner/app/pulls/6')).toEqual({
      repository: { forge: 'forgejo', host: 'git.example.test', owner: 'owner', name: 'app' }, number: 6,
    })
    expect(context.forge.describe('forgejo')).toEqual({ forge: 'forgejo', label: 'Forgejo', changeRequestNoun: 'pull-request' })
    await fiber.dispose()
    expect(context.forge.changeRequestFromUrl('https://git.example.test/owner/app/pulls/6')).toBeUndefined()
  })

  it.each([
    [{}, 'hosts'],
    [{ hosts: [] }, 'forge-forgejo: hosts must list at least one host'],
    [{ hosts: ['https://git.example.test'] }, 'forge-forgejo: invalid host "https://git.example.test"'],
    [{ hosts: ['h.test'], tokenEnv: ' ' }, 'forge-forgejo: tokenEnv must not be empty'],
    [{ hosts: ['h.test'], timeoutMs: 0 }, 'forge-forgejo: timeoutMs must be a positive integer no greater than 2147483647'],
    [{ hosts: ['h.test'], maxCommits: 0 }, 'forge-forgejo: maxCommits must be a positive safe integer'],
  ])('refuses the configuration %j', async (config, message) => {
    const context = await forge()
    await expect(context.plugin(ForgeForgejo, config as ForgeForgejo.Config)).rejects.toThrow(message)
  })
})
