/** The plugin row's load: Config checks, the assertion key, Connection's requireAdmitter, and the seed merge, in that order. */
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, apply, inject, name, type RootSeed } from '../src/index.ts'
import { captureLogs, useTempHome } from './support.ts'

const temp = useTempHome()

const ALICE = 'login-uid-alice-5501'
const BOB = 'login-uid-bob-7702'

const ed25519 = generateKeyPairSync('ed25519')
const PUBLIC_PEM = ed25519.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_PEM = ed25519.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const RSA_PEM = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
/** The base64 body of a PEM, which a load error or log line must never quote. */
const body = (pem: string): string => pem.split('\n')[1]!

const KEY_REFUSAL = 'console-members: assertionPublicKey must be an Ed25519 public key in SPKI PEM form (-----BEGIN PUBLIC KEY-----)'
const ADMITTER_REFUSAL = /client-connection row must set requireAdmitter: true/

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function rootsFile(): string {
  return join(temp.home, 'console-members', 'roots.json')
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assertionPublicKey: PUBLIC_PEM,
    deploymentId: 'deployment-1',
    membersRoot: join(temp.base, 'members'),
    ...overrides,
  }
}

interface Loaded {
  readonly error: unknown
  readonly lines: readonly string[]
  readonly ctx: Context
}

/** Load the row next to a Connection with the given `requireAdmitter`, and collect the outcome and every log line. */
async function load(rowConfig: Record<string, unknown>, requireAdmitter = true): Promise<Loaded> {
  const ctx = new Context()
  contexts.push(ctx)
  const lines = captureLogs(ctx)
  new HostConnectionService(ctx, [], {} as BrowserAuth, requireAdmitter)
  const fiber = ctx.plugin({ name, inject, Config, apply }, rowConfig as never)
  const error = await fiber.await().then(() => undefined, (reason: unknown) => reason)
  return { error, lines, ctx }
}

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(Error)
  return (error as Error).message
}

function expectNoLeak(loaded: Loaded, ...secrets: string[]): void {
  const texts = [String((loaded.error as Error | undefined)?.stack), ...loaded.lines]
  for (const text of texts) {
    for (const secret of secrets) expect(text).not.toContain(secret)
  }
}

describe('console-members plugin row', () => {
  it('loads with the three required fields, merges the seeds, and provides no service yet', async () => {
    const seeds: RootSeed[] = [{ path: join(temp.base, 'legacy'), principal: ALICE }, { path: join(temp.base, 'shared'), owner: 'none' }]
    const loaded = await load(config({ rootSeeds: seeds, admins: [ALICE] }))

    expect(loaded.error).toBeUndefined()
    expect(JSON.parse(readFileSync(rootsFile(), 'utf8'))).toEqual({
      version: 1,
      roots: [{ kind: 'seed', path: join(temp.base, 'legacy'), principal: ALICE }, { kind: 'none', path: join(temp.base, 'shared') }],
    })
    expect(loaded.ctx.get('consoleMembers')).toBeUndefined()
    expect(inject).toEqual(['connection'])
  })

  it.each(['assertionPublicKey', 'deploymentId', 'membersRoot'])('refuses to load without %s', async (field) => {
    const loaded = await load(config({ [field]: undefined }))
    expect(messageOf(loaded.error)).toContain(`$.${field} missing required value`)
  })

  it('refuses a peerIdleMs that is not a positive whole number', async () => {
    for (const peerIdleMs of [0, 1.5]) {
      const loaded = await load(config({ peerIdleMs }))
      expect(messageOf(loaded.error)).toContain('$.peerIdleMs')
    }
  })
})

describe('the Config fields', () => {
  it.each([
    ['an assertion header that is not a header name', { assertionHeader: 'x member' }, 'console-members: assertionHeader must be a non-empty HTTP header name'],
    ['an empty assertion header', { assertionHeader: '' }, 'console-members: assertionHeader must be a non-empty HTTP header name'],
    ['an empty deployment id', { deploymentId: '' }, 'console-members: deploymentId must not be empty'],
    ['a relative membersRoot', { membersRoot: 'members' }, 'console-members: membersRoot must be an absolute path'],
    ['a relative shared read root', { sharedReadRoots: ['/ok', 'shared'] }, 'console-members: sharedReadRoots[1] must be an absolute path'],
    ['a relative host read path', { hostReadPaths: ['host'] }, 'console-members: hostReadPaths[0] must be an absolute path'],
    ['a relative host write path', { hostWritePaths: ['host'] }, 'console-members: hostWritePaths[0] must be an absolute path'],
    ['admins given as one value', { admins: ALICE }, 'console-members: admins must be a list'],
    ['rootSeeds given as one value', { rootSeeds: ALICE }, 'console-members: rootSeeds must be a list'],
    ['rootSeeds given as one seed', { rootSeeds: { path: '/x', principal: ALICE } }, 'console-members: rootSeeds must be a list'],
    ['a seed that is not an object', { rootSeeds: ['/x'] }, 'console-members: rootSeeds[0] must be { path, principal } or { path, owner: \'none\' }'],
    ['a seed that is an array', { rootSeeds: [['/x']] }, 'console-members: rootSeeds[0] must be { path, principal } or { path, owner: \'none\' }'],
    ['a seed without a path', { rootSeeds: [{ principal: ALICE }] }, 'console-members: rootSeeds[0].path must be a string'],
    ['a seed with a relative path', { rootSeeds: [{ path: 'x', principal: ALICE }] }, 'console-members: rootSeeds[0].path must be an absolute path'],
    ['a seed with both owner forms', { rootSeeds: [{ path: '/x', principal: ALICE, owner: 'none' }] }, 'console-members: rootSeeds[0] must be { path, principal } or { path, owner: \'none\' }'],
    ['a seed with another owner', { rootSeeds: [{ path: '/x', owner: ALICE }] }, 'console-members: rootSeeds[0] must be { path, principal } or { path, owner: \'none\' }'],
    ['a seed with an empty principal', { rootSeeds: [{ path: '/x', principal: '' }] }, 'console-members: rootSeeds[0].principal must be a non-empty login_uid string'],
    ['a seed whose principal is a number', { rootSeeds: [{ path: '/x', principal: 90817263 }] }, 'console-members: rootSeeds[0].principal must be a non-empty login_uid string'],
    ['an admin that is not a string', { admins: [ALICE, 81726354] }, 'console-members: admins[1] must be a non-empty login_uid string'],
  ])('refuses %s, quoting no login_uid', async (_name, overrides, message) => {
    const loaded = await load(config(overrides))
    expect(messageOf(loaded.error)).toBe(message)
    expectNoLeak(loaded, ALICE, '90817263', '81726354')
  })

  it('accepts a header name in any case', async () => {
    expect((await load(config({ assertionHeader: 'X-Console-Member' }))).error).toBeUndefined()
  })
})

describe('the assertion key', () => {
  it.each([
    ['an RSA public key', RSA_PEM],
    ['an Ed25519 private key', PRIVATE_PEM],
    ['an undecodable public key block', '-----BEGIN PUBLIC KEY-----\nAAAAnotakey\n-----END PUBLIC KEY-----\n'],
    ['text that is not PEM', 'ed25519:abcdef'],
  ])('refuses %s without quoting it', async (_name, pem) => {
    const loaded = await load(config({ assertionPublicKey: pem }))
    expect(messageOf(loaded.error)).toBe(KEY_REFUSAL)
    expectNoLeak(loaded, body(pem), 'AAAAnotakey', 'abcdef')
  })

  it('accepts an Ed25519 SPKI key with surrounding whitespace', async () => {
    expect((await load(config({ assertionPublicKey: `\n  ${PUBLIC_PEM}\n` }))).error).toBeUndefined()
  })
})

describe('Connection\'s requireAdmitter', () => {
  it('refuses to load when it is false, naming the field', async () => {
    const loaded = await load(config(), false)
    expect(messageOf(loaded.error)).toMatch(ADMITTER_REFUSAL)
  })
})

describe('the order of the load checks', () => {
  it('checks the Config fields before the key', async () => {
    const loaded = await load(config({ membersRoot: 'relative', assertionPublicKey: RSA_PEM }), false)
    expect(messageOf(loaded.error)).toBe('console-members: membersRoot must be an absolute path')
  })

  it('checks the key before requireAdmitter', async () => {
    const loaded = await load(config({ assertionPublicKey: RSA_PEM }), false)
    expect(messageOf(loaded.error)).toBe(KEY_REFUSAL)
  })

  it('checks requireAdmitter before merging the seeds, and writes nothing when it fails', async () => {
    const shared = join(temp.base, 'shared')
    const loaded = await load(config({ rootSeeds: [{ path: shared, principal: ALICE }, { path: shared, principal: BOB }] }), false)
    expect(messageOf(loaded.error)).toMatch(ADMITTER_REFUSAL)
    expect(existsSync(rootsFile())).toBe(false)
  })

  it('refuses conflicting seeds last, naming no principal key in the error or the log', async () => {
    const shared = join(temp.base, 'shared')
    const loaded = await load(config({ rootSeeds: [{ path: shared, principal: ALICE }, { path: shared, principal: BOB }] }))
    expect(messageOf(loaded.error)).toBe('console-members: rootSeeds[1] names a directory rootSeeds[0] registers to another owner')
    expect(loaded.lines.length).toBeGreaterThan(0)
    expectNoLeak(loaded, ALICE, BOB)
    expect(existsSync(rootsFile())).toBe(false)
  })

  it('refuses a corrupt roots.json without its content reaching the error or the log', async () => {
    mkdirSync(dirname(rootsFile()), { recursive: true })
    writeFileSync(rootsFile(), `{"version":1,"roots":[{"kind":"seed","path":"/r","principal":${ALICE}}]}`)
    const loaded = await load(config())
    expect(messageOf(loaded.error)).toBe(`console-members: ${rootsFile()} is not valid JSON`)
    expect(loaded.lines.length).toBeGreaterThan(0)
    expectNoLeak(loaded, 'login-uid')
  })
})
