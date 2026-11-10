/** Actual publish entry with private files and real POSIX server commands. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { expectedArtifacts } from '../scripts/artifact-names.ts'
import { runPublish, type PublishOptions } from '../scripts/publish-update.ts'
import { PublishTransaction } from '../scripts/publish-transaction.ts'
import type { ReleaseManifest, ReleaseManifestArtifact } from '../scripts/release-manifest.ts'
import type { ReleaseIdentity, ReleasePlatform } from '../src/release-identity.ts'

const WORKTREE = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const REVISION = '0123456789abcdef0123456789abcdef01234567'

function identity(sequence: number, kind: 'bridge' | 'standard' = 'standard', runtime = '0.2.2-rc.1', version = '0.2.2-rc.4'): ReleaseIdentity {
  return { version: kind === 'bridge' ? version : runtime, dshRelease: { schemaVersion: 2, buildSequence: sequence, revision: REVISION, runtimeVersion: runtime, kind } }
}

function digest(bytes: string): string { return createHash('sha512').update(bytes).digest('base64') }

/** One command's completion includes closed streams, including injected stdin. */
function shell(script: string, path?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', ['-c', script], { stdio: [path === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code) => { if (code === 0) resolvePromise(stdout); else reject(new Error(`shell exit ${String(code)}: ${stderr}`)) })
    if (path !== undefined && child.stdin !== null) {
      const source = createReadStream(path)
      source.once('error', (error) => { child.kill(); reject(error) })
      child.stdin.once('error', (error) => { source.destroy(); child.kill(); reject(error) })
      source.pipe(child.stdin)
    }
  })
}

interface Fixture {
  root: string
  remote: string
  commands: string[]
  options: PublishOptions
  build(target: ReleaseIdentity, platforms?: readonly ReleasePlatform[]): Promise<{
    argv: string[]
    manifest: ReleaseManifest
    dist: string
  }>
}

/** Fixture data and recovery copies stay inside the worktree for failure review. */
async function fixture(): Promise<Fixture> {
  await mkdir(join(WORKTREE, '.local'), { recursive: true })
  const root = await mkdtemp(join(WORKTREE, '.local/publish-transaction-'))
  const remote = join(root, 'remote')
  await mkdir(remote)
  const commands: string[] = []
  const options: PublishOptions = {
    distDir: '', remoteRoot: remote, feedBase: 'https://fixture.invalid/feed',
    executeRemote: async (script) => { commands.push(script); return shell(script) },
    sendFile: async (path, script) => { commands.push(script); await shell(script, path) },
    capture: async (command, args) => {
      if (command !== 'git') throw new Error(`unexpected local command ${command}`)
      if (args.includes('for-each-ref')) return `refs/tags/desktop-old ${REVISION} ${REVISION}\n`
      if (args.includes('remote')) return ''
      throw new Error(`unexpected Git command ${args.join(' ')}`)
    },
    fetch: async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const path = join(remote, decodeURIComponent(url.pathname.replace(/^\/feed\//u, '')))
      return new Response(await readFile(path, 'utf8'))
    },
    // Native archive readers are covered by build-release tests; this adapter
    // reads explicit payload metadata so publishing still invokes verification.
    verifyPackage: async (input) => {
      for (const artifact of input.artifacts.filter(entry => !entry.fileName.endsWith('.blockmap'))) {
        const payload: unknown = JSON.parse(await readFile(join(input.distDir, artifact.fileName), 'utf8'))
        expect(payload).toEqual(input.identity)
      }
    },
  }
  const build: Fixture['build'] = async (target, platforms = ['darwin']) => {
    const dist = await mkdtemp(join(root, 'build-'))
    const artifacts: Record<ReleasePlatform, ReleaseManifestArtifact[]> = { darwin: [], win32: [] }
    for (const platform of platforms) {
      for (const fileName of expectedArtifacts(target, { mac: platform === 'darwin', win: platform === 'win32' })) {
        const bytes = JSON.stringify(target)
        await writeFile(join(dist, fileName), bytes)
        artifacts[platform].push({ fileName, sha512: digest(bytes), size: Buffer.byteLength(bytes) })
      }
      const files = artifacts[platform].filter(artifact => !artifact.fileName.endsWith('.blockmap')).map(artifact => ({ url: artifact.fileName, sha512: artifact.sha512, size: artifact.size }))
      await writeFile(join(dist, platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'), dump({ version: target.version, files, path: files[0]?.url, sha512: files[0]?.sha512 }))
    }
    const manifest: ReleaseManifest = { ...target, platforms: { darwin: { arch: 'arm64', artifacts: artifacts.darwin }, win32: { arch: 'x64', artifacts: artifacts.win32 } } }
    const manifestPath = join(dist, 'release.json')
    const notesPath = join(dist, 'notes.md')
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(notesPath, 'Release notes\n')
    return { dist, manifest, argv: ['--release-manifest', manifestPath, '--notes', notesPath, '--channel', platforms.length === 2 ? 'all' : platforms[0] === 'darwin' ? 'mac' : 'win', '--no-tag', '--no-prune'] }
  }
  return { root, remote, commands, options, build }
}

async function publish(f: Fixture, build: Awaited<ReturnType<Fixture['build']>>, overrides: Partial<PublishOptions> = {}, flags: string[] = []): Promise<void> {
  await runPublish([...build.argv, ...flags], { ...f.options, distDir: build.dist, ...overrides })
}

function latch(): { promise: Promise<void>; open(): void } {
  let open = (): void => { throw new Error('latch not initialized') }
  const promise = new Promise<void>((resolvePromise) => { open = resolvePromise })
  return { promise, open }
}

/** Remote production commands require POSIX; all test roots are independently allocated. */
describe.skipIf(process.platform === 'win32')('publish entry transactions', () => {
  it('holds the actual remote lock from preflight through pointer readback under interleaving', async () => {
    const f = await fixture()
    const newer = await f.build(identity(102))
    const older = await f.build(identity(101))
    const entered = latch()
    const resume = latch()
    let held = false
    const first = publish(f, newer, { executeRemote: async (script) => {
      const result = await f.options.executeRemote(script)
      if (!held && script.includes("printf 'acquired")) { held = true; entered.open(); await resume.promise }
      return result
    } })
    try {
      await entered.promise
      await expect(publish(f, older)).rejects.toMatchObject({ code: 'PUBLISH_LOCKED' })
      expect(existsSync(join(f.remote, 'v2/mac/latest-mac.yml'))).toBe(false)
    } finally { resume.open(); await first }
    await expect(publish(f, older)).rejects.toMatchObject({ code: 'PUBLISH_REFUSED' })
    const feed: unknown = load(await readFile(join(f.remote, 'v2/mac/latest-mac.yml'), 'utf8'))
    expect(feed).toMatchObject({ dshRelease: { buildSequence: 102 } })
    expect(existsSync(join(f.remote, '.publish-lock'))).toBe(false)
    expect(f.commands.filter(command => command.includes('mv -f'))).toHaveLength(1)
  })

  it('uses unique temporary names and never rewrites final artifacts on republish', async () => {
    const f = await fixture()
    const build = await f.build(identity(101))
    const source = await readFile(join(build.dist, 'latest-mac.yml'), 'utf8')
    await publish(f, build)
    const firstWrites = f.commands.filter(command => command.includes('cat >'))
    f.commands.length = 0
    await publish(f, build, {}, ['--republish'])
    const secondWrites = f.commands.filter(command => command.includes('cat >'))
    expect(secondWrites).toHaveLength(1)
    expect(secondWrites[0]).not.toBe(firstWrites.at(-1))
    expect(f.commands.some(command => command.includes('ln ') && !command.includes('.releases'))).toBe(false)
    expect(await readFile(join(build.dist, 'latest-mac.yml'), 'utf8')).toBe(source)
    expect((await readdir(build.dist)).filter(name => name.startsWith('.publish-'))).toHaveLength(2)
  })

  it('rejects an immutable collision instead of replacing existing bytes', async () => {
    const f = await fixture()
    const build = await f.build(identity(101))
    const name = build.manifest.platforms.darwin.artifacts[0]?.fileName
    if (name === undefined) throw new Error('fixture artifact missing')
    await mkdir(join(f.remote, 'v2/mac'), { recursive: true })
    await writeFile(join(f.remote, 'v2/mac', name), 'someone else')
    await expect(publish(f, build)).rejects.toMatchObject({ code: 'PUBLISH_REFUSED' })
    expect(await readFile(join(f.remote, 'v2/mac', name), 'utf8')).toBe('someone else')
    expect(f.commands.some(command => command.includes('mv -f'))).toBe(false)
  })

  it('binds a sequence across protocols, platforms, versions and retained history', async () => {
    const f = await fixture()
    await publish(f, await f.build(identity(100, 'bridge')))
    await publish(f, await f.build(identity(101, 'bridge', '0.2.2-rc.1', '0.2.2-rc.5')))
    const historicalReuse = await f.build(identity(100, 'bridge', '0.2.2-rc.1', '0.2.2-rc.6'), ['win32'])
    await expect(publish(f, historicalReuse)).rejects.toMatchObject({ code: 'PUBLISH_REFUSED' })
    await expect(publish(f, await f.build(identity(100), ['win32']))).rejects.toMatchObject({ code: 'PUBLISH_REFUSED' })
    expect(await readdir(join(f.remote, '.releases'))).toEqual(expect.arrayContaining(['b100.json', 'b101.json']))
  })

  it('adds an independently built platform to one identity and refuses changed bytes for an existing platform', async () => {
    const f = await fixture()
    const target = identity(101)
    const mac = await f.build(target, ['darwin'])
    const win = await f.build(target, ['win32'])
    await publish(f, mac)
    await publish(f, win)
    expect(load(await readFile(join(f.remote, 'v2/mac/latest-mac.yml'), 'utf8'))).toMatchObject(target)
    expect(load(await readFile(join(f.remote, 'v2/win/latest.yml'), 'utf8'))).toMatchObject(target)
    expect(await readdir(join(f.remote, '.releases'))).toEqual(expect.arrayContaining([
      'b101.json', 'b101-darwin.inventory.json', 'b101-win32.inventory.json',
    ]))
    const changed = await f.build(target, ['darwin'])
    const bytes = `${JSON.stringify(target)}\n`
    const artifacts = changed.manifest.platforms.darwin.artifacts.map(artifact => ({
      ...artifact, sha512: digest(bytes), size: Buffer.byteLength(bytes),
    }))
    for (const artifact of artifacts) await writeFile(join(changed.dist, artifact.fileName), bytes)
    await writeFile(join(changed.dist, 'release.json'), JSON.stringify({
      ...changed.manifest, platforms: { ...changed.manifest.platforms, darwin: { arch: 'arm64', artifacts } },
    }))
    f.commands.length = 0
    const operation = publish(f, changed, {}, ['--republish'])
    await expect(operation).rejects.toMatchObject({ code: 'PUBLISH_REFUSED' })
    await expect(operation).rejects.toThrow('bytes are permanently assigned')
    expect(f.commands.some(command => command.includes('cat >') || command.includes('mv -f'))).toBe(false)
  })

  it('keeps the original refusal when releasing its lock also fails', async () => {
    const f = await fixture()
    await publish(f, await f.build(identity(102)))
    const older = await f.build(identity(101))
    const operation = publish(f, older, { executeRemote: async (script) => {
      if (script.includes('rmdir')) throw new Error('lost release response')
      return f.options.executeRemote(script)
    } })
    await expect(operation).rejects.toMatchObject({ code: 'PUBLISH_UNKNOWN' })
    await expect(operation).rejects.toThrow('build sequence would move backwards')
    await expect(operation).rejects.toHaveProperty('cause', expect.any(AggregateError))
    expect(existsSync(join(f.remote, '.publish-lock'))).toBe(true)
  })

  it('allows N1 on v2 before the lower-sequence bridge on v1', async () => {
    const f = await fixture()
    await publish(f, await f.build(identity(101)))
    await publish(f, await f.build(identity(100, 'bridge')))
    expect(load(await readFile(join(f.remote, 'mac/latest-mac.yml'), 'utf8'))).toMatchObject({ version: '0.2.2-rc.4' })
    expect(load(await readFile(join(f.remote, 'v2/mac/latest-mac.yml'), 'utf8'))).toMatchObject({ dshRelease: { buildSequence: 101 } })
  })

  it.each([
    { first: 'bridge', platform: 'darwin', violation: 'runtime' },
    { first: 'standard', platform: 'darwin', violation: 'runtime' },
    { first: 'bridge', platform: 'win32', violation: 'runtime' },
    { first: 'standard', platform: 'win32', violation: 'runtime' },
    { first: 'bridge', platform: 'darwin', violation: 'sequence' },
    { first: 'standard', platform: 'darwin', violation: 'sequence' },
    { first: 'bridge', platform: 'win32', violation: 'sequence' },
    { first: 'standard', platform: 'win32', violation: 'sequence' },
  ] as const)('refuses $platform bridge-to-v2 $violation rollback with $first published first', async ({ first, platform, violation }) => {
    const f = await fixture()
    const bridge = violation === 'runtime' ? identity(100, 'bridge', '0.2.2-rc.2') : identity(102, 'bridge')
    const standard = identity(101, 'standard', '0.2.2-rc.1')
    await publish(f, await f.build(first === 'bridge' ? bridge : standard, [platform]))
    const target = await f.build(first === 'bridge' ? standard : bridge, [platform])
    f.commands.length = 0
    const operation = publish(f, target)
    await expect(operation).rejects.toMatchObject({ code: 'PUBLISH_REFUSED' })
    await expect(operation).rejects.toThrow(violation === 'runtime'
      ? 'bridge-to-v2 runtime would move backwards'
      : 'bridge-to-v2 build sequence must increase')
    expect(f.commands.some(command => command.includes('cat >') || command.includes('mv -f') || command.includes('cp -p'))).toBe(false)
    expect(existsSync(join(f.remote, '.publish-lock'))).toBe(false)
  })

  it.each(['bridge', 'standard'] as const)('allows an increasing bridge-to-v2 runtime with %s published first', async (first) => {
    const f = await fixture()
    const bridge = identity(100, 'bridge', '0.2.2-rc.1')
    const standard = identity(101, 'standard', '0.2.2-rc.2')
    await publish(f, await f.build(first === 'bridge' ? bridge : standard))
    await publish(f, await f.build(first === 'bridge' ? standard : bridge))
    expect(load(await readFile(join(f.remote, 'v2/mac/latest-mac.yml'), 'utf8'))).toMatchObject(standard)
    expect(load(await readFile(join(f.remote, 'mac/latest-mac.yml'), 'utf8'))).toMatchObject({ version: bridge.version })
  })

  it('rejects runtime rollback before upload or red-line publication', async () => {
    const f = await fixture()
    await publish(f, await f.build(identity(101, 'standard', '0.2.2-rc.2')))
    f.commands.length = 0
    await expect(publish(f, await f.build(identity(102)), {}, ['--minimum-build-sequence', '102'])).rejects.toMatchObject({ code: 'PUBLISH_REFUSED' })
    expect(f.commands.some(command => command.includes('cat >') || command.includes('mv -f'))).toBe(false)
  })

  it('rejects same-version mixed inventories and old builder feeds before any remote mutation', async () => {
    const f = await fixture()
    const old = await f.build(identity(101))
    const target = await f.build(identity(102))
    const mixed = { ...target.manifest, platforms: { ...target.manifest.platforms, darwin: { arch: 'arm64', artifacts: [...target.manifest.platforms.darwin.artifacts, ...old.manifest.platforms.darwin.artifacts] } } }
    await writeFile(join(target.dist, 'release.json'), JSON.stringify(mixed))
    await expect(publish(f, target)).rejects.toMatchObject({ code: 'PUBLISH_REFUSED' })
    expect(f.commands).toHaveLength(0)
    await writeFile(join(target.dist, 'release.json'), JSON.stringify(target.manifest))
    await writeFile(join(target.dist, 'latest-mac.yml'), await readFile(join(old.dist, 'latest-mac.yml')))
    await expect(publish(f, target)).rejects.toMatchObject({ code: 'PUBLISH_REFUSED' })
    expect(f.commands.some(command => command.includes('cat >') || command.includes('mv -f'))).toBe(false)
  })

  it('calls the archive verifier before acquiring a remote lock', async () => {
    const f = await fixture()
    await expect(publish(f, await f.build(identity(101)), { verifyPackage: async () => { throw new Error('embedded build is 100') } })).rejects.toThrow('embedded build is 100')
    expect(f.commands).toHaveLength(0)
  })

  it('backs up old v1 manifests, implicit historical blockmaps and tag refs before replacing', async () => {
    const f = await fixture()
    const old = await f.build(identity(100, 'bridge'))
    await publish(f, old)
    const oldFeed = await readFile(join(f.remote, 'mac/latest-mac.yml'), 'utf8')
    const historical = expectedArtifacts(identity(99, 'bridge', '0.2.2-rc.1', '0.2.2-rc.3'), { mac: true, win: false })
    for (const name of historical) await writeFile(join(f.remote, 'mac', name), 'old download dependency')
    f.commands.length = 0
    await publish(f, await f.build(identity(101, 'bridge', '0.2.2-rc.1', '0.2.2-rc.5')))
    const recoveryRoots = await readdir(join(f.remote, '.recovery'))
    let matched = false
    for (const attempt of recoveryRoots) {
      const root = join(f.remote, '.recovery', attempt)
      if (!existsSync(join(root, 'mac/latest-mac.yml'))) continue
      expect(await readFile(join(root, 'mac/latest-mac.yml'), 'utf8')).toBe(oldFeed)
      for (const name of historical) expect(await readFile(join(root, 'mac', name), 'utf8')).toBe('old download dependency')
      const metadata = (await readdir(root)).find(name => name.startsWith('inventory-'))
      if (metadata === undefined) throw new Error('recovery inventory missing')
      expect(await readFile(join(root, metadata), 'utf8')).toContain('refs/tags/desktop-old')
      matched = true
    }
    expect(matched).toBe(true)
    const commit = f.commands.findIndex(command => command.includes('mv -f'))
    expect(f.commands.slice(0, commit).some(command => command.includes('cp -p'))).toBe(true)
  })

  it('refuses pointer replacement when recovery copies do not verify', async () => {
    const f = await fixture()
    await publish(f, await f.build(identity(100, 'bridge')))
    const pointer = join(f.remote, 'mac/latest-mac.yml')
    const previous = await readFile(pointer, 'utf8')
    f.commands.length = 0
    let corrupted = false
    await expect(publish(f, await f.build(identity(101, 'bridge', '0.2.2-rc.1', '0.2.2-rc.5')), {
      executeRemote: async (script) => {
        const answer = await f.options.executeRemote(script)
        if (!corrupted && script.includes('cp -p')) {
          const copies = script.match(/'([^']+\/\.recovery\/[^']+)'/gu)
          const target = copies?.at(-1)?.slice(1, -1)
          if (target === undefined) throw new Error('backup destination missing')
          await writeFile(target, 'corrupt copy')
          corrupted = true
        }
        return answer
      },
    })).rejects.toMatchObject({ code: 'PUBLISH_REFUSED' })
    expect(corrupted).toBe(true)
    expect(await readFile(pointer, 'utf8')).toBe(previous)
    expect(f.commands.some(command => command.includes('mv -f') || command.includes('rm -f'))).toBe(false)
  })

  it('reads back a completed rename after response loss and retains reconciliation ownership', async () => {
    const f = await fixture()
    const build = await f.build(identity(101))
    const operation = publish(f, build, { executeRemote: async (script) => {
      const answer = await f.options.executeRemote(script)
      if (script.includes('mv -f')) throw new Error('SSH response lost after rename')
      return answer
    } })
    await expect(operation).rejects.toMatchObject({ code: 'PUBLISH_UNKNOWN' })
    await expect(operation).rejects.toThrow('target pointers and client URLs verified on mac')
    expect(f.commands.filter(command => command.includes('mv -f'))).toHaveLength(1)
    expect(load(await readFile(join(f.remote, 'v2/mac/latest-mac.yml'), 'utf8'))).toMatchObject({ dshRelease: { buildSequence: 101 } })
    expect(existsSync(join(f.remote, '.publish-lock'))).toBe(true)
    await expect(publish(f, build, {}, ['--republish'])).rejects.toMatchObject({ code: 'PUBLISH_LOCKED' })
  })

  it('retains unknown pointer outcome when post-rename readback is unavailable', async () => {
    const f = await fixture()
    let lost = false
    const operation = publish(f, await f.build(identity(101)), { executeRemote: async (script) => {
      if (lost) throw new Error('SSH offline')
      const answer = await f.options.executeRemote(script)
      if (script.includes('mv -f')) { lost = true; throw new Error('lost reply') }
      return answer
    } })
    await expect(operation).rejects.toMatchObject({ code: 'PUBLISH_UNKNOWN' })
    await expect(operation).rejects.not.toThrow('no manifest pointer was switched')
    expect(existsSync(join(f.remote, 'v2/mac/latest-mac.yml'))).toBe(true)
    expect(existsSync(join(f.remote, '.publish-lock'))).toBe(true)
  })

  it('preserves a confirmed platform when the next platform rename fails', async () => {
    const f = await fixture()
    const build = await f.build(identity(101), ['darwin', 'win32'])
    const operation = publish(f, build, { executeRemote: async (script) => {
      if (script.includes('mv -f') && script.includes('/mac/')) throw new Error('second platform unavailable')
      return f.options.executeRemote(script)
    } })
    await expect(operation).rejects.toMatchObject({ code: 'PUBLISH_UNKNOWN' })
    await expect(operation).rejects.toThrow('confirmed pointers: win')
    expect(existsSync(join(f.remote, 'v2/win/latest.yml'))).toBe(true)
    expect(existsSync(join(f.remote, 'v2/mac/latest-mac.yml'))).toBe(false)
  })

  it('reports an upload interruption without releasing ownership or switching a pointer', async () => {
    const f = await fixture()
    await expect(publish(f, await f.build(identity(101)), { sendFile: async (path, script) => {
      await f.options.sendFile(path, script)
      throw new Error('upload acknowledgement lost')
    } })).rejects.toMatchObject({ code: 'PUBLISH_UNKNOWN' })
    expect(existsSync(join(f.remote, '.publish-lock'))).toBe(true)
    expect(existsSync(join(f.remote, 'v2/mac/latest-mac.yml'))).toBe(false)
    expect(f.commands.some(command => command.includes('rm -f'))).toBe(false)
  })

  it('requires verified recovery before explicit v2 pruning and retains those copies', async () => {
    const f = await fixture()
    for (const sequence of [100, 101, 102, 103]) await publish(f, await f.build(identity(sequence)))
    const target = await f.build(identity(104))
    target.argv = target.argv.filter(value => value !== '--no-prune')
    f.commands.length = 0
    await publish(f, target, {}, ['--prune'])
    const deletes = f.commands.filter(command => command.includes('rm -f'))
    expect(deletes.length).toBeGreaterThan(0)
    for (const deletion of deletes) {
      const position = f.commands.indexOf(deletion)
      expect(f.commands.slice(0, position).some(command => command.includes('cp -p') && command.includes('.recovery/'))).toBe(true)
    }
    expect((await readdir(join(f.remote, '.releases'))).filter(name => /^b\d+\.json$/u.test(name))).toHaveLength(5)
    const oldName = expectedArtifacts(identity(100), { mac: true, win: false })[0]
    if (oldName === undefined) throw new Error('missing artifact')
    const copies = await readdir(join(f.remote, '.recovery'))
    expect(copies.some(attempt => existsSync(join(f.remote, '.recovery', attempt, 'v2/mac', oldName)))).toBe(true)
  })

  it('dry-run and help do not upload, mutate local feeds or acquire a lock', async () => {
    const f = await fixture()
    const build = await f.build(identity(101))
    const source = await readFile(join(build.dist, 'latest-mac.yml'), 'utf8')
    await publish(f, build, {}, ['--dry-run'])
    expect(await readFile(join(build.dist, 'latest-mac.yml'), 'utf8')).toBe(source)
    expect(f.commands.some(command => command.includes('mkdir') || command.includes('mv -f') || command.includes('cat >'))).toBe(false)
    f.commands.length = 0
    await runPublish(['--help'], f.options)
    expect(f.commands).toHaveLength(0)
  })
})

describe.skipIf(process.platform === 'win32')('remote transaction primitives', () => {
  it('cannot replace an immutable destination created after the existence check', async () => {
    const f = await fixture()
    const transaction = new PublishTransaction(f.remote, { execute: script => f.options.executeRemote(script) })
    await transaction.acquire()
    const finalPath = join(f.remote, 'immutable')
    const staged = transaction.stagedPath(finalPath)
    await writeFile(staged, 'target')
    expect(await transaction.fileState(finalPath)).toEqual({ kind: 'absent' })
    await writeFile(finalPath, 'competitor')
    await expect(transaction.commitImmutable(staged, finalPath, { sha512: createHash('sha512').update('target').digest('hex'), size: 6 })).rejects.toMatchObject({ code: 'PUBLISH_UNKNOWN' })
    expect(await readFile(finalPath, 'utf8')).toBe('competitor')
    expect(await readFile(staged, 'utf8')).toBe('target')
    await transaction.release()
    expect(existsSync(transaction.lockPath)).toBe(true)
  })

  it('refuses deletion after a verified recovery copy changes', async () => {
    const f = await fixture()
    const transaction = new PublishTransaction(f.remote, { execute: script => f.options.executeRemote(script) })
    await transaction.acquire()
    const target = join(f.remote, 'artifact')
    await writeFile(target, 'artifact')
    await transaction.backup([target], 'tag snapshot')
    await writeFile(join(transaction.recoveryPath, 'artifact'), 'damaged')
    await expect(transaction.prune([target])).rejects.toMatchObject({ code: 'PUBLISH_REFUSED' })
    expect(await readFile(target, 'utf8')).toBe('artifact')
    await transaction.release()
  })

  it('rejects a symlinked ancestor before replacing or pruning its target', async () => {
    const f = await fixture()
    const outside = join(f.root, 'unrelated')
    await mkdir(outside)
    await writeFile(join(outside, 'pointer'), 'keep these bytes')
    await symlink(outside, join(f.remote, 'redirected'))
    const transaction = new PublishTransaction(f.remote, { execute: script => f.options.executeRemote(script) })
    await transaction.acquire()
    const target = join(f.remote, 'redirected/pointer')
    await expect(transaction.prune([target])).rejects.toMatchObject({ code: 'PUBLISH_UNKNOWN' })
    await expect(transaction.commitPointer(`${target}.part`, target, { sha512: 'unused', size: 0 })).rejects.toMatchObject({
      code: 'PUBLISH_UNKNOWN',
    })
    expect(await readFile(join(outside, 'pointer'), 'utf8')).toBe('keep these bytes')
    expect(f.commands.some(command => command.includes('rm -f') || command.includes('mv -f'))).toBe(false)
    await transaction.release()
  })

  it('allocates one lock across independent publisher processes', async () => {
    const f = await fixture()
    const transactionUrl = new URL('../scripts/publish-transaction.ts', import.meta.url).href
    const source = `import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { PublishTransaction } from ${JSON.stringify(transactionUrl)}; const exec = promisify(execFile); const tx = new PublishTransaction(process.argv[1], {execute: async script => (await exec('bash', ['-c', script])).stdout}); try { await tx.acquire(); process.send({kind:'acquired'}); process.once('message', async () => { await tx.release(); process.disconnect(); }); } catch (error) { process.send({kind:error.code}); process.disconnect(); }`
    const start = () => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source, f.remote], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      let stderr = ''
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      const closed = new Promise<void>((resolvePromise, reject) => { child.once('error', reject); child.once('close', (code) => { if (code === 0 || child.killed) resolvePromise(); else reject(new Error(stderr)) }) })
      const message = new Promise<unknown>((resolvePromise, reject) => { child.once('message', resolvePromise); child.once('error', reject); child.once('close', () => { reject(new Error(`closed before IPC: ${stderr}`)) }) })
      return { child, closed, message }
    }
    const first = start()
    let second: ReturnType<typeof start> | undefined
    try {
      expect(await first.message).toEqual({ kind: 'acquired' })
      second = start()
      expect(await second.message).toEqual({ kind: 'PUBLISH_LOCKED' })
      await second.closed
      first.child.send('release')
      await first.closed
      expect(existsSync(join(f.remote, '.publish-lock'))).toBe(false)
    } finally {
      if (first.child.exitCode === null) first.child.kill()
      if (second?.child.exitCode === null) second.child.kill()
      await Promise.all([first.closed, ...(second === undefined ? [] : [second.closed])])
    }
  })
})
