/** Packaging entry behavior, final bytes, staging reuse, and extracted metadata checks. */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  artifactSha512, buildRelease, collectReleaseArtifacts, recordBuildStaging, releaseBuilderArguments,
  verifyBuildSource, verifyBuildStaging, verifyExtractedRelease, verifyPackagedRelease, verifyRuntimeVersion,
  type ReleaseBuildOperations,
} from '../scripts/build-release.ts'
import { expectedArtifacts } from '../scripts/artifact-names.ts'
import { parseReleaseManifest, type ReleaseManifest } from '../scripts/release-manifest.ts'
import type { ReleaseIdentity } from '../src/release-identity.ts'

const execute = promisify(execFile)
const roots: string[] = []
const revision = '0123456789abcdef0123456789abcdef01234567'
const runtimeVersion = '0.2.2-rc.1'
const bridge: ReleaseIdentity = {
  version: '0.2.2-rc.4',
  dshRelease: { schemaVersion: 2, runtimeVersion, buildSequence: 100, revision, kind: 'bridge' },
}
const standard: ReleaseIdentity = {
  version: runtimeVersion,
  dshRelease: { ...bridge.dshRelease, buildSequence: 101, kind: 'standard' },
}

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-package-release-'))
  roots.push(root)
  return root
}

async function put(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function runtime(server: string, version = runtimeVersion): Promise<void> {
  await put(join(server, 'node_modules/@deepseek-ai/dsh-app-boot/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version }))
}

afterEach(async () => {
  // Every root is allocated atomically by this file's fixture and owned by this test.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function buildOperations(root: string): Promise<{
  operations: ReleaseBuildOperations
  calls: string[]
  output: () => ReleaseManifest | undefined
}> {
  const calls: string[] = []
  let output: ReleaseManifest | undefined
  const operations: ReleaseBuildOperations = {
    verifySource: vi.fn(async () => { calls.push('source') }),
    prepare: vi.fn(async () => { calls.push('prepare') }),
    build: vi.fn<ReleaseBuildOperations['build']>(async (platform, args) => {
      calls.push(`build:${platform}`)
      // These are the exact CLI arguments consumed by the installed builder.
      const require = createRequire(import.meta.url)
      const builder = require('electron-builder/out/builder.js') as {
        createYargs(): unknown
        configureBuildCommand(parser: unknown): { parse(args: string[]): unknown }
        normalizeOptions(args: unknown): { config: { extraMetadata: unknown } }
      }
      const parsed = builder.normalizeOptions(builder.configureBuildCommand(builder.createYargs()).parse(['--config', 'electron-builder.yml', ...args]))
      expect(parsed.config.extraMetadata).toEqual({ name: '@deepseek-ai/dsh-desktop', ...bridge })
      for (const file of expectedArtifacts(bridge, { mac: platform === 'darwin', win: platform === 'win32' })) {
        await put(join(root, file), `signed and compressed ${file}`)
      }
    }),
    inventory: (platform, identity, startedAt) => collectReleaseArtifacts(root, identity, platform, startedAt),
    verifyPackages: vi.fn<ReleaseBuildOperations['verifyPackages']>(async (platform, _identity, artifacts) => {
      calls.push(`verify:${platform}`)
      for (const artifact of artifacts) expect(await artifactSha512(join(root, artifact.fileName))).toBe(artifact.sha512)
    }),
    writeManifest: vi.fn<ReleaseBuildOperations['writeManifest']>(async (manifest) => {
      calls.push('manifest')
      output = manifest
      await put(join(root, 'release.json'), JSON.stringify(manifest))
    }),
  }
  return { operations, calls, output: () => output }
}

describe('release packaging entry', () => {
  it('packages a hash-free bridge request and records the final bytes only after all target checks', async () => {
    const root = await directory()
    const run = await buildOperations(root)
    const result = await buildRelease({ ...bridge, platforms: ['darwin', 'win32'] }, ['darwin', 'win32'], run.operations)
    expect(result).toEqual(run.output())
    expect(result.platforms.darwin.artifacts).toHaveLength(4)
    expect(result.platforms.win32.artifacts).toHaveLength(2)
    expect(run.calls).toEqual(['source', 'prepare', 'build:darwin', 'verify:darwin', 'build:win32', 'verify:win32', 'source', 'manifest'])
    expect(parseReleaseManifest(JSON.parse(await readFile(join(root, 'release.json'), 'utf8')))).toEqual(result)
    const file = result.platforms.win32.artifacts[0]!
    expect(file.size).toBe(Buffer.byteLength(`signed and compressed ${file.fileName}`))
  })

  it('keeps standard upstream version and does not apply bridge artifact names', () => {
    const args = releaseBuilderArguments(standard)
    expect(args).toContain(`-c.extraMetadata.version=${runtimeVersion}`)
    expect(args).toContain('-c.extraMetadata.dshRelease.buildSequence=101')
    expect(args.some(arg => arg.includes('artifactName'))).toBe(false)
  })

  it('refuses target drift before preparing source', async () => {
    const run = await buildOperations(await directory())
    await expect(buildRelease({ ...bridge, platforms: ['darwin'] }, ['win32'], run.operations)).rejects.toMatchObject({ code: 'BUILD_SOURCE_INVALID' })
    expect(run.calls).toEqual([])
  })

  it('stops before preparing when source revision validation fails', async () => {
    const run = await buildOperations(await directory())
    run.operations.verifySource = vi.fn(async () => { throw new Error('wrong revision') })
    await expect(buildRelease({ ...bridge, platforms: ['darwin'] }, ['darwin'], run.operations)).rejects.toThrow('wrong revision')
    expect(run.operations.prepare).not.toHaveBeenCalled()
    expect(run.operations.writeManifest).not.toHaveBeenCalled()
  })

  it('never writes a publish manifest after a package fails extracted metadata validation', async () => {
    const run = await buildOperations(await directory())
    run.operations.verifyPackages = vi.fn(async () => { throw new Error('missing embedded identity') })
    await expect(buildRelease({ ...bridge, platforms: ['darwin', 'win32'] }, ['darwin', 'win32'], run.operations)).rejects.toThrow('missing embedded identity')
    expect(run.operations.build).toHaveBeenCalledTimes(1)
    expect(run.operations.writeManifest).not.toHaveBeenCalled()
  })

  it('rechecks source after building and refuses a manifest if source moved', async () => {
    const run = await buildOperations(await directory())
    run.operations.verifySource = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('HEAD changed'))
    await expect(buildRelease({ ...bridge, platforms: ['win32'] }, ['win32'], run.operations)).rejects.toThrow('HEAD changed')
    expect(run.operations.writeManifest).not.toHaveBeenCalled()
  })

  it('rejects leftovers, empty artifacts, and missing final files', async () => {
    const root = await directory()
    const files = expectedArtifacts(standard, { mac: false, win: true })
    for (const name of files) await put(join(root, name), 'old bytes')
    for (const name of files) await utimes(join(root, name), 1, 1)
    await expect(collectReleaseArtifacts(root, standard, 'win32', Date.now())).rejects.toMatchObject({ code: 'BUILD_ARTIFACT_INVALID' })
    await put(join(root, files[0]!), '')
    await expect(collectReleaseArtifacts(root, standard, 'win32', 0)).rejects.toMatchObject({ code: 'BUILD_ARTIFACT_INVALID' })
    await expect(collectReleaseArtifacts(root, bridge, 'win32', 0)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails an actual Git source check before any build when revision differs', async () => {
    const root = new URL('../../../..', import.meta.url).pathname
    await expect(verifyBuildSource(root, bridge)).rejects.toMatchObject({ code: 'BUILD_SOURCE_INVALID' })
  })
})

describe('staging reuse', () => {
  it('accepts a recorded tree for another build of exactly the same source/runtime', async () => {
    const root = await directory()
    await runtime(root)
    await put(join(root, 'server.js'), 'export const build = 1\n')
    await recordBuildStaging(root, bridge)
    await expect(verifyBuildStaging(root, standard)).resolves.toBeUndefined()
  })

  it('refuses unstamped, differently sourced, and modified staging', async () => {
    const root = await directory()
    await runtime(root)
    await expect(verifyBuildStaging(root, bridge)).rejects.toMatchObject({ code: 'BUILD_STAGING_INVALID' })
    await recordBuildStaging(root, bridge)
    await expect(verifyBuildStaging(root, { ...bridge, dshRelease: { ...bridge.dshRelease, revision: 'f'.repeat(40) } })).rejects.toMatchObject({ code: 'BUILD_STAGING_INVALID' })
    await put(join(root, 'stale.js'), 'old deployment')
    await expect(verifyBuildStaging(root, bridge)).rejects.toMatchObject({ code: 'BUILD_STAGING_INVALID' })
  })

  it('reads the actual runtime package instead of accepting the external declaration', async () => {
    const root = await directory()
    await runtime(root, '0.2.2-rc.3')
    await expect(recordBuildStaging(root, bridge)).rejects.toMatchObject({ code: 'BUILD_RUNTIME_INVALID' })
    await expect(verifyRuntimeVersion(root, bridge)).rejects.toMatchObject({ code: 'BUILD_RUNTIME_INVALID' })
  })
})

function pe(machine = 0x8664): Buffer {
  const bytes = Buffer.alloc(80)
  bytes.write('MZ')
  bytes.writeUInt32LE(64, 60)
  bytes.writeUInt32LE(0x4550, 64)
  bytes.writeUInt16LE(machine, 68)
  return bytes
}

async function extracted(): Promise<string> {
  const root = await directory()
  const resources = join(root, 'resources')
  await runtime(join(resources, 'server'))
  await put(join(resources, 'app-update.yml'), 'provider: generic\nurl: https://lhr.ink/dsh-updates/v2/win\nchannel: latest\nupdaterCacheDirName: "@deepseek-aidsh-desktop-updater"\n')
  await put(join(resources, 'runtime/node.exe'), pe())
  await put(join(root, 'DSH Desktop.exe'), pe())
  return resources
}

describe('extracted package checks', () => {
  it('accepts preserved installed name, complete identity, runtime and v2 updater configuration', async () => {
    await expect(verifyExtractedRelease(await extracted(), { name: '@deepseek-ai/dsh-desktop', ...bridge }, { identity: bridge, platform: 'win32' })).resolves.toBeUndefined()
  })

  it.each([
    { name: '@deepseek-ai/dsh-desktop-shell', ...bridge },
    { name: '@deepseek-ai/dsh-desktop', ...standard },
    { name: '@deepseek-ai/dsh-desktop', version: bridge.version },
  ])('refuses embedded name or identity drift %j', async (shell) => {
    await expect(verifyExtractedRelease(await extracted(), shell, { identity: bridge, platform: 'win32' })).rejects.toThrow()
  })

  it.each(['runtime', 'feed', 'architecture', 'cache'])('refuses extracted %s drift', async (kind) => {
    const resources = await extracted()
    if (kind === 'runtime') await runtime(join(resources, 'server'), '0.2.2-rc.3')
    if (kind === 'feed') await put(join(resources, 'app-update.yml'), 'provider: generic\nurl: https://lhr.ink/dsh-updates/win\nchannel: latest\n')
    if (kind === 'cache') await put(join(resources, 'app-update.yml'), 'provider: generic\nurl: https://lhr.ink/dsh-updates/v2/win\nchannel: latest\nupdaterCacheDirName: other-app\n')
    if (kind === 'architecture') await put(join(resources, 'runtime/node.exe'), pe(0x14c))
    await expect(verifyExtractedRelease(resources, { name: '@deepseek-ai/dsh-desktop', ...bridge }, { identity: bridge, platform: 'win32' })).rejects.toThrow()
  })

  it('checks final-byte digests before opening a macOS archive', async () => {
    const root = await directory()
    for (const file of expectedArtifacts(standard, { mac: true, win: false })) await put(join(root, file), 'artifact')
    const artifacts = await collectReleaseArtifacts(root, standard, 'darwin', 0)
    await put(join(root, artifacts[0]!.fileName), 'tampered')
    await expect(verifyPackagedRelease({ distDir: root, identity: standard, platform: 'darwin', artifacts })).rejects.toMatchObject({ code: 'BUILD_ARTIFACT_INVALID' })
  })
})

describe('package CLI', () => {
  it('rejects redeploying existing compiled code without a verified staging receipt', async () => {
    const script = new URL('../scripts/package.ts', import.meta.url)
    await expect(execute(process.execPath, ['--import', 'tsx/esm', script.pathname, '--mac', '--skip-repo-build'], {
      cwd: new URL('../../../..', import.meta.url),
    })).rejects.toThrow('--skip-repo-build requires --skip-deploy')
  })

  it('prints the build-input and final-manifest usage without preparing a build', async () => {
    const script = new URL('../scripts/package.ts', import.meta.url)
    const result = await execute(process.execPath, ['--import', 'tsx/esm', script.pathname, '--help'], { cwd: new URL('../../../..', import.meta.url) })
    expect(result.stdout).toContain('--build-input <file>')
    expect(result.stdout).toContain('--output-manifest <file>')
    expect(result.stdout).toContain('Publishing accepts this completed inventory only')
  })
})
