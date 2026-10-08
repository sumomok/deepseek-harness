/** The root registry: member roots on first sighting, seed merging, overlap refusal, and `roots.json` handling. */
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Logger } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { CheckedRootSeed } from '../src/config.ts'
import { foldName } from '../src/paths.ts'
import { openRootRegistry, type RootRegistry } from '../src/registry.ts'
import { capturedLogger, principal, useTempHome } from './support.ts'

const temp = useTempHome()

const ALICE = principal('login-uid-alice-5501')
const BOB = principal('login-uid-bob-7702')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function rootsFile(): string {
  return join(temp.home, 'console-members', 'roots.json')
}

function membersRoot(): string {
  return join(temp.base, 'members')
}

function logger(): Logger {
  return capturedLogger().logger
}

function open(seeds: readonly CheckedRootSeed[] = [], platform: NodeJS.Platform = process.platform): RootRegistry {
  return openRootRegistry({ file: rootsFile(), membersRoot: membersRoot(), seeds, platform, logger: logger() })
}

function seedFor(owner: typeof ALICE, path: string): CheckedRootSeed {
  return { path, owner: 'member', principal: owner }
}

function unowned(path: string): CheckedRootSeed {
  return { path, owner: 'none' }
}

/** A directory under the fixture base, created, with its real path. */
function directory(name: string): string {
  const path = join(temp.base, name)
  mkdirSync(path, { recursive: true })
  return realpathSync.native(path)
}

/** The error a call throws, so its message can be checked for leaks. */
function thrown(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected the call to throw')
}

function storedText(): string {
  return readFileSync(rootsFile(), 'utf8')
}

function siblings(): string[] {
  return readdirSync(dirname(rootsFile()))
}

describe('member roots', () => {
  it('creates a 0700 root named by a random UUID and records it before returning', () => {
    const registry = open()
    const root = registry.ensureMember(ALICE)

    expect(dirname(root)).toBe(realpathSync.native(membersRoot()))
    expect(basename(root)).toMatch(UUID)
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(JSON.parse(storedText())).toEqual({
      version: 1,
      roots: [{ kind: 'member', path: root, principal: ALICE, directory: basename(root) }],
    })
    expect(statSync(rootsFile()).mode & 0o777).toBe(0o600)
    expect(registry.memberRoot(ALICE)).toBe(root)
    expect(registry.rootsOf(ALICE)).toEqual([root])
  })

  it('returns the same root on a second admission and creates no other directory', () => {
    const registry = open()
    const first = registry.ensureMember(ALICE)
    const recorded = statSync(rootsFile()).ino

    expect(registry.ensureMember(ALICE)).toBe(first)
    expect(readdirSync(membersRoot())).toEqual([basename(first)])
    expect(statSync(rootsFile()).ino).toBe(recorded)
  })

  it('finds the member\'s root again when the process ends right after recording it', () => {
    const before = open().ensureMember(ALICE)

    const restarted = open()
    expect(restarted.memberRoot(ALICE)).toBe(before)
    expect(restarted.ensureMember(ALICE)).toBe(before)
    expect(readdirSync(membersRoot())).toEqual([basename(before)])
  })

  it('names no directory after a principal key', () => {
    const registry = open()
    const members = [ALICE, BOB, principal('login-uid-carol-9903')]
    for (const member of members) registry.ensureMember(member)

    const names = readdirSync(membersRoot())
    expect(names).toHaveLength(members.length)
    for (const name of names) {
      expect(name).toMatch(UUID)
      for (const member of members) expect(foldName(name)).not.toContain(foldName(member))
    }
  })

  it('records only kinds, paths, directory ids and principal keys in roots.json', () => {
    const seeded = directory('seeded')
    const registry = open([seedFor(BOB, seeded), unowned(join(temp.base, 'shared'))])
    const root = registry.ensureMember(ALICE)

    const leaves: unknown[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk)
      else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk)
      else leaves.push(value)
    }
    walk(JSON.parse(storedText()))
    expect(new Set(leaves)).toEqual(new Set([
      1, 'seed', 'none', 'member', seeded, BOB, join(temp.base, 'shared'), root, ALICE, basename(root),
    ]))
  })

  it('answers seed roots before the member is first admitted, and the default root after', () => {
    const seeded = directory('legacy')
    const registry = open([seedFor(ALICE, seeded)])

    expect(registry.rootsOf(ALICE)).toEqual([seeded])
    expect(registry.rootsOf(BOB)).toEqual([])
    const root = registry.ensureMember(ALICE)
    expect(registry.rootsOf(ALICE)).toEqual([seeded, root])
  })

  it('refuses the root and the store of a member never admitted, naming no principal key', () => {
    const registry = open()
    for (const error of [thrown(() => registry.memberRoot(ALICE)), thrown(() => registry.memberStore(ALICE, 'sidebar'))]) {
      expect(error.message).toMatch(/has no registered root/)
      expect(error.message).not.toContain(ALICE)
    }
  })

  it('refuses an unusable store unit name before looking the member up', () => {
    expect(() => open().memberStore(ALICE, 'Bad/Unit')).toThrow(/uses only a-z, 0-9 and -/)
  })

  it('replaces roots.json through a rename, so a symbolic link at its path is not written through', () => {
    const outside = join(temp.base, 'outside.json')
    mkdirSync(dirname(rootsFile()), { recursive: true })
    symlinkSync(outside, rootsFile())
    const registry = open()

    registry.ensureMember(ALICE)
    expect(existsSync(outside)).toBe(false)
    expect(lstatSync(rootsFile()).isSymbolicLink()).toBe(false)
    expect(siblings()).toEqual(['roots.json'])
  })

  it('leaves the member unregistered and no temporary file behind when roots.json cannot be replaced', () => {
    const registry = open()
    mkdirSync(join(rootsFile(), 'occupied'), { recursive: true })

    expect(() => registry.ensureMember(ALICE)).toThrow()
    expect(siblings()).toEqual(['roots.json'])
    expect(registry.rootsOf(ALICE)).toEqual([])
    expect(() => registry.memberRoot(ALICE)).toThrow(/has no registered root/)
  })
})

describe('migration seeds', () => {
  it('merges both seed forms and leaves roots.json untouched when a later load adds nothing', () => {
    const owned = directory('owned')
    const shared = directory('shared')
    const seeds = [seedFor(ALICE, owned), unowned(shared)]
    open(seeds)
    const written = storedText()
    const recorded = statSync(rootsFile()).ino

    expect(JSON.parse(written)).toEqual({
      version: 1,
      roots: [{ kind: 'seed', path: owned, principal: ALICE }, { kind: 'none', path: shared }],
    })
    expect(open(seeds).rootsOf(ALICE)).toEqual([owned])
    expect(storedText()).toBe(written)
    expect(statSync(rootsFile()).ino).toBe(recorded)
  })

  it('writes nothing when there are neither recorded roots nor seeds', () => {
    open()
    expect(existsSync(rootsFile())).toBe(false)
  })

  it('refuses a seed for a directory roots.json registers to another owner, naming no principal key', () => {
    const owned = directory('owned')
    open([seedFor(ALICE, owned)])

    for (const seed of [seedFor(BOB, owned), unowned(owned)]) {
      const error = thrown(() => open([seed]))
      expect(error.message).toMatch(/rootSeeds\[0\] names a directory a root recorded in .*roots\.json registers to another owner/)
      expect(error.message).not.toContain(ALICE)
      expect(error.message).not.toContain(BOB)
    }
  })

  it('refuses two seeds that give one directory two owners', () => {
    const owned = directory('owned')
    const error = thrown(() => open([seedFor(ALICE, owned), seedFor(BOB, owned)]))

    expect(error.message).toBe('console-members: rootSeeds[1] names a directory rootSeeds[0] registers to another owner')
    expect(existsSync(rootsFile())).toBe(false)
  })

  it('refuses roots that lie one inside the other, whoever owns them', () => {
    const outer = directory('outer')
    const inner = directory('outer/inner')
    expect(() => open([seedFor(ALICE, outer), seedFor(ALICE, inner)]))
      .toThrow('console-members: rootSeeds[1] and rootSeeds[0] lie one inside the other')
    expect(() => open([unowned(inner), seedFor(BOB, outer)]))
      .toThrow('console-members: rootSeeds[1] and rootSeeds[0] lie one inside the other')
  })

  it('reads a directory whose name starts with .. as lying inside its parent', () => {
    const outer = directory('outer')
    const dotted = directory('outer/..x')
    expect(() => open([seedFor(ALICE, outer), unowned(dotted)]))
      .toThrow('console-members: rootSeeds[1] and rootSeeds[0] lie one inside the other')
  })

  it('refuses a seed that is, contains, or lies inside membersRoot', () => {
    mkdirSync(membersRoot(), { recursive: true })
    for (const path of [membersRoot(), temp.base, join(membersRoot(), 'legacy')]) {
      expect(() => open([seedFor(ALICE, path)])).toThrow('console-members: rootSeeds[0] overlaps membersRoot')
    }
  })
})

describe('the row\'s state directory', () => {
  const state = (): string => dirname(rootsFile())

  it('refuses a membersRoot that is, contains, or lies inside the directory holding roots.json', () => {
    for (const members of [state(), temp.home, join(state(), 'members')]) {
      const options = { file: rootsFile(), membersRoot: members, seeds: [], platform: process.platform, logger: logger() }
      const error = thrown(() => openRootRegistry(options))
      expect(error.message).toBe(`console-members: membersRoot overlaps the row's state directory ${state()}`)
    }
    expect(existsSync(state())).toBe(false)
  })

  it('refuses a seed that is, contains, or lies inside that directory, naming no principal key', () => {
    for (const path of [state(), temp.home, join(state(), 'stores')]) {
      const error = thrown(() => open([seedFor(ALICE, path)]))
      expect(error.message).toBe(`console-members: rootSeeds[0] overlaps the row's state directory ${state()}`)
      expect(error.message).not.toContain(ALICE)
    }
    expect(() => open([unowned(temp.home)])).toThrow('console-members: rootSeeds[0] overlaps the row\'s state directory')
    expect(existsSync(rootsFile())).toBe(false)
  })

  it('refuses a membersRoot or a seed at the real path of a Harness home reached through a symbolic link', () => {
    mkdirSync(temp.home, { recursive: true })
    const linkedHome = join(temp.base, 'linked-home')
    mkdirSync(temp.base, { recursive: true })
    symlinkSync(temp.home, linkedHome)
    const file = join(linkedHome, 'console-members', 'roots.json')
    const linkedState = dirname(file)

    const members = thrown(() => openRootRegistry({ file, membersRoot: state(), seeds: [], platform: process.platform, logger: logger() }))
    expect(members.message).toBe(`console-members: membersRoot overlaps the row's state directory ${linkedState}`)
    const seeds = [seedFor(ALICE, temp.home)]
    const seed = thrown(() => openRootRegistry({ file, membersRoot: membersRoot(), seeds, platform: process.platform, logger: logger() }))
    expect(seed.message).toBe(`console-members: rootSeeds[0] overlaps the row's state directory ${linkedState}`)
    expect(existsSync(linkedState)).toBe(false)
  })

  it('refuses a recorded root that overlaps that directory', () => {
    mkdirSync(state(), { recursive: true })
    writeFileSync(rootsFile(), `{"version":1,"roots":[{"kind":"none","path":"${temp.home}"}]}`)
    expect(() => open()).toThrow(`console-members: root 0 in ${rootsFile()} overlaps the row's state directory`)
  })
})

describe('comparing roots as the file system reads them', () => {
  it('folds letter case and Unicode forms on macOS and Windows', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(() => open([seedFor(ALICE, join(temp.base, 'Alpha')), unowned(join(temp.base, 'alpha'))], platform))
        .toThrow(/rootSeeds\[1\] names a directory rootSeeds\[0\] registers to another owner/)
      expect(() => open([seedFor(ALICE, join(temp.base, 'Straße')), seedFor(BOB, join(temp.base, 'STRASSE'))], platform))
        .toThrow(/rootSeeds\[1\] names a directory rootSeeds\[0\] registers to another owner/)
      expect(() => open([seedFor(ALICE, join(temp.base, 'Café')), seedFor(BOB, join(temp.base, 'café', 'menu'))], platform))
        .toThrow(/rootSeeds\[1\] and rootSeeds\[0\] lie one inside the other/)
    }
  })

  it('keeps names that differ only in case apart on Linux', () => {
    const registry = open([seedFor(ALICE, join(temp.base, 'Alpha')), seedFor(BOB, join(temp.base, 'alpha'))], 'linux')

    expect(registry.rootsOf(ALICE)).toEqual([join(temp.base, 'Alpha')])
    expect(registry.rootsOf(BOB)).toEqual([join(temp.base, 'alpha')])
  })

  it.runIf(process.platform === 'darwin')('reads an existing directory under another letter case as that directory on this volume', () => {
    const real = directory('Projects')
    const alias = join(temp.base, 'PROJECTS')

    expect(() => open([seedFor(ALICE, real), seedFor(BOB, alias)])).toThrow(/registers to another owner/)
    expect(open([seedFor(ALICE, real), seedFor(ALICE, alias)]).rootsOf(ALICE)).toEqual([real])
  })

  it('reads a symbolic link to a root as that root', () => {
    const real = directory('real')
    const link = join(temp.base, 'link')
    symlinkSync(real, link)

    expect(() => open([seedFor(ALICE, real), unowned(link)])).toThrow(/rootSeeds\[1\] names a directory rootSeeds\[0\] registers/)
    expect(open([seedFor(ALICE, link), seedFor(ALICE, real)]).rootsOf(ALICE)).toEqual([real])
  })

  it('reads a root that does not exist yet under a linked directory as a path inside the link target', () => {
    const real = directory('real')
    const link = join(temp.base, 'link')
    symlinkSync(real, link)

    expect(() => open([seedFor(ALICE, real), seedFor(BOB, join(link, 'later', 'deeper'))]))
      .toThrow('console-members: rootSeeds[1] and rootSeeds[0] lie one inside the other')
  })

  it('reads two spellings of one directory as one root', () => {
    const real = directory('real')
    const spellings = [join(temp.base, 'missing', '..', 'real'), `${real}/`]

    expect(() => open([seedFor(ALICE, spellings[0]!), seedFor(BOB, spellings[1]!)])).toThrow(/registers to another owner/)
    expect(open([seedFor(ALICE, spellings[0]!), seedFor(ALICE, spellings[1]!)]).rootsOf(ALICE)).toEqual([real])
  })

  it('refuses a root reached through a symbolic link whose target does not exist, naming no path', () => {
    const dangling = join(temp.base, 'dangling')
    mkdirSync(temp.base, { recursive: true })
    symlinkSync(join(temp.base, 'nowhere'), dangling)

    const error = thrown(() => open([seedFor(ALICE, join(dangling, 'root'))]))
    expect(error.message).toBe('console-members: a root path leads through a symbolic link whose target does not exist')
  })
})

describe('reading roots.json', () => {
  const MARKER = 'login-uid-marker-4242'

  function store(text: string): void {
    mkdirSync(dirname(rootsFile()), { recursive: true })
    writeFileSync(rootsFile(), text)
  }

  it('refuses text that is not JSON without quoting it, where the parser\'s own message does', () => {
    const text = `{"version":1,"roots":[{"kind":"seed","path":"/r","principal":${MARKER}}]}`
    const quoted = MARKER.slice(0, 10)
    expect(() => { JSON.parse(text) }).toThrow(quoted)
    store(text)

    const error = thrown(() => open())
    expect(error.message).toBe(`console-members: ${rootsFile()} is not valid JSON`)
    expect(String(error.stack)).not.toContain(quoted)
  })

  it.each([
    ['an array', '[]'],
    ['another version', '{"version":2,"roots":[]}'],
    ['no roots', '{"version":1}'],
  ])('refuses %s', (_name, text) => {
    store(text)
    expect(() => open()).toThrow(`console-members: ${rootsFile()} is not a version 1 root registry`)
  })

  it.each([
    ['a non-object entry', '"x"'],
    ['an entry without a path', `{"kind":"seed","principal":"${MARKER}"}`],
    ['a relative path', `{"kind":"seed","path":"relative","principal":"${MARKER}"}`],
    ['an unknown kind', `{"kind":"other","path":"/r","principal":"${MARKER}"}`],
    ['an unowned entry with a principal', `{"kind":"none","path":"/r","principal":"${MARKER}"}`],
    ['a seed with an empty principal', '{"kind":"seed","path":"/r","principal":""}'],
    ['a seed with an extra field', `{"kind":"seed","path":"/r","principal":"${MARKER}","extra":1}`],
    ['a member without a directory id', `{"kind":"member","path":"/r","principal":"${MARKER}"}`],
    ['a member with a non-UUID directory id', `{"kind":"member","path":"/r","principal":"${MARKER}","directory":"${MARKER}"}`],
  ])('refuses %s, quoting none of it', (_name, entry) => {
    store(`{"version":1,"roots":[${entry}]}`)
    const error = thrown(() => open())
    expect(error.message).toBe(`console-members: entry 0 in ${rootsFile()} is not a root record`)
  })

  it('refuses a second member root for one member', () => {
    const entry = (directory: string): string =>
      `{"kind":"member","path":"${join(membersRoot(), directory)}","principal":"${MARKER}","directory":"${directory}"}`
    store(`{"version":1,"roots":[${entry('00000000-0000-4000-8000-000000000001')},${entry('00000000-0000-4000-8000-000000000002')}]}`)

    const error = thrown(() => open())
    expect(error.message).toBe(`console-members: entry 1 in ${rootsFile()} registers a second root for one member`)
  })

  it('refuses two member records with one directory id, so no two members share a store', () => {
    const directoryId = '00000000-0000-4000-8000-000000000009'
    const entry = (member: string, parent: string): string =>
      `{"kind":"member","path":"${join(temp.base, parent, directoryId)}","principal":"${member}","directory":"${directoryId}"}`
    store(`{"version":1,"roots":[${entry(`${MARKER}-a`, 'one')},${entry(`${MARKER}-b`, 'two')}]}`)

    const error = thrown(() => open())
    expect(error.message).toBe(`console-members: entry 1 in ${rootsFile()} reuses a directory id`)
    expect(error.message).not.toContain(MARKER)
  })

  it('refuses recorded roots that overlap each other or membersRoot', () => {
    const outer = join(temp.base, 'outer')
    store(`{"version":1,"roots":[{"kind":"none","path":"${outer}"},{"kind":"none","path":"${join(outer, 'inner')}"}]}`)
    expect(() => open()).toThrow(`console-members: roots 0 and 1 in ${rootsFile()} overlap`)

    store(`{"version":1,"roots":[{"kind":"none","path":"${join(membersRoot(), 'x')}"}]}`)
    expect(() => open()).toThrow(`console-members: root 0 in ${rootsFile()} overlaps membersRoot`)

    const directoryId = '00000000-0000-4000-8000-000000000003'
    store(`{"version":1,"roots":[{"kind":"member","path":"${temp.base}","principal":"${MARKER}","directory":"${directoryId}"}]}`)
    expect(() => open()).toThrow(`console-members: root 0 in ${rootsFile()} overlaps membersRoot`)
  })

  it('keeps member roots recorded under an earlier membersRoot', () => {
    const directoryId = '00000000-0000-4000-8000-000000000004'
    const earlier = join(temp.base, 'earlier-members', directoryId)
    store(`{"version":1,"roots":[{"kind":"member","path":"${earlier}","principal":"${MARKER}","directory":"${directoryId}"}]}`)

    expect(open().memberRoot(principal(MARKER))).toBe(earlier)
  })

  it('passes on a failure to read the file other than its absence', () => {
    mkdirSync(rootsFile(), { recursive: true })
    expect(() => open()).toThrow(/EISDIR/)
  })
})
