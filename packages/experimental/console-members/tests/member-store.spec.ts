/** Per-member storage: one JSON file per member directory and unit under the Harness home. */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { memberStoreAt, requireUnit } from '../src/member-store.ts'
import { openRootRegistry } from '../src/registry.ts'
import { capturedLogger, principal, useTempHome } from './support.ts'

const temp = useTempHome()

const ALICE = principal('login-uid-alice-5501')
const BOB = principal('login-uid-bob-7702')

function registry() {
  return openRootRegistry({
    file: join(temp.home, 'console-members', 'roots.json'),
    membersRoot: join(temp.base, 'members'),
    seeds: [],
    platform: process.platform,
    logger: capturedLogger().logger,
  })
}

describe('member store', () => {
  it('writes a value under the member\'s directory id and reads it back', async () => {
    const members = registry()
    const directory = basename(members.ensureMember(ALICE))
    const store = members.memberStore(ALICE, 'server-sidebar')
    const value = { items: [1, 'two', null, true, { nested: 3.5 }] }

    await expect(store.read()).resolves.toBeUndefined()
    await store.write(value)
    await expect(store.read()).resolves.toEqual(value)
    const file = join(temp.home, 'console-members', directory, 'server-sidebar.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(value)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700)
    expect(file).not.toContain(ALICE)
  })

  it('keeps each member and unit in its own file', async () => {
    const members = registry()
    members.ensureMember(ALICE)
    members.ensureMember(BOB)
    await members.memberStore(ALICE, 'menu').write('alice menu')
    await members.memberStore(ALICE, 'skills-2').write('alice skills')
    await members.memberStore(BOB, 'menu').write('bob menu')

    await expect(members.memberStore(ALICE, 'menu').read()).resolves.toBe('alice menu')
    await expect(members.memberStore(ALICE, 'skills-2').read()).resolves.toBe('alice skills')
    await expect(members.memberStore(BOB, 'menu').read()).resolves.toBe('bob menu')
  })

  it('replaces the whole value on each write', async () => {
    const store = memberStoreAt('dir-a', 'unit')
    await store.write({ a: 1, b: 2 })
    await store.write({ c: 3 })
    await expect(store.read()).resolves.toEqual({ c: 3 })
  })

  it.each(['', 'Sidebar', 'a_b', 'a.b', 'a/b', '../escape', 'a b', 'é'])('refuses the unit name %j', (unit) => {
    expect(() => { requireUnit(unit) }).toThrow(/uses only a-z, 0-9 and -/)
    const members = registry()
    members.ensureMember(ALICE)
    expect(() => members.memberStore(ALICE, unit)).toThrow(/uses only a-z, 0-9 and -/)
  })

  it('refuses stored text that is not JSON without quoting it', async () => {
    const file = join(temp.home, 'console-members', 'dir-b', 'unit.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{"secret-ish": value-4711}')

    const read = memberStoreAt('dir-b', 'unit').read()
    await expect(read).rejects.toThrow('console-members: the stored unit data is not valid JSON')
    await read.catch((error: unknown) => { expect(String((error as Error).stack)).not.toContain('value-4711') })
  })

  it('passes on a read failure other than a missing file', async () => {
    mkdirSync(join(temp.home, 'console-members', 'dir-c', 'unit.json'), { recursive: true })
    await expect(memberStoreAt('dir-c', 'unit').read()).rejects.toThrow(/EISDIR/)
  })
})
