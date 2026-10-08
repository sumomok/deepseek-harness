/** The customer-token reader slot, `./credential-access`, and the registry's members, driven through a loaded row. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { customerCredentialAccess, memberRegistryAccess } from '../src/credential-access.ts'
import type { ConsoleMemberDirectory, CustomerCredentialReader, PrincipalKey } from '../src/types.ts'
import { admit, assertionFor, disposeMounted, expectNoSecret, mountRow, rowConfig, type MountedRow } from './fixture.ts'
import { principal, useTempHome } from './support.ts'

const temp = useTempHome()

const ALICE = principal('login-uid-alice-5501')
const BOB = principal('login-uid-bob-7702')
const CAROL = principal('login-uid-carol-3303')
const ALICE_TOKEN = 'eyJ.alice-token-9931.sig'
const BOB_TOKEN = 'eyJ.bob-token-4417.sig'

const ATTACHED = 'console-members: a customer credential reader is already attached; its disposer must run before another reader attaches'

afterEach(async () => {
  await disposeMounted()
})

/** A token holder's reader over a fixed table, which can report changes and counts its subscribers. */
interface FakeReader {
  readonly reader: CustomerCredentialReader
  readonly tokens: Map<PrincipalKey, string>
  /** Report a change to every subscriber. */
  report(principal: PrincipalKey, kind: 'set' | 'dropped'): void
  /** How many `onChange` subscriptions are live. */
  subscribers(): number
}

function fakeReader(entries: ReadonlyArray<readonly [PrincipalKey, string]> = []): FakeReader {
  const tokens = new Map(entries)
  const listeners = new Set<(principal: PrincipalKey, kind: 'set' | 'dropped') => void>()
  return {
    reader: {
      read: principal => tokens.get(principal),
      onChange: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    tokens,
    report: (principal, kind) => { for (const listener of [...listeners]) listener(principal, kind) },
    subscribers: () => listeners.size,
  }
}

async function mountMembers(overrides: Record<string, unknown> = {}): Promise<MountedRow> {
  return await mountRow(rowConfig(temp, overrides))
}

function directory(row: MountedRow): ConsoleMemberDirectory {
  return row.ctx.consoleMembers
}

/** The Peer one admission answered; fails the test on a refusal. */
function peerOf(row: MountedRow, member: PrincipalKey): PeerScope {
  const admission = admit(row.ctx, assertionFor(member))
  if (!('peer' in admission)) throw new Error(`refused with ${String(admission.rejection)}`)
  return admission.peer
}

/** Whether a value is a directory object, as the instance behind `ctx.consoleMembers` is. */
function isDirectory(value: unknown): value is ConsoleMemberDirectory {
  return typeof value === 'object' && value !== null && 'attachCustomerCredentials' in value
}

/** The thrown value of a call that must throw. */
function thrown(call: () => unknown): Error {
  try {
    call()
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error('the call threw a non-Error value')
  }
  throw new Error('the call did not throw')
}

describe('attaching the customer credential reader', () => {
  it('holds one reader at a time and takes a new one once the disposer has run', async () => {
    const row = await mountMembers()
    const first = fakeReader([[ALICE, ALICE_TOKEN]])
    const second = fakeReader([[ALICE, BOB_TOKEN]])
    const access = customerCredentialAccess(directory(row))
    const release = directory(row).attachCustomerCredentials(first.reader)
    const refusal = thrown(() => directory(row).attachCustomerCredentials(second.reader))
    expect(refusal.message).toBe(ATTACHED)
    expect(second.subscribers()).toBe(0)
    expect(access.read(ALICE)).toBe(ALICE_TOKEN)
    release()
    expect(first.subscribers()).toBe(0)
    directory(row).attachCustomerCredentials(second.reader)
    expect(access.read(ALICE)).toBe(BOB_TOKEN)
    expect(second.subscribers()).toBe(1)
  })

  it('reads nothing while no reader is attached, and nothing once the disposer has run', async () => {
    const row = await mountMembers()
    const access = customerCredentialAccess(directory(row))
    expect(access.read(ALICE)).toBeUndefined()
    const holder = fakeReader([[ALICE, ALICE_TOKEN]])
    const release = directory(row).attachCustomerCredentials(holder.reader)
    expect(access.read(ALICE)).toBe(ALICE_TOKEN)
    expect(access.read(BOB)).toBeUndefined()
    release()
    expect(access.read(ALICE)).toBeUndefined()
  })

  it('leaves the slot free when the reader\'s onChange throws', async () => {
    const row = await mountMembers()
    const broken: CustomerCredentialReader = {
      read: () => ALICE_TOKEN,
      onChange: () => { throw new Error('the reader cannot subscribe') },
    }
    expect(() => directory(row).attachCustomerCredentials(broken)).toThrow('the reader cannot subscribe')
    const access = customerCredentialAccess(directory(row))
    expect(access.read(ALICE)).toBeUndefined()
    directory(row).attachCustomerCredentials(fakeReader([[ALICE, ALICE_TOKEN]]).reader)
    expect(access.read(ALICE)).toBe(ALICE_TOKEN)
  })
})

describe('the disposer', () => {
  it('calls every onDetached listener once, while the slot is still held and no token is read', async () => {
    const row = await mountMembers()
    const access = customerCredentialAccess(directory(row))
    const seen: unknown[] = []
    access.onDetached(() => {
      seen.push(access.read(ALICE))
      seen.push(thrown(() => directory(row).attachCustomerCredentials(fakeReader().reader)).message)
    })
    access.onDetached(() => { seen.push('second listener') })
    const release = directory(row).attachCustomerCredentials(fakeReader([[ALICE, ALICE_TOKEN]]).reader)
    release()
    expect(seen).toEqual([undefined, ATTACHED, 'second listener'])
    directory(row).attachCustomerCredentials(fakeReader().reader)
  })

  it('acts once: a repeated call notifies nobody, and a late call leaves a newer reader attached', async () => {
    const row = await mountMembers()
    const access = customerCredentialAccess(directory(row))
    let detached = 0
    access.onDetached(() => { detached += 1 })
    const release = directory(row).attachCustomerCredentials(fakeReader([[ALICE, ALICE_TOKEN]]).reader)
    release()
    release()
    expect(detached).toBe(1)
    const newer = fakeReader([[ALICE, BOB_TOKEN]])
    directory(row).attachCustomerCredentials(newer.reader)
    release()
    expect(detached).toBe(1)
    expect(access.read(ALICE)).toBe(BOB_TOKEN)
    expect(newer.subscribers()).toBe(1)
    expect(thrown(() => directory(row).attachCustomerCredentials(fakeReader().reader)).message).toBe(ATTACHED)
  })

  it('ignores a repeated call from inside an onDetached listener', async () => {
    const row = await mountMembers()
    const access = customerCredentialAccess(directory(row))
    let detached = 0
    let release = (): void => undefined
    access.onDetached(() => {
      detached += 1
      release()
    })
    release = directory(row).attachCustomerCredentials(fakeReader().reader)
    release()
    expect(detached).toBe(1)
  })

  it('keeps calling the other onDetached listeners when one throws, and logs neither its error nor a member', async () => {
    const row = await mountMembers()
    const access = customerCredentialAccess(directory(row))
    const seen: string[] = []
    access.onDetached(() => { throw new Error(`listener refused ${ALICE} ${ALICE_TOKEN}`) })
    access.onDetached(() => { seen.push('after') })
    directory(row).attachCustomerCredentials(fakeReader([[ALICE, ALICE_TOKEN]]).reader)()
    expect(seen).toEqual(['after'])
    expect(row.lines.filter(line => line.includes('console-members: a customer credential onDetached listener threw'))).toHaveLength(1)
    expectNoSecret(row.lines, ALICE, ALICE_TOKEN, 'listener refused')
  })

  it('detaches when the reader\'s onChange disposer throws, logging no reader text', async () => {
    const row = await mountMembers()
    const access = customerCredentialAccess(directory(row))
    let detached = 0
    access.onDetached(() => { detached += 1 })
    const reader: CustomerCredentialReader = {
      read: () => ALICE_TOKEN,
      onChange: () => () => { throw new Error(`reader failed for ${ALICE}`) },
    }
    directory(row).attachCustomerCredentials(reader)()
    expect(detached).toBe(1)
    expect(access.read(ALICE)).toBeUndefined()
    expect(row.lines.filter(line => line.includes('onChange disposer threw'))).toHaveLength(1)
    expectNoSecret(row.lines, ALICE, 'reader failed')
    directory(row).attachCustomerCredentials(fakeReader().reader)
  })

  it('stops calling an onDetached listener once its own disposer has run', async () => {
    const row = await mountMembers()
    const access = customerCredentialAccess(directory(row))
    let detached = 0
    const stop = access.onDetached(() => { detached += 1 })
    directory(row).attachCustomerCredentials(fakeReader().reader)()
    stop()
    directory(row).attachCustomerCredentials(fakeReader().reader)()
    expect(detached).toBe(1)
  })
})

describe('forwarding the reader\'s changes', () => {
  it('forwards set and dropped from whichever reader is attached, and nothing from a detached one', async () => {
    const row = await mountMembers()
    const access = customerCredentialAccess(directory(row))
    const changes: unknown[] = []
    access.onChange((member, kind) => { changes.push([member, kind]) })
    const first = fakeReader()
    const release = directory(row).attachCustomerCredentials(first.reader)
    first.report(ALICE, 'set')
    first.report(ALICE, 'dropped')
    release()
    first.report(BOB, 'set')
    const second = fakeReader()
    directory(row).attachCustomerCredentials(second.reader)
    second.report(BOB, 'set')
    expect(changes).toEqual([[ALICE, 'set'], [ALICE, 'dropped'], [BOB, 'set']])
  })

  it('drops a change a detached reader reports through a subscription it kept', async () => {
    const row = await mountMembers()
    const access = customerCredentialAccess(directory(row))
    const changes: unknown[] = []
    access.onChange((member, kind) => { changes.push([member, kind]) })
    let kept: ((member: PrincipalKey, kind: 'set' | 'dropped') => void) | undefined
    const reader: CustomerCredentialReader = {
      read: () => undefined,
      onChange: (listener) => {
        kept = listener
        return () => undefined
      },
    }
    directory(row).attachCustomerCredentials(reader)()
    kept?.(ALICE, 'set')
    expect(changes).toEqual([])
  })

  it('keeps forwarding to the other listeners when one throws, and logs neither its error nor the member', async () => {
    const row = await mountMembers()
    const access = customerCredentialAccess(directory(row))
    const seen: string[] = []
    access.onChange(() => { throw new Error(`listener refused ${ALICE}`) })
    const stop = access.onChange((_member, kind) => { seen.push(kind) })
    const holder = fakeReader()
    directory(row).attachCustomerCredentials(holder.reader)
    holder.report(ALICE, 'set')
    stop()
    holder.report(ALICE, 'dropped')
    expect(seen).toEqual(['set'])
    expect(row.lines.filter(line => line.includes('console-members: a customer credential onChange listener threw'))).toHaveLength(2)
    expectNoSecret(row.lines, ALICE, 'listener refused')
  })
})

describe('a holder that attaches inside its own effect', () => {
  it('detaches once when the holder unloads', async () => {
    const row = await mountMembers()
    const access = customerCredentialAccess(directory(row))
    let detached = 0
    access.onDetached(() => { detached += 1 })
    const holder = fakeReader([[ALICE, ALICE_TOKEN]])
    const plugin = row.ctx.plugin({
      inject: ['consoleMembers'],
      apply: (ctx: Context) => { ctx.effect(() => ctx.consoleMembers.attachCustomerCredentials(holder.reader), 'holder: reader') },
    })
    await plugin
    expect(access.read(ALICE)).toBe(ALICE_TOKEN)
    await plugin.dispose()
    expect(detached).toBe(1)
    expect(holder.subscribers()).toBe(0)
    expect(access.read(ALICE)).toBeUndefined()
    directory(row).attachCustomerCredentials(fakeReader().reader)
  })

  it('calls onDetached in the holder\'s cleanup order, after a revoke that precedes the disposer', async () => {
    const row = await mountMembers()
    const access = customerCredentialAccess(directory(row))
    let revoked = false
    const revokedAtDetach: boolean[] = []
    access.onDetached(() => { revokedAtDetach.push(revoked) })
    const plugin = row.ctx.plugin({
      apply: (ctx: Context) => {
        ctx.inject(['consoleMembers'], (scope) => {
          scope.effect(() => {
            const release = scope.consoleMembers.attachCustomerCredentials(fakeReader().reader)
            return () => {
              revoked = true
              release()
            }
          }, 'holder: reader lent to consoleMembers')
        })
      },
    })
    await plugin
    await plugin.dispose()
    expect(revokedAtDetach).toEqual([true])
  })
})

describe('reaching the row through ctx.consoleMembers and the instance', () => {
  it('reads the same reader and registry through another plugin\'s proxy and through the instance behind it', async () => {
    const row = await mountMembers()
    peerOf(row, ALICE)
    const proxy = directory(row)
    const original: unknown = Reflect.get(proxy, symbols.original)
    if (!isDirectory(original)) throw new Error('ctx.consoleMembers has no original instance')
    const instance = original
    expect(instance).not.toBe(proxy)
    const answers: unknown[] = []
    const plugin = row.ctx.plugin({
      inject: ['consoleMembers'],
      apply: (ctx: Context) => {
        ctx.consoleMembers.attachCustomerCredentials(fakeReader([[ALICE, ALICE_TOKEN]]).reader)
        answers.push(customerCredentialAccess(ctx.consoleMembers).read(ALICE), memberRegistryAccess(ctx.consoleMembers).principals())
      },
    })
    await plugin
    answers.push(customerCredentialAccess(instance).read(ALICE), memberRegistryAccess(instance).principals())
    expect(answers).toEqual([ALICE_TOKEN, [ALICE], ALICE_TOKEN, [ALICE]])
  })

  it('refuses a value that is not a directory this package\'s row provided', async () => {
    const row = await mountMembers()
    const real = directory(row)
    const imitation: ConsoleMemberDirectory = {
      principalOfRequest: req => real.principalOfRequest(req),
      principalOfCaller: peer => real.principalOfCaller(peer),
      principalOfSession: sessionId => real.principalOfSession(sessionId),
      memberRoot: member => real.memberRoot(member),
      rootsOf: member => real.rootsOf(member),
      principals: () => real.principals(),
      onChange: listener => real.onChange(listener),
      memberStore: (member, unit) => real.memberStore(member, unit),
      attachCustomerCredentials: reader => real.attachCustomerCredentials(reader),
    }
    const refusal = 'console-members: the value is not a console member directory this package\'s plugin row provided'
    expect(() => customerCredentialAccess(imitation)).toThrow(refusal)
    expect(() => memberRegistryAccess(imitation)).toThrow(refusal)
  })
})

describe('the registry\'s members', () => {
  it('lists every member admitted once, with or without an open Peer, and a seed-only principal from its first admission', async () => {
    const seedRoot = join(temp.base, 'carol-seed')
    mkdirSync(seedRoot, { recursive: true })
    const row = await mountMembers({ rootSeeds: [{ path: seedRoot, principal: CAROL }] })
    const registry = memberRegistryAccess(directory(row))
    expect(registry.principals()).toEqual([])
    const alicePeer = peerOf(row, ALICE)
    peerOf(row, BOB)
    await alicePeer.dispose()
    expect(directory(row).principals()).toEqual([BOB])
    expect(registry.principals()).toEqual([ALICE, BOB])
    peerOf(row, CAROL)
    expect(registry.principals()).toEqual([ALICE, BOB, CAROL])
  })

  it('reports a member at the first admission only, before the Peer opens, and not the members roots.json held at load', async () => {
    const row = await mountMembers()
    const registry = memberRegistryAccess(directory(row))
    const added: unknown[] = []
    registry.onAdded((member) => { added.push([member, directory(row).principals().length]) })
    const first = peerOf(row, ALICE)
    await first.dispose()
    peerOf(row, ALICE)
    peerOf(row, BOB)
    expect(added).toEqual([[ALICE, 0], [BOB, 1]])

    await disposeMounted()
    const reloaded = await mountMembers()
    const afterReload: unknown[] = []
    memberRegistryAccess(directory(reloaded)).onAdded((member) => { afterReload.push(member) })
    peerOf(reloaded, ALICE)
    expect(afterReload).toEqual([])
    expect(memberRegistryAccess(directory(reloaded)).principals()).toEqual([ALICE, BOB])
  })

  it('admits the member when an onAdded listener throws, logs neither its error nor the member, and stops a removed listener', async () => {
    const row = await mountMembers()
    const registry = memberRegistryAccess(directory(row))
    const added: unknown[] = []
    registry.onAdded((member) => { throw new Error(`listener refused ${member}`) })
    const stop = registry.onAdded((member) => { added.push(member) })
    const peer = peerOf(row, ALICE)
    expect(directory(row).principalOfCaller(peer)).toBe(ALICE)
    stop()
    peerOf(row, BOB)
    expect(added).toEqual([ALICE])
    expect(row.lines.filter(line => line.includes('console-members: a memberRegistryAccess onAdded listener threw'))).toHaveLength(2)
    expectNoSecret(row.lines, ALICE, BOB, 'listener refused')
  })
})
