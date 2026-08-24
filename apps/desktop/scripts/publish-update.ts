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
 * A publish whose manifests came back served then prunes the directories it
 * wrote: the newest [[KEPT_ARTIFACT_VERSIONS]] versions keep their artifacts
 * and the newest [[KEPT_BLOCKMAP_VERSIONS]] keep their blockmaps, at different
 * depths because an update fetches only one of the two from the feed
 * ([[selectPrunable]] carries the electron-updater reading). Nothing is deleted
 * until both manifests are read back from the feed, so a publish that failed
 * deletes nothing; `--no-prune` skips it and `--dry-run` prints the decision
 * without making it.
 *
 * A publish whose manifests came back served also tags the commit it shipped:
 * `desktop-v<version>`, annotated with the release notes, pushed to `origin`.
 * Whether that tag can follow is decided **before the first upload**
 * ([[planReleaseTag]]) — a dirty tree, a tag already pointing elsewhere, or a
 * missing `origin` stops the publish while stopping it still costs nothing.
 * `--no-tag` turns the step off, preflight included.
 *
 * Usage: pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes <file>
 *        [--minimum-version <version>] [--republish] [--no-prune] [--no-tag]
 *        [--dry-run]
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
import { KEPT_ARTIFACT_VERSIONS, KEPT_BLOCKMAP_VERSIONS, selectPrunable } from './prune-feed.ts'
import { planReleaseTag, releaseTagName, type ReleaseTagPlan, type RepositoryState } from './release-tag.ts'

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
  /** Whether the published channels are pruned to the retention windows afterwards. */
  prune: boolean
  /** Whether the shipped commit is tagged and pushed once the feed serves it. */
  tag: boolean
  dryRun: boolean
}

function parseCli(argv: string[]): Cli {
  const { values } = parseArgs({
    args: argv,
    options: {
      notes: { type: 'string' },
      'minimum-version': { type: 'string' },
      republish: { type: 'boolean', default: false },
      'no-prune': { type: 'boolean', default: false },
      'no-tag': { type: 'boolean', default: false },
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
    prune: !values['no-prune'],
    tag: !values['no-tag'],
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
 * The first line of a caught failure, which is what a progress log carries;
 * the rest is a remote command's stderr and belongs to whoever re-runs it.
 * @param error - the caught value.
 * @returns its first message line, or the value stringified.
 */
function firstLine(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)
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
 * A differential download needs two blockmaps but fetches only one of them from
 * the feed. The new build's is always downloaded; the running version's is read
 * from the client's own cache (`current.blockmap`) and fetched from the feed —
 * at the URL `Provider.getBlockMapFiles` builds by substituting versions into
 * the new artifact's name — only when that cached copy is missing. Every
 * completed in-app update leaves the new blockmap in that cache, so the feed's
 * copy is what a fresh install or a cleared cache falls back to. It is still
 * worth having: a client that has to fetch it and cannot downloads the whole
 * artifact instead, with no error anywhere. [[pruneChannel]] therefore keeps
 * blockmaps [[KEPT_BLOCKMAP_VERSIONS]] versions deep, far past the artifacts.
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
        console.log(`publish: ${name} interrupted, resuming: ${firstLine(error)}`)
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
    console.log(`publish: the published latest.yml does not parse (${firstLine(error)}); replacing it`)
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
    // A transfer cut at the far end — the remote `cat` gone, the connection
    // dropped — surfaces as EPIPE on this pipe and nowhere else. It is an
    // 'error' event on a socket, so leaving it unhandled ends the process
    // instead of the attempt, and the caller's resume never runs.
    child.stdin.once('error', (error: Error) => {
      source.destroy()
      child.kill()
      reject(new Error(`publish: ssh append interrupted: ${error.message}`))
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

/**
 * Delete one channel's files that fall outside the retention windows.
 *
 * The directory is listed first and the whole decision — kept, unrecognized,
 * deleted — is logged before anything goes, so the record of a prune is
 * complete whether or not the delete that follows succeeds. Deletion is one
 * `rm` naming every file explicitly and quoted; each name came from `ls` of
 * this directory and is refused if it carries a path separator, so a prune
 * reaches nothing outside the channel it was given.
 * @param channel - the platform channel to prune.
 * @param version - the version just published, which anchors both windows.
 * @param publishedNames - the names this publish uploaded or rewrote there.
 * @param dryRun - print the decision and delete nothing.
 */
async function pruneChannel(channel: Channel, version: string, publishedNames: string[], dryRun: boolean): Promise<void> {
  const dir = `${REMOTE_ROOT}/${channel.name}`
  const listing = await remote(`ls -1 ${shellQuote(dir)}`)
  const names = listing.split('\n').map(line => line.trim()).filter(line => line !== '')
  const selection = selectPrunable(names, version, publishedNames)
  const targets = [...selection.deleteArtifacts, ...selection.deleteBlockmaps]
  const offender = targets.find(name => name.includes('/'))
  if (offender !== undefined) {
    throw new Error(`publish: ${JSON.stringify(offender)} names a path rather than a file in ${dir}; nothing was deleted.`)
  }
  console.log(`publish: ${channel.name}: keeping ${String(selection.keep.length)} of ${String(names.length)} file(s): ${selection.keep.join(', ')}`)
  if (selection.unparsed.length > 0) {
    console.log(`publish: ${channel.name}: leaving ${String(selection.unparsed.length)} unrecognized name(s) alone: ${selection.unparsed.join(', ')}`)
  }
  if (targets.length === 0) {
    console.log(`publish: ${channel.name}: nothing to prune — artifacts are kept ${String(KEPT_ARTIFACT_VERSIONS)} versions deep, blockmaps ${String(KEPT_BLOCKMAP_VERSIONS)}.`)
    return
  }
  const verb = dryRun ? 'would delete' : 'deleting'
  console.log(`publish: ${channel.name}: ${verb} ${String(selection.deleteArtifacts.length)} artifact(s) and ${String(selection.deleteBlockmaps.length)} blockmap(s): ${targets.join(', ')}`)
  if (dryRun) return
  await remote(`rm -f -- ${targets.map(name => shellQuote(`${dir}/${name}`)).join(' ')}`)
  console.log(`publish: ${channel.name}: deleted ${String(targets.length)} file(s)`)
}

/**
 * Prune every channel this publish wrote, one independently of the other.
 *
 * The manifests are already served by the time this runs, so a prune that
 * fails has nothing to undo: it is reported and the publish stands, and the
 * next one tries again with one more version of backlog.
 * @param cli - the parsed command line.
 * @param version - the version just published.
 * @param plan - each channel with the local artifact paths it uploaded.
 */
async function pruneFeed(cli: Cli, version: string, plan: Map<Channel, string[]>): Promise<void> {
  if (!cli.prune) {
    console.log('publish: --no-prune — the feed keeps every version it already holds.')
    return
  }
  for (const [channel, artifacts] of plan) {
    const publishedNames = [...artifacts.map(artifact => basename(artifact)), channel.manifest]
    try {
      await pruneChannel(channel, version, publishedNames, cli.dryRun)
    } catch (error) {
      console.log(`publish: WARNING — ${channel.name}: pruning failed, so the feed keeps every old file: ${firstLine(error)}`)
    }
  }
}

/**
 * Run one git command in this repository and return its stdout.
 * @param args - the git arguments, without the executable.
 * @returns the captured stdout.
 */
async function git(...args: string[]): Promise<string> {
  return capture('git', ['-C', APP_DIR, ...args])
}

/**
 * The commit a tag names in this repository.
 * @param tag - the tag to resolve.
 * @returns the commit, or undefined when the tag is not here.
 */
async function localTagCommit(tag: string): Promise<string | undefined> {
  try {
    return (await git('rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`)).trim()
  } catch {
    // `rev-parse --verify` exits non-zero for a ref that is not there, which is
    // the answer this returns rather than a failure. Nothing else runs in the
    // try, so no other error can be swallowed here.
    return undefined
  }
}

/**
 * The commit a tag names on `origin`.
 *
 * The peeled ref is asked for by name: an annotated tag's own object name is
 * not the commit, and `ls-remote` matches `refs/tags/<tag>^{}` only against a
 * pattern that spells it out — a lookup of the plain name alone returns the
 * tag object and reads as a tag pointing somewhere other than HEAD. A
 * lightweight tag has no peeled line and its one line already names the commit.
 * @param tag - the tag to look up.
 * @returns the commit, or undefined when `origin` does not carry the tag.
 */
async function remoteTagCommit(tag: string): Promise<string | undefined> {
  const lines = (await git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`))
    .split('\n').map(line => line.trim()).filter(line => line !== '')
  const peeled = lines.find(line => line.endsWith('^{}'))
  return (peeled ?? lines[0])?.split(/\s+/)[0]
}

/**
 * Read everything the tag decision needs from git, unless `--no-tag` turned
 * the step off — in which case nothing is read, so a repository that could not
 * be tagged anyway still publishes.
 * @param cli - the parsed command line.
 * @param tag - the tag this release would carry.
 * @returns the repository state, or undefined under `--no-tag`.
 */
async function readRepositoryState(cli: Cli, tag: string): Promise<RepositoryState | undefined> {
  if (!cli.tag) return undefined
  const remotes = (await git('remote')).split('\n').map(line => line.trim())
  const hasOrigin = remotes.includes('origin')
  return {
    headSha: (await git('rev-parse', 'HEAD')).trim(),
    localTagSha: await localTagCommit(tag),
    remoteTagSha: hasOrigin ? await remoteTagCommit(tag) : undefined,
    // Tracked files only. A release run leaves its own logs in the worktree and
    // an ignored `.env` lives there permanently; neither reaches the build, and
    // refusing on them would refuse every publish. This is the `git describe
    // --dirty` definition.
    dirty: (await git('status', '--porcelain', '--untracked-files=no')).trim() !== '',
    hasOrigin,
  }
}

/**
 * Announce the tagging plan before the first upload, and refuse the publish
 * when the tag could not follow it.
 *
 * Refusing here is the whole point of planning this early: the artifacts are
 * still only local, so a refusal costs a re-run rather than a live release
 * with no tag naming its source.
 * @param plan - what [[planReleaseTag]] decided.
 * @param version - the version being published.
 */
function announceReleaseTag(plan: ReleaseTagPlan, version: string): void {
  switch (plan.action) {
    case 'refuse':
      throw new Error(`publish: ${plan.reason}`)
    case 'skip':
      console.log(`publish: ${plan.reason}`)
      return
    case 'create':
      console.log(`publish: will tag HEAD ${plan.tag} once the feed serves ${version}`)
      return
    case 'push-existing':
      console.log(`publish: ${plan.tag} already names HEAD here; it will be pushed once the feed serves ${version}`)
      return
    case 'fetch-existing':
      console.log(`publish: origin already carries ${plan.tag} at HEAD; it will be fetched once the feed serves ${version}`)
      return
    case 'already-on-origin':
      console.log(`publish: origin and this repository already carry ${plan.tag} at HEAD; nothing will be created or pushed`)
  }
}

/**
 * What the tag step would do, for the dry-run log.
 * @param plan - what [[planReleaseTag]] decided.
 * @returns the line to print, or undefined when the step does nothing to print.
 */
function dryRunTagLine(plan: ReleaseTagPlan): string | undefined {
  switch (plan.action) {
    case 'create': return `would tag HEAD ${plan.tag} and push it to origin.`
    case 'push-existing': return `${plan.tag} already names HEAD here; would push it to origin.`
    case 'fetch-existing': return `origin already carries ${plan.tag} at HEAD; would fetch it.`
    case 'already-on-origin': return `origin already carries ${plan.tag} at HEAD; would run no git at all.`
    case 'skip': case 'refuse': return undefined
  }
}

/** What the tagging step did, for the closing summary. */
type TagOutcome = 'tagged' | 'skipped' | 'failed'

/**
 * Carry out the tagging plan, after the feed is serving the release: create
 * and push, push what is already here, fetch what `origin` already published,
 * or run no git at all when both sides already name HEAD.
 *
 * Nothing here can undo the publish, so a git failure is reported as exactly
 * what it is — a published release whose tag did not follow — with the command
 * that finishes it by hand, and the exit code carries the failure out.
 * @param plan - what [[planReleaseTag]] decided before the upload.
 * @param version - the version now serving.
 * @param notesPath - the release-notes file, which becomes the tag message.
 * @returns what happened, for the closing summary.
 */
async function applyReleaseTag(plan: ReleaseTagPlan, version: string, notesPath: string): Promise<TagOutcome> {
  if (plan.action === 'skip' || plan.action === 'refuse') return 'skipped'
  if (plan.action === 'already-on-origin') {
    console.log(`publish: ${plan.tag} already names HEAD on origin and here; nothing to create or push`)
    return 'tagged'
  }
  let created = plan.action === 'push-existing'
  try {
    if (plan.action === 'fetch-existing') {
      // origin published this tag from another clone or worktree. Creating a
      // second annotated object for the same name here would only produce a
      // push origin rejects; copying origin's is what makes the two agree.
      await git('fetch', 'origin', 'tag', plan.tag)
      console.log(`publish: fetched ${plan.tag} from origin, which already names HEAD`)
      return 'tagged'
    }
    if (!created) {
      await git('tag', '-a', plan.tag, '-F', notesPath)
      created = true
      console.log(`publish: tagged ${plan.tag}`)
    }
    await git('push', 'origin', plan.tag)
    console.log(`publish: pushed ${plan.tag} to origin`)
    return 'tagged'
  } catch (error) {
    const fetching = plan.action === 'fetch-existing'
    const manual = fetching
      ? `git fetch origin tag ${plan.tag}`
      : created
        ? `git push origin ${plan.tag}`
        : `git tag -a ${plan.tag} -F ${notesPath} && git push origin ${plan.tag}`
    const failure = fetching
      ? `, and origin already carries ${plan.tag}. Only this repository's copy of the tag failed`
      : '. Only the release tag failed'
    console.log(`publish: ${version} IS PUBLISHED — every artifact and both manifests are live and serving it${failure}: ${firstLine(error)}`)
    console.log(`publish: finish the tag by hand: ${manual}`)
    process.exitCode = 1
    return 'failed'
  }
}

/**
 * State the release's final position in one line, whatever the tag step did.
 * @param plan - what [[planReleaseTag]] decided.
 * @param version - the version now serving.
 * @param outcome - what [[applyReleaseTag]] did.
 */
function summarize(plan: ReleaseTagPlan, version: string, outcome: TagOutcome): void {
  const tag = releaseTagName(version)
  if (outcome === 'tagged') console.log(`publish: ${version} is serving on both channels, tagged ${tag}.`)
  else if (plan.action === 'skip') console.log(`publish: ${version} is serving on both channels; --no-tag, so no ${tag} tag was created.`)
  else console.log(`publish: ${version} is serving on both channels; ${tag} is NOT tagged — see the command above.`)
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  const notesPath = resolve(cli.notes)
  if (!existsSync(notesPath)) throw new Error(`publish: notes file ${notesPath} does not exist.`)
  const notes = (await readFile(notesPath, 'utf8')).trim()
  if (notes === '') throw new Error(`publish: notes file ${notesPath} is empty.`)

  const { version } = JSON.parse(await readFile(join(APP_DIR, 'package.json'), 'utf8')) as { version: string }
  console.log(`publish: releasing ${version}`)

  // Everything the tag needs is knowable now, and nothing about it improves by
  // waiting: a publish that cannot be tagged is stopped here, where stopping
  // means re-running rather than a live release with no commit naming it.
  const tagPlan = planReleaseTag({ version, repository: await readRepositoryState(cli, releaseTagName(version)) })
  announceReleaseTag(tagPlan, version)

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
    await pruneFeed(cli, version, plan)
    const tagLine = dryRunTagLine(tagPlan)
    if (tagLine !== undefined) console.log(`publish: dry run — ${tagLine}`)
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

  // Both manifests are served and name this version, so every artifact a
  // client can now be told to fetch is up. Only past this line does deleting
  // an older one mean anything but breaking the publish that is in flight.
  await pruneFeed(cli, version, plan)

  // The publish has fully succeeded, so the tag now names a commit whose build
  // is live. Tagging any earlier would leave a tag behind for a release that
  // never reached the feed.
  const tagged = await applyReleaseTag(tagPlan, version, notesPath)
  summarize(tagPlan, version, tagged)
}

await main()
