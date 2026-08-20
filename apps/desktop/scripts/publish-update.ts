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
 * Nothing here deletes, and the feed directory is not to be tidied by hand
 * either: differential downloads read the blockmap of the version the *client*
 * is running as well as the new one ([[reportPreviousBlockmap]]).
 *
 * Usage: pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes <file>
 *        [--minimum-version <version>] [--republish] [--dry-run]
 *
 * `--republish` allows overwriting the version the feed already serves, which
 * is how a publish cut short by a dropped transfer is repaired: uploads skip
 * whatever already matches, so the retry pushes only what is missing.
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
import { createReadStream, existsSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
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

/**
 * How many times one file may resume before the publish gives up. Each attempt
 * starts where the last one stopped, so this bounds a link that keeps dropping,
 * not the size of the file.
 */
const MAX_UPLOAD_ATTEMPTS = 10

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
  republish: boolean
  dryRun: boolean
}

function parseCli(argv: string[]): Cli {
  const { values } = parseArgs({
    args: argv,
    options: {
      notes: { type: 'string' },
      'minimum-version': { type: 'string' },
      republish: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  if (values.notes === undefined) {
    throw new Error('publish: --notes <file> is required; it carries the release notes shown in the update dialog.')
  }
  return {
    notes: values.notes,
    minimumVersion: values['minimum-version'],
    republish: values.republish,
    dryRun: values['dry-run'],
  }
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

/**
 * Run one command on the update server and return its stdout. Every caller
 * sends an idempotent command (`stat`, `md5sum`, `rm -f`, `mv -f`, `cat`), so a
 * connection this link drops mid-command is retried rather than fatal.
 * @param script - the shell command to run on the server.
 * @returns its stdout.
 */
async function remote(script: string): Promise<string> {
  let last: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await capture('ssh', [...SSH_KEEPALIVE, REMOTE_HOST, script])
    } catch (error) {
      last = error
    }
  }
  throw last
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
  // The blockmap is what lets electron-updater download only the changed chunks
  // of the next build, on both platforms: the NSIS installer on Windows and the
  // app zip on macOS. Without it every update is a full download, so a missing
  // one is a build problem, not an optional extra.
  const paths = [join(DIST, name), join(DIST, `${name}.blockmap`)]
  for (const path of paths) {
    if (!existsSync(path)) {
      throw new Error(`publish: ${path} is missing — build first: pnpm exec tsx apps/desktop/scripts/package.ts --mac --win`)
    }
  }
  return paths
}

/**
 * Report whether the version this publish replaces still has its blockmap in
 * the feed directory.
 *
 * A differential download reads **two** blockmaps: the new build's, and the one
 * belonging to the version the client is running, whose URL electron-updater
 * builds by substituting versions into the new artifact's name
 * (`Provider.getBlockMapFiles`). Every published version's blockmap therefore
 * has to stay where it was uploaded for as long as anyone might update from it
 * — which is why nothing in this script deletes, and why removing old builds by
 * hand turns differential downloads back into full ones with no error anywhere.
 * @param channel - the platform channel.
 * @param artifact - the artifact being published, whose name carries the version.
 * @param version - the version being published.
 * @param previousVersion - the version the feed serves right now.
 */
async function reportPreviousBlockmap(channel: Channel, artifact: string, version: string, previousVersion: string): Promise<void> {
  const previous = basename(artifact).replaceAll(version, previousVersion)
  const path = `${REMOTE_ROOT}/${channel.name}/${previous}`
  if (await remoteSize(path) > 0) {
    console.log(`publish: ${channel.name}: ${previous} is still served, so ${previousVersion} clients update differentially`)
    return
  }
  console.log(`publish: WARNING — ${channel.name}: ${previous} is not in the feed, so ${previousVersion} clients download the whole artifact.`)
}

/**
 * Drop manifest entries naming artifacts this publish does not upload. The
 * macOS build produces a zip and a dmg and electron-builder lists both, but
 * only the zip is published — leaving the dmg entry in place puts a 404 in the
 * feed for any client that reads past the first entry.
 * @param manifest - the manifest being rewritten.
 * @param artifacts - absolute paths of everything this channel uploads.
 * @returns the names that were dropped, for the log.
 */
function pruneUnpublishedFiles(manifest: Manifest, artifacts: string[]): string[] {
  const uploaded = new Set(artifacts.map(path => basename(path)))
  const files = manifest.files ?? []
  const kept = files.filter(entry => uploaded.has(decodeURIComponent(entry.url)))
  if (kept.length === 0) {
    throw new Error('publish: pruning would empty the manifest file list — the upload set and the manifest disagree.')
  }
  manifest.files = kept
  return files.filter(entry => !kept.includes(entry)).map(entry => entry.url)
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
  const finalPath = `${REMOTE_ROOT}/${channel.name}/${name}`
  // Bytes accumulate in a sibling `.part` and only become the published file
  // once they hash correctly, so a half-sent file is never briefly readable at
  // the name a client fetches — which matters most for the manifests, where a
  // torn write is a feed serving invalid YAML.
  const partPath = `${finalPath}.part`
  const expected = await localMd5(path)
  const total = (await stat(path)).size
  if (await remoteMd5(finalPath) === expected) {
    console.log(`publish: ${name} already published, md5 ${expected}`)
    return
  }
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    let present = await remoteSize(partPath)
    if (present > 0 && present < total) {
      // Resume only onto bytes that really are this file's beginning. A `.part`
      // left by a different build is the same name and a plausible length, and
      // appending to it would produce a file that is corrupt rather than short.
      const remoteHead = (await remote(`head -c ${String(present)} ${shellQuote(partPath)} | md5sum`)).trim().split(/\s+/)[0]
      if (remoteHead !== await localMd5Prefix(path, present)) {
        console.log(`publish: ${name} has an unrelated partial upload; restarting it`)
        await remote(`rm -f ${shellQuote(partPath)}`)
        present = 0
      }
    } else if (present >= total) {
      await remote(`rm -f ${shellQuote(partPath)}`)
      present = 0
    }
    if (present < total) {
      console.log(`publish: uploading ${name} -> ${channel.name}/ from ${String(present)}/${String(total)} bytes (attempt ${String(attempt)})`)
      try {
        await appendRemainder(path, partPath, present)
      } catch (error) {
        if (attempt === MAX_UPLOAD_ATTEMPTS) throw error
        console.log(`publish: ${name} interrupted, resuming: ${error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)}`)
        continue
      }
    }
    if (await remoteMd5(partPath) === expected) {
      await remote(`mv -f ${shellQuote(partPath)} ${shellQuote(finalPath)}`)
      console.log(`publish: verified ${name} md5 ${expected}`)
      return
    }
    console.log(`publish: ${name} did not hash correctly after upload; restarting it`)
    await remote(`rm -f ${shellQuote(partPath)}`)
  }
  throw new Error(`publish: ${name} did not finish uploading in ${String(MAX_UPLOAD_ATTEMPTS)} attempts.`)
}

/**
 * Parse the manifest the feed currently serves. A manifest that does not parse
 * is a feed already broken, and the publish about to overwrite it is the
 * repair — so this reports the damage and moves on rather than refusing to fix
 * it. The version and red-line guards simply have nothing to compare against.
 * @param published - the bytes the server returned.
 * @returns the parsed manifest, or undefined when it is unreadable.
 */
function readLiveManifest(published: string): Manifest | undefined {
  try {
    return load(published, { schema: CORE_SCHEMA }) as Manifest
  } catch (error) {
    console.log(`publish: the published latest.yml does not parse (${error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)}); replacing it`)
    return undefined
  }
}

/** MD5 of the first `length` bytes of a local file, for the resume check. */
async function localMd5Prefix(path: string, length: number): Promise<string> {
  const hash = createHash('md5')
  for await (const chunk of createReadStream(path, { start: 0, end: length - 1 })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Append the part of a local file the server does not have yet.
 *
 * scp restarts a cut transfer from zero, and this link drops often enough that
 * a 145 MB installer may never complete that way; the server has no rsync and
 * is not ours to install packages on. Streaming the remainder into a remote
 * `cat >>` needs nothing but ssh, and every attempt keeps the ground it took.
 * @param path - the local file.
 * @param remotePath - its destination on the update server.
 * @param start - how many bytes the server already holds.
 */
async function appendRemainder(path: string, remotePath: string, start: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ssh', [...SSH_KEEPALIVE, REMOTE_HOST, `cat >> ${shellQuote(remotePath)}`], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
    child.once('error', (error) => { reject(new Error(`publish: ssh append failed to spawn: ${error.message}`)) })
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`publish: ssh append exited ${String(code)}\n${err.trim()}`))
    })
    const source = createReadStream(path, { start })
    source.once('error', (error) => {
      child.kill()
      reject(error)
    })
    source.pipe(child.stdin)
  })
}

/** Size of a file on the update server; 0 when it is not there. */
async function remoteSize(remotePath: string): Promise<number> {
  const output = await remote(`stat -c %s ${shellQuote(remotePath)} 2>/dev/null || echo 0`)
  return Number.parseInt(output.trim(), 10) || 0
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
  const live = published === '' ? undefined : readLiveManifest(published)
  console.log(`publish: feed currently serves ${live?.version ?? '(nothing)'}`)
  if (live !== undefined) {
    const order = compareVersions(version, live.version)
    if (order < 0) {
      throw new Error(`publish: ${version} is older than the published ${live.version}; bump apps/desktop/package.json first.`)
    }
    // Re-publishing one version is how a half-finished upload gets repaired,
    // and it is the only operation here that overwrites artifacts a manifest
    // already vouches for: while the bytes are being replaced they no longer
    // match the published sha512, so a client downloading in that window fails
    // its checksum and retries on the next check. That is recoverable and the
    // window is minutes, but it is not something to reach by accident.
    if (order === 0 && !cli.republish) {
      throw new Error(`publish: the feed already serves ${version}; pass --republish to overwrite it (repairing a partial upload), or bump apps/desktop/package.json.`)
    }
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
      if (artifact.endsWith('.blockmap')) {
        if (live !== undefined) await reportPreviousBlockmap(channel, artifact, version, live.version)
      } else {
        console.log(`publish: ${basename(artifact)} sha256 ${await localSha256(artifact)}`)
      }
    }
    // Notes and the red line are the fields this script owns; rewriting the
    // whole file keeps js-yaml as the only thing that has to understand it.
    manifest.releaseNotes = notes
    if (minimumVersion !== undefined) manifest.minimumVersion = minimumVersion
    const dropped = pruneUnpublishedFiles(manifest, artifacts)
    if (dropped.length > 0) {
      console.log(`publish: dropped unpublished ${channel.manifest} entries: ${dropped.join(', ')}`)
    }
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

  // Ordering keeps each channel self-consistent, but a transfer that dies
  // between the two manifests leaves the platforms on different versions.
  // Reading both back is what turns that into a failure instead of a feed
  // nobody notices is split.
  for (const channel of CHANNELS) {
    const url = `${FEED_BASE}/${channel.name}/${channel.manifest}`
    const serving = load(await capture('curl', ['-fsS', url]), { schema: CORE_SCHEMA }) as Manifest
    if (serving.version !== version) {
      throw new Error(`publish: ${url} serves ${serving.version}, not ${version} — the channels disagree; re-run the publish.`)
    }
    console.log(`publish: ${url} now serves ${serving.version} (minimumVersion ${serving.minimumVersion ?? 'unset'})`)
  }
}

await main()
