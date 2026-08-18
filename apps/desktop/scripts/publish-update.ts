/**
 * Publish one desktop build to the static update feed. The feed is a plain
 * directory served by nginx — `latest.yml` / `latest-mac.yml` beside the
 * artifacts they name — so publishing is an upload with an ordering rule
 * rather than a release API.
 *
 * The order is what makes a publish atomic for the clients polling it: every
 * artifact goes up and is checksummed on both ends first, and only then do the
 * manifests that point at those artifacts. A client that polls mid-publish
 * sees the previous manifest and the previous artifacts, never a manifest
 * naming a file that is still uploading.
 *
 * Usage: pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes <file>
 *        [--minimum-version <version>] [--dry-run]
 *
 * `--minimum-version` sets the feed's red line: a client older than that
 * version must update before it can be used. Once set it **carries forward on
 * its own** — every later publish that omits the flag copies the value the
 * feed already serves, so a red line is never dropped by forgetting it. Pass
 * the flag to move the line; the only way to remove one is to edit the
 * published manifests by hand.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { CORE_SCHEMA, DEFAULT_SCHEMA, dump, load } from 'js-yaml'
import { compareVersions } from '../src/version-order.ts'
import { verifyNsisIntegrity } from './nsis-integrity.ts'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(APP_DIR, 'dist-app')

/** The ssh alias that reaches the update server; key-based, no password prompt. */
const REMOTE_HOST = 'macmini-rescue-server'

/**
 * Keepalives for every ssh and scp call. A publish pushes a few hundred
 * megabytes over one long-lived connection, which is exactly the traffic a
 * NAT or firewall idle timer cuts; without these the transfer dies as
 * `scp: Connection closed` partway through.
 */
const SSH_KEEPALIVE = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8']

/** Document root of the feed on that host, served by nginx under /dsh-updates/. */
const REMOTE_ROOT = '/var/www/dsh-updates'

/** Public base of the feed, matching the `publish` blocks in electron-builder.yml. */
const FEED_BASE = 'https://lhr.ink/dsh-updates'

/** One platform's feed: its manifest name and the remote subdirectory it lives in. */
interface Channel {
  /** Feed subdirectory and log label. */
  name: 'win' | 'mac'
  /** Manifest electron-updater fetches for this platform. */
  manifest: string
}

const CHANNELS: Channel[] = [
  { name: 'win', manifest: 'latest.yml' },
  { name: 'mac', manifest: 'latest-mac.yml' },
]

/** The manifest fields this script reads and rewrites. */
interface Manifest {
  /** The published version. */
  version: string
  /** Artifacts of this version. */
  files?: { url: string }[]
  /** Primary artifact name. */
  path?: string
  /** Release notes, replaced by `--notes` on every publish. */
  releaseNotes?: string
  /** The red line: a client below this version must update before it can be used. */
  minimumVersion?: string
}

interface Cli {
  notes: string
  minimumVersion: string | undefined
  dryRun: boolean
}

function parseCli(argv: string[]): Cli {
  const { values } = parseArgs({
    args: argv,
    options: {
      notes: { type: 'string' },
      'minimum-version': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  if (values.notes === undefined) {
    throw new Error('publish: --notes <file> is required; it carries the release notes shown in the update dialog.')
  }
  return { notes: values.notes, minimumVersion: values['minimum-version'], dryRun: values['dry-run'] }
}

/**
 * Run one command and capture stdout; a non-zero exit throws with stderr.
 * @param command - the executable to run.
 * @param args - its arguments, passed without a shell.
 * @returns the captured stdout.
 */
async function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
    child.once('error', (error) => { reject(new Error(`publish: ${command} failed to spawn: ${error.message}`)) })
    child.once('exit', (code) => {
      if (code === 0) resolvePromise(out)
      else reject(new Error(`publish: ${[command, ...args].join(' ')} exited ${String(code)}\n${err.trim()}`))
    })
  })
}

/** Single-quote one argument for the remote shell ssh runs the command in. */
function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

/** Run one command on the update server and return its stdout. */
async function remote(script: string): Promise<string> {
  return capture('ssh', [...SSH_KEEPALIVE, REMOTE_HOST, script])
}

/** MD5 of a local file, for the both-ends comparison after an upload. */
async function localMd5(path: string): Promise<string> {
  return createHash('md5').update(await readFile(path)).digest('hex')
}

/** SHA-256 of a local file, printed as the release's identity record. */
async function localSha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * Read one local manifest and check it describes the build being published.
 * @param channel - the platform channel.
 * @param version - the version apps/desktop/package.json declares.
 * @returns the parsed manifest.
 */
async function readManifest(channel: Channel, version: string): Promise<Manifest> {
  const path = join(DIST, channel.manifest)
  if (!existsSync(path)) {
    throw new Error(`publish: ${path} is missing — build first: pnpm exec tsx apps/desktop/scripts/package.ts --mac --win`)
  }
  const manifest = load(await readFile(path, 'utf8'), { schema: CORE_SCHEMA }) as Manifest
  if (manifest.version !== version) {
    throw new Error(`publish: ${channel.manifest} describes ${manifest.version} but package.json says ${version} — the build in dist-app is stale.`)
  }
  return manifest
}

/**
 * The artifacts one channel uploads, in upload order. The manifest names them,
 * so a build whose artifactName pattern changed needs no edit here.
 * @param channel - the platform channel.
 * @param manifest - that channel's manifest.
 * @returns absolute paths of the artifacts, which must all exist.
 */
function artifactsOf(channel: Channel, manifest: Manifest): string[] {
  const primary = manifest.path ?? manifest.files?.[0]?.url
  if (primary === undefined) throw new Error(`publish: ${channel.manifest} names no artifact.`)
  const name = decodeURIComponent(primary)
  const paths = [join(DIST, name)]
  // The blockmap is what lets electron-updater download only the changed
  // chunks of the next Windows installer; without it every update is a full
  // download, so a missing one is a build problem, not an optional extra.
  if (channel.name === 'win') paths.push(join(DIST, `${name}.blockmap`))
  for (const path of paths) {
    if (!existsSync(path)) {
      throw new Error(`publish: ${path} is missing — build first: pnpm exec tsx apps/desktop/scripts/package.ts --mac --win`)
    }
  }
  return paths
}

/**
 * Copy one file to a channel directory and verify both ends hold the same
 * bytes. scp carries the basename itself, so a name containing spaces needs no
 * quoting on the way up; the verification does quote it, because it runs
 * through the remote shell.
 * @param path - the local file to upload.
 * @param channel - the destination channel.
 */
async function upload(path: string, channel: Channel): Promise<void> {
  const name = basename(path)
  const remotePath = `${REMOTE_ROOT}/${channel.name}/${name}`
  const expected = await localMd5(path)
  // Skipping a file the server already holds byte for byte makes a publish
  // resumable: a transfer cut halfway through leaves the finished artifacts
  // in place, and the retry pushes only what is missing.
  const published = await remoteMd5(remotePath)
  if (published === expected) {
    console.log(`publish: ${name} already on the server with md5 ${expected}`)
    return
  }
  console.log(`publish: uploading ${name} -> ${channel.name}/`)
  await capture('scp', [...SSH_KEEPALIVE, '-q', path, `${REMOTE_HOST}:${REMOTE_ROOT}/${channel.name}/`])
  const actual = await remoteMd5(remotePath)
  if (actual !== expected) {
    throw new Error(`publish: ${name} differs after upload (local ${expected}, remote ${actual ?? 'unreadable'}).`)
  }
  console.log(`publish: verified ${name} md5 ${expected}`)
}

/** MD5 of a file on the update server, or undefined when it is not there. */
async function remoteMd5(remotePath: string): Promise<string | undefined> {
  const output = await remote(`md5sum ${shellQuote(remotePath)} 2>/dev/null || true`)
  return output.trim().split(/\s+/)[0] || undefined
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  const notesPath = resolve(cli.notes)
  if (!existsSync(notesPath)) throw new Error(`publish: notes file ${notesPath} does not exist.`)
  const notes = (await readFile(notesPath, 'utf8')).trim()
  if (notes === '') throw new Error(`publish: notes file ${notesPath} is empty.`)

  const { version } = JSON.parse(await readFile(join(APP_DIR, 'package.json'), 'utf8')) as { version: string }
  console.log(`publish: releasing ${version}`)

  // The live manifest is read before anything is written, because it carries
  // the red line this publish inherits when --minimum-version is absent.
  const published = (await remote(`cat ${shellQuote(`${REMOTE_ROOT}/win/latest.yml`)} 2>/dev/null || true`)).trim()
  const live = published === '' ? undefined : load(published, { schema: CORE_SCHEMA }) as Manifest
  console.log(`publish: feed currently serves ${live?.version ?? '(nothing)'}`)
  if (live !== undefined && compareVersions(version, live.version) <= 0) {
    throw new Error(`publish: ${version} does not supersede the published ${live.version}; bump apps/desktop/package.json first.`)
  }
  const minimumVersion = cli.minimumVersion ?? live?.minimumVersion
  if (cli.minimumVersion !== undefined) {
    console.log(`publish: setting the mandatory-update line to ${cli.minimumVersion}`)
    if (compareVersions(cli.minimumVersion, version) > 0) {
      throw new Error(`publish: minimumVersion ${cli.minimumVersion} is above the ${version} being published, which would leave every client stuck.`)
    }
  } else if (minimumVersion !== undefined) {
    console.log(`publish: carrying the published mandatory-update line ${minimumVersion} forward`)
  }

  const plan = new Map<Channel, string[]>()
  for (const channel of CHANNELS) {
    const manifest = await readManifest(channel, version)
    const artifacts = artifactsOf(channel, manifest)
    plan.set(channel, artifacts)
    for (const artifact of artifacts) {
      if (artifact.endsWith('.exe')) await verifyNsisIntegrity(artifact)
      if (!artifact.endsWith('.blockmap')) {
        console.log(`publish: ${basename(artifact)} sha256 ${await localSha256(artifact)}`)
      }
    }
    // Notes and the red line are the fields this script owns; rewriting the
    // whole file keeps js-yaml as the only thing that has to understand it.
    manifest.releaseNotes = notes
    if (minimumVersion !== undefined) manifest.minimumVersion = minimumVersion
    // Read without the timestamp type so `releaseDate` stays a string, but
    // write with it, so js-yaml sees that an unquoted ISO date would be
    // ambiguous and quotes it. electron-updater parses the published file with
    // the default schema and types that field as a string; emitting it bare
    // would hand it a Date instead.
    await writeFile(join(DIST, channel.manifest), dump(manifest, { schema: DEFAULT_SCHEMA, lineWidth: -1, noRefs: true }))
    console.log(`publish: wrote release notes into ${channel.manifest}`)
  }

  if (cli.dryRun) {
    console.log('publish: dry run — local manifests carry the notes, nothing was uploaded.')
    return
  }

  // Artifacts before manifests, so a client polling mid-publish never reads a
  // manifest naming a file that is not there yet.
  for (const [channel, artifacts] of plan) {
    for (const artifact of artifacts) await upload(artifact, channel)
  }
  for (const channel of CHANNELS) await upload(join(DIST, channel.manifest), channel)

  const serving = load(await capture('curl', ['-fsS', `${FEED_BASE}/win/latest.yml`]), { schema: CORE_SCHEMA }) as Manifest
  console.log(`publish: ${FEED_BASE}/win/latest.yml now serves ${serving.version} (minimumVersion ${serving.minimumVersion ?? 'unset'})`)
}

await main()
