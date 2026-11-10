/** Build orchestration and verification of the bytes desktop publishing consumes. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { parse as parseYaml } from 'yaml'
import { parseReleaseIdentity, releaseKey, type ReleaseIdentity, type ReleasePlatform } from '../src/release-identity.ts'
import { builderNameEnvironment, expectedArtifacts, LEGACY_ARTIFACT_NAME_PATTERNS } from './artifact-names.ts'
import { parseReleaseBuildInput, parseReleaseManifest, type ReleaseBuildInput, type ReleaseManifest, type ReleaseManifestArtifact } from './release-manifest.ts'

const execute = promisify(execFile)
const INSTALLED_NAME = '@deepseek-ai/dsh-desktop'
const RUNTIME_MANIFEST = 'node_modules/@deepseek-ai/dsh-app-boot/package.json'
const STAGING_RECEIPT = '.dsh-build-source.json'
const FEED_URLS = { darwin: 'https://lhr.ink/dsh-updates/v2/mac', win32: 'https://lhr.ink/dsh-updates/v2/win' } as const

/** Stable packaging refusal; no final manifest is emitted after a failed check. */
export class BuildReleaseError extends Error {
  /** The failed validation stage. */
  readonly code: 'BUILD_SOURCE_INVALID' | 'BUILD_RUNTIME_INVALID' | 'BUILD_STAGING_INVALID' | 'BUILD_PACKAGE_INVALID' | 'BUILD_ARTIFACT_INVALID'

  constructor(code: BuildReleaseError['code'], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BuildReleaseError'
    this.code = code
  }
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

/**
 * Read a file's final digest without loading the artifact into memory.
 * @param path - Final artifact path.
 * @returns Base64 SHA-512.
 */
export async function artifactSha512(path: string): Promise<string> {
  const hash = createHash('sha512')
  await pipeline(createReadStream(path), hash)
  return hash.digest('base64')
}

/**
 * Require the requested revision to name the clean source being packaged.
 * @param root - Repository worktree.
 * @param identity - Requested identity.
 */
export async function verifyBuildSource(root: string, identity: ReleaseIdentity): Promise<void> {
  const head = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  const changes = (await execute('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root })).stdout
  if (head !== identity.dshRelease.revision || changes.trim() !== '') {
    throw new BuildReleaseError('BUILD_SOURCE_INVALID', `package: build revision must equal clean HEAD ${head}; commit the intended source before packaging`)
  }
  const runtime = field(await json(join(root, 'packages/boot/app-boot/package.json')), 'version')
  const shell = field(await json(join(root, 'apps/desktop-shell/package.json')), 'version')
  if (runtime !== identity.dshRelease.runtimeVersion || shell !== runtime) {
    throw new BuildReleaseError('BUILD_RUNTIME_INVALID', 'package: source shell and app-boot versions must equal the requested runtimeVersion; only builder metadata may override the bridge application version')
  }
}

/**
 * Validate the runtime manifest actually copied into a server payload.
 * @param server - Staged or unpacked server directory.
 * @param identity - Build whose runtime must be present.
 */
export async function verifyRuntimeVersion(server: string, identity: ReleaseIdentity): Promise<void> {
  const manifest = await json(join(server, RUNTIME_MANIFEST))
  if (field(manifest, 'name') !== '@deepseek-ai/dsh-app-boot' || field(manifest, 'version') !== identity.dshRelease.runtimeVersion) {
    throw new BuildReleaseError('BUILD_RUNTIME_INVALID', `package: ${server} app-boot does not match runtimeVersion ${identity.dshRelease.runtimeVersion}`)
  }
}

async function stagingDigest(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (relative: string): Promise<void> => {
    const directory = join(root, relative)
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (relative === '' && entry.name === STAGING_RECEIPT) continue
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`
      const path = join(root, name)
      const info = await lstat(path)
      hash.update(JSON.stringify([name, info.mode]))
      if (entry.isSymbolicLink()) hash.update(JSON.stringify(['link', await readlink(path)]))
      else if (entry.isDirectory()) await visit(name)
      else if (entry.isFile()) hash.update(await artifactSha512(path))
      else throw new BuildReleaseError('BUILD_STAGING_INVALID', `package: unsupported staging entry ${path}`)
    }
  }
  await visit('')
  return hash.digest('hex')
}

/**
 * Bind a freshly deployed staging tree to its source and bytes.
 * @param server - Fresh, validated staging directory.
 * @param identity - Source identity that produced it.
 */
export async function recordBuildStaging(server: string, identity: ReleaseIdentity): Promise<void> {
  await verifyRuntimeVersion(server, identity)
  await writeFile(join(server, STAGING_RECEIPT), JSON.stringify({
    revision: identity.dshRelease.revision,
    runtimeVersion: identity.dshRelease.runtimeVersion,
    sha256: await stagingDigest(server),
  }) + '\n', { flag: 'wx' })
}

/**
 * Refuse missing, stale, or edited staging before --skip-deploy can reuse it.
 * @param server - Existing staging directory.
 * @param identity - Requested source identity.
 */
export async function verifyBuildStaging(server: string, identity: ReleaseIdentity): Promise<void> {
  let receipt: unknown
  try {
    receipt = await json(join(server, STAGING_RECEIPT))
  } catch (cause) {
    throw new BuildReleaseError('BUILD_STAGING_INVALID', `package: ${server} has no readable source receipt; rebuild without --skip-deploy`, { cause })
  }
  await verifyRuntimeVersion(server, identity)
  if (field(receipt, 'revision') !== identity.dshRelease.revision
    || field(receipt, 'runtimeVersion') !== identity.dshRelease.runtimeVersion
    || field(receipt, 'sha256') !== await stagingDigest(server)) {
    throw new BuildReleaseError('BUILD_STAGING_INVALID', `package: ${server} source receipt or content differs; rebuild without --skip-deploy`)
  }
}

/**
 * Supply installed metadata before builder creates the asar, plist, or signature.
 * @param identity - Validated build identity.
 * @returns Builder configuration overrides preserving the installed package name.
 */
export function releaseBuilderArguments(identity: ReleaseIdentity): string[] {
  return [
    `-c.extraMetadata.name=${INSTALLED_NAME}`,
    `-c.extraMetadata.version=${identity.version}`,
    ...Object.entries(identity.dshRelease).map(([key, value]) => `-c.extraMetadata.dshRelease.${key}=${String(value)}`),
    ...(identity.dshRelease.kind === 'bridge' ? [
      `-c.mac.artifactName=${LEGACY_ARTIFACT_NAME_PATTERNS.zip}`,
      `-c.dmg.artifactName=${LEGACY_ARTIFACT_NAME_PATTERNS.dmg}`,
      `-c.nsis.artifactName=${LEGACY_ARTIFACT_NAME_PATTERNS.nsis}`,
    ] : []),
  ]
}

/** External operations used by the packaging entry; validation and ordering remain real in tests. */
export interface ReleaseBuildOperations {
  /** Validate source before preparation and again after all artifacts finish. */
  verifySource: (identity: ReleaseIdentity) => Promise<void>
  /** Build code, stage the server, and validate reused staging. */
  prepare: (input: ReleaseBuildInput) => Promise<void>
  /** Run builder with these metadata overrides and artifact naming variables. */
  build: (platform: ReleasePlatform, args: string[], environment: Readonly<Record<string, string>>) => Promise<void>
  /** Read the final, nonempty artifacts produced by this run. */
  inventory: (platform: ReleasePlatform, identity: ReleaseIdentity, startedAt: number) => Promise<readonly ReleaseManifestArtifact[]>
  /** Extract the declared bytes and reject mismatched installed metadata. */
  verifyPackages: (platform: ReleasePlatform, identity: ReleaseIdentity, artifacts: readonly ReleaseManifestArtifact[]) => Promise<void>
  /** Persist a completed manifest only after every target passes. */
  writeManifest: (manifest: ReleaseManifest) => Promise<void>
}

/**
 * Execute the release packaging entry from build input to publishable inventory.
 * @param value - Parsed build-input file, without artifact hashes.
 * @param targets - Explicit CLI targets; must equal the requested targets.
 * @param operations - Filesystem and process operations of the real packaging script.
 * @returns The completed inventory. Failures leave no newly written manifest.
 */
export async function buildRelease(
  value: unknown,
  targets: readonly ReleasePlatform[],
  operations: ReleaseBuildOperations,
): Promise<ReleaseManifest> {
  const input = parseReleaseBuildInput(value)
  if (targets.length !== input.platforms.length || targets.some(target => !input.platforms.includes(target))) {
    throw new BuildReleaseError('BUILD_SOURCE_INVALID', 'package: CLI platforms must exactly match the build-input platforms')
  }
  await operations.verifySource(input)
  const startedAt = Date.now()
  await operations.prepare(input)
  const platforms: ReleaseManifest['platforms'] = {
    darwin: { arch: 'arm64', artifacts: [] },
    win32: { arch: 'x64', artifacts: [] },
  }
  for (const platform of input.platforms) {
    await operations.build(platform, releaseBuilderArguments(input), builderNameEnvironment(input))
    const artifacts = await operations.inventory(platform, input, startedAt)
    // Parsing the final format also rejects a missing or mixed artifact set.
    const next = parseReleaseManifest({ ...input, platforms: { ...platforms, [platform]: { arch: platforms[platform].arch, artifacts } } })
    await operations.verifyPackages(platform, input, artifacts)
    Object.assign(platforms, next.platforms)
  }
  await operations.verifySource(input)
  const manifest = parseReleaseManifest({ ...input, platforms })
  await operations.writeManifest(manifest)
  return manifest
}

/**
 * Collect final artifacts after signing/compression, rejecting leftovers.
 * @param distDir - Builder output directory.
 * @param identity - Build being packaged.
 * @param platform - Target just built.
 * @param startedAt - This run's start time in milliseconds.
 * @returns Exact artifact inventory with measured digests and sizes.
 */
export async function collectReleaseArtifacts(
  distDir: string,
  identity: ReleaseIdentity,
  platform: ReleasePlatform,
  startedAt: number,
): Promise<readonly ReleaseManifestArtifact[]> {
  const result: ReleaseManifestArtifact[] = []
  for (const fileName of expectedArtifacts(identity, { mac: platform === 'darwin', win: platform === 'win32' })) {
    const path = join(distDir, fileName)
    const info = await lstat(path)
    if (!info.isFile() || info.size === 0 || info.mtimeMs < startedAt) {
      throw new BuildReleaseError('BUILD_ARTIFACT_INVALID', `package: ${path} must be a nonempty regular artifact from this run`)
    }
    result.push({ fileName, size: info.size, sha512: await artifactSha512(path) })
  }
  return result
}

/** The measured final files whose installed metadata must be checked. */
export interface PackagedReleaseRequest {
  readonly distDir: string
  readonly identity: ReleaseIdentity
  readonly platform: ReleasePlatform
  readonly artifacts: readonly ReleaseManifestArtifact[]
}

async function descendants(directory: string, match: (name: string) => boolean): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = join(directory, entry.name)
    if (match(entry.name)) found.push(path)
    else if (entry.isDirectory()) found.push(...await descendants(path, match))
  }
  return found
}

function only(paths: readonly string[], subject: string): string {
  if (paths.length !== 1 || paths[0] === undefined) {
    throw new BuildReleaseError('BUILD_PACKAGE_INVALID', `package: expected one ${subject}, found ${String(paths.length)}`)
  }
  return paths[0]
}

async function checkArchitecture(path: string, platform: ReleasePlatform): Promise<void> {
  const bytes = await readFile(path)
  const arm64 = bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x100000c
  const peOffset = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length
  const x64 = bytes.toString('ascii', 0, 2) === 'MZ' && peOffset + 6 <= bytes.length
    && bytes.readUInt32LE(peOffset) === 0x4550 && bytes.readUInt16LE(peOffset + 4) === 0x8664
  if (!(platform === 'darwin' ? arm64 : x64)) {
    throw new BuildReleaseError('BUILD_PACKAGE_INVALID', `package: ${path} is not the supported ${platform === 'darwin' ? 'arm64 Mach-O' : 'x64 PE'} executable`)
  }
}

/**
 * Check extracted package metadata and runtime, including the actual executable.
 * @param resources - The extracted application's resources directory.
 * @param shellManifest - package.json read from its asar by the builder's asar reader.
 * @param request - Expected identity and platform.
 */
export async function verifyExtractedRelease(resources: string, shellManifest: unknown, request: Pick<PackagedReleaseRequest, 'identity' | 'platform'>): Promise<void> {
  const identity = parseReleaseIdentity(shellManifest)
  if (field(shellManifest, 'name') !== INSTALLED_NAME || releaseKey(identity) !== releaseKey(request.identity)) {
    throw new BuildReleaseError('BUILD_PACKAGE_INVALID', 'package: extracted application name or release identity differs from the requested build')
  }
  await verifyRuntimeVersion(join(resources, 'server'), request.identity)
  const feed: unknown = parseYaml(await readFile(join(resources, 'app-update.yml'), 'utf8'))
  if (field(feed, 'provider') !== 'generic' || field(feed, 'url') !== FEED_URLS[request.platform] || field(feed, 'channel') !== 'latest'
    || field(feed, 'updaterCacheDirName') !== '@deepseek-aidsh-desktop-updater') {
    throw new BuildReleaseError('BUILD_PACKAGE_INVALID', 'package: extracted updater configuration must retain the installed cache identity and production v2/latest feed')
  }
  await checkArchitecture(join(resources, 'runtime', request.platform === 'darwin' ? 'node' : 'node.exe'), request.platform)
  if (request.platform === 'darwin') {
    const contents = resolve(resources, '..')
    const plist = join(contents, 'Info.plist')
    const printed = await execute('plutil', ['-convert', 'json', '-o', '-', plist])
    const info: unknown = JSON.parse(printed.stdout)
    if (field(info, 'CFBundleShortVersionString') !== request.identity.version || field(info, 'CFBundleIdentifier') !== 'dev.dsh.desktop'
      || field(info, 'ElectronSquirrelPreventDowngrades') !== false) {
      throw new BuildReleaseError('BUILD_PACKAGE_INVALID', 'package: extracted plist version, bundle identifier, or downgrade setting prevents the requested release')
    }
    const executable = field(info, 'CFBundleExecutable')
    if (typeof executable !== 'string' || basename(executable) !== executable) throw new BuildReleaseError('BUILD_PACKAGE_INVALID', 'package: invalid bundle executable')
    await checkArchitecture(join(contents, 'MacOS', executable), 'darwin')
    await execute('codesign', ['--verify', '--deep', '--strict', resolve(contents, '..')])
  } else {
    await checkArchitecture(join(resources, '..', 'DSH Desktop.exe'), 'win32')
  }
}

/**
 * Re-extract each final ZIP, DMG, or NSIS package and verify its installed identity.
 * This is shared by packaging and publishing; a manifest alone cannot attest bytes.
 * macOS artifacts require a macOS verifier with ditto, hdiutil, and codesign.
 * @param request - Exact artifact inventory to validate against disk.
 */
export async function verifyPackagedRelease(request: PackagedReleaseRequest): Promise<void> {
  const { identity, platform, artifacts, distDir } = request
  parseReleaseManifest({ ...identity, platforms: {
    darwin: { arch: 'arm64', artifacts: platform === 'darwin' ? artifacts : [] },
    win32: { arch: 'x64', artifacts: platform === 'win32' ? artifacts : [] },
  } })
  const require = createRequire(import.meta.url)
  const builderRequire = createRequire(require.resolve('electron-builder'))
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
  const asar: { extractFile(path: string, name: string): Buffer } = appBuilderRequire('@electron/asar')
  const sevenZip = process.env.DSH_RELEASE_7ZIP ?? (process.platform === 'win32' ? '7z.exe' : '7zz')
  if (platform === 'win32') {
    try {
      const formats = (await execute(sevenZip, ['i'])).stdout
      if (!/\bNsis\b/i.test(formats)) throw new Error('extractor does not support NSIS')
    } catch (cause) {
      throw new BuildReleaseError('BUILD_PACKAGE_INVALID', 'package: full 7-Zip with NSIS support is required; set DSH_RELEASE_7ZIP to its executable (7zip-bin/7za is insufficient)', { cause })
    }
  }
  for (const artifact of artifacts) {
    const path = resolve(distDir, artifact.fileName)
    if ((await stat(path)).size !== artifact.size || await artifactSha512(path) !== artifact.sha512) {
      throw new BuildReleaseError('BUILD_ARTIFACT_INVALID', `package: ${artifact.fileName} bytes differ from the final inventory`)
    }
    if (artifact.fileName.endsWith('.blockmap')) continue
    if (platform === 'darwin' && process.platform !== 'darwin') {
      throw new BuildReleaseError('BUILD_PACKAGE_INVALID', 'package: macOS artifacts require verification on macOS')
    }
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-release-verify-'))
    let mounted: string | undefined
    try {
      if (artifact.fileName.endsWith('.dmg')) {
        const mountPoint = join(temporary, 'volume')
        await mkdir(mountPoint)
        await execute('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, path])
        mounted = mountPoint
      } else if (platform === 'darwin') {
        await execute('ditto', ['-x', '-k', path, temporary])
      } else {
        await execute(sevenZip, ['x', '-y', `-o${temporary}`, path])
        const payload = only(await descendants(temporary, name => name === 'app-64.7z'), 'NSIS x64 payload')
        const unpacked = join(temporary, 'application')
        await execute(sevenZip, ['x', '-y', `-o${unpacked}`, payload])
      }
      const search = mounted ?? temporary
      const archive = only(await descendants(search, name => name === 'app.asar'), 'application asar')
      const resources = resolve(archive, '..')
      await verifyExtractedRelease(resources, JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8')), request)
    } finally {
      if (mounted !== undefined) await execute('hdiutil', ['detach', mounted])
      // Only the private directory allocated above is removed; artifacts remain intact.
      await rm(temporary, { recursive: true, force: true })
    }
  }
}
