/**
 * Loopback plugin-admin service: the desktop shell lends its own package
 * manager to the embedded server, so a plugin the user installed can be updated
 * on a machine that has no pnpm and no terminal.
 *
 * The shell starts this before it spawns the server and passes the address and
 * the bearer token to that child process alone
 * (`DSH_DESKTOP_PLUGIN_ADMIN_ENDPOINT` / `DSH_DESKTOP_PLUGIN_ADMIN_TOKEN`); a
 * deployment that is not this shell — every `dsh web` on a server — sets
 * neither, and a plugin that finds neither reports the capability unavailable
 * rather than looking for pnpm itself. `apps/cli`'s own `dsh plugin` spawns a
 * bare `pnpm` off PATH, which is exactly what the customers this exists for do
 * not have.
 *
 * This is a **second** service beside [[startRenderService]], with a token of
 * its own, because the two lend different powers: the render token buys pixels
 * from a hidden window, and this one buys a package install. Widening the
 * render token to cover installs would have made every holder of it — the
 * screenshot tool included — able to change what the application runs.
 *
 * The security position is the whole reason the protocol is this narrow.
 *
 * - The listener binds `127.0.0.1` on an ephemeral port, so nothing off the
 *   machine reaches it, and every request carries a 32-byte token compared in
 *   constant time, so another local process cannot use it by finding the port.
 *   There is no CORS handling, because no browser origin is meant to reach it.
 * - The route is decided before the token is, so an unknown path is a 404
 *   rather than a 401: the answer says nothing about what this service offers
 *   to a caller that cannot authenticate anyway.
 * - **A caller names a package, never a specifier.** `profile` must be one of
 *   {@link ADMIN_PROFILES}, `version` must match {@link EXACT_VERSION} — a bare
 *   exact semver, so no range, tag, URL, git, or path spec can be smuggled
 *   through it — and `name` must be a key of that profile manifest's own
 *   `dependencies`, read from disk **in the handler** rather than believed from
 *   the request. The built-ins the shell seeds are listed in
 *   `dsh.profile.bundles` with no dependency entry, so they are outside the
 *   updatable set by construction, and so is every package the profile never
 *   installed.
 * - **Nothing installs without the person at the keyboard.**
 *   {@link PluginAdminSpec.confirm} is a native modal, so the confirmation
 *   cannot be forged by the web UI, and the mutating route runs one at a time.
 * - Every argument reaches `spawn` as an element of an array, never through a
 *   shell, and nothing a caller sends is concatenated into a command line.
 *
 * The pnpm the routes run is the shipped one
 * ({@link resolvePnpmLauncher}) — the bundled Node runtime executing
 * `resources/runtime/pnpm/bin/pnpm.mjs`. Only a development launch, which has
 * no such resource, falls back to `pnpm` on PATH. Nothing here ever fetches a
 * registry URL itself: pnpm reads the machine's own `.npmrc`, so a customer's
 * mirror, proxy, and credentials keep working exactly as they do for every
 * other install on that machine.
 * @module @deepseek-ai/dsh-desktop/plugin-admin-service
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { authorized, listenLoopback, mintToken, readBody, sendJson, sendText } from './loopback-service.ts'
import { dropBundleNames, profileDependencyNames, profileDirectory } from './profile-seed.ts'
import { augmentedEnv } from './server.ts'

/** Environment variable naming this service's origin, set on the server child alone. */
export const ENDPOINT_ENV = 'DSH_DESKTOP_PLUGIN_ADMIN_ENDPOINT'

/** Environment variable carrying this service's bearer token, set on the server child alone. */
export const TOKEN_ENV = 'DSH_DESKTOP_PLUGIN_ADMIN_TOKEN'

/** The route reporting which of a profile's packages have a newer version. */
export const OUTDATED_PATH = '/outdated'

/** The route reporting one published version's peer requirements. */
export const PEERS_PATH = '/peers'

/** The route that confirms with the user and installs. */
export const UPDATE_PATH = '/update'

/** The route that confirms with the user and restarts the application. */
export const RELAUNCH_PATH = '/relaunch'

/**
 * The profiles this service will act in.
 *
 * `desktop` is the profile the shell boots and `web` is the one it migrated
 * user plugins out of, which is still where those packages live — the desktop
 * profile links to them, so an update belongs in `web` for exactly those names.
 * Nothing else is reachable: a profile name is matched against this list rather
 * than joined into a path, so no `..` and no absolute path can name a directory.
 */
export const ADMIN_PROFILES = ['desktop', 'web'] as const

/** A profile this service will act in. */
type AdminProfile = typeof ADMIN_PROFILES[number]

/**
 * A bare exact version: `major.minor.patch` with optional prerelease and build
 * metadata, and nothing else.
 *
 * This is the whole defence against a caller turning an update into an
 * arbitrary install. pnpm accepts `latest`, `^1.2.3`, `git+ssh://…`,
 * `file:../…`, and a bare tarball URL in the same position, and any of them
 * would install code nobody named. A version this rejects never reaches an
 * argument array.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * An npm package name, scoped or bare.
 *
 * A name still has to be one this profile installed; this only settles that the
 * string is a package name at all, so nothing shaped like a flag or a path can
 * be joined with a version and handed to pnpm.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * Characters removed from a caller's warning line before it reaches a dialog.
 *
 * C0, DEL, and C1: a newline would add a line to a native modal, and the rest
 * are invisible in one.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g

/** The bounds one deployment of this service enforces. */
export interface PluginAdminLimits {
  /** Largest request body accepted, in bytes. */
  maxBodyBytes: number
  /** Characters of a caller's `warning` line shown in the confirmation dialog. */
  maxWarningChars: number
  /** Bytes of one captured output stream carried back in an answer. */
  maxOutputBytes: number
  /** Wall-clock budget for one `pnpm outdated` run. */
  outdatedTimeoutMs: number
  /** Wall-clock budget for one `pnpm view` run. */
  peersTimeoutMs: number
  /** Wall-clock budget for one `pnpm add` run; a cold store on a slow link is the case it is scaled to. */
  updateTimeoutMs: number
}

/** The bounds this shell runs with. */
export const PLUGIN_ADMIN_LIMITS: PluginAdminLimits = {
  maxBodyBytes: 16 * 1024,
  maxWarningChars: 400,
  maxOutputBytes: 8 * 1024,
  outdatedTimeoutMs: 120_000,
  peersTimeoutMs: 60_000,
  updateTimeoutMs: 600_000,
}

/** How to invoke pnpm: an executable and the arguments that precede every call's own. */
export interface PnpmLauncher {
  /** The program to spawn. */
  command: string
  /** Arguments before the pnpm subcommand — the bundled `pnpm.mjs` when Node is the program. */
  prefixArgs: readonly string[]
}

/** Where this launch's pnpm and Node runtime are. */
export interface PnpmLocation {
  /** Whether this is a packaged application, which is what ships a pnpm. */
  packaged: boolean
  /** `process.resourcesPath` of a packaged application. */
  resourcesPath: string
  /** Absolute path of the bundled Node binary. */
  nodeBin: string
}

/**
 * Resolve how to invoke pnpm for this launch.
 *
 * A packaged application runs the pnpm staged beside its Node runtime, under
 * that same Node: the machines this product targets have no package manager,
 * so anything resolved from PATH would be absent exactly where the feature is
 * needed. A development launch has no such resource and falls back to `pnpm` on
 * PATH, which is the developer's own — that fallback exists for the checkout
 * and reaches no customer.
 * @param location - what this launch is and where its resources are.
 * @returns the launcher to spawn.
 */
export function resolvePnpmLauncher(location: PnpmLocation): PnpmLauncher {
  if (!location.packaged) return { command: 'pnpm', prefixArgs: [] }
  return { command: location.nodeBin, prefixArgs: [join(location.resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')] }
}

/** One pnpm invocation. */
export interface PnpmRun {
  /** The pnpm arguments, already validated; each element is passed through untouched. */
  args: readonly string[]
  /** The profile directory to run in. */
  cwd: string
  /** Wall-clock budget for this run. */
  timeoutMs: number
}

/** What one pnpm invocation produced. */
export interface PnpmResult {
  /** Exit status, or null when a signal ended the process. */
  code: number | null
  /** The signal that ended the process, when one did. */
  signal: NodeJS.Signals | null
  /** Standard output, whole. */
  stdout: string
  /** Standard error, whole. */
  stderr: string
  /** Why the run produced no exit status, when spawning or the deadline is what ended it. */
  failure?: string
}

/** Run one pnpm invocation to completion. Injected, so the protocol is testable without pnpm. */
export type RunPnpm = (run: PnpmRun) => Promise<PnpmResult>

/**
 * Build the real runner over one launcher.
 *
 * The child inherits the shell's environment with the interactive PATH
 * locations appended, which is what a GUI-launched process on macOS lacks and
 * what pnpm needs to find `git` for a git-hosted dependency. It does **not**
 * inherit this service's endpoint or token: those are set on the server child
 * alone and never on `process.env`, so nothing pnpm runs can read them.
 *
 * `shell` is never set. Every argument arrives as an array element, so no value
 * a caller sent is ever parsed by a shell.
 * @param launcher - the program and prefix arguments to invoke.
 * @returns the runner.
 */
export function spawnPnpm(launcher: PnpmLauncher): RunPnpm {
  return async run => new Promise<PnpmResult>((resolve) => {
    const child = spawn(launcher.command, [...launcher.prefixArgs, ...run.args], {
      cwd: run.cwd,
      env: augmentedEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Without this a console window flashes for the bundled node.exe on Windows.
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (result: PnpmResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ code: null, signal: null, stdout, stderr, failure: `pnpm did not finish within ${String(run.timeoutMs)}ms` })
    }, run.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', (error) => {
      settle({ code: null, signal: null, stdout, stderr, failure: `pnpm could not be started: ${error.message}` })
    })
    child.once('close', (code, signal) => { settle({ code, signal, stdout, stderr }) })
  })
}

/** What one native confirmation asks. */
export interface ConfirmRequest {
  /** The dialog's title. */
  title: string
  /** The question, one line. */
  message: string
  /** The line under the question, when the caller supplied one. */
  detail?: string
  /** Label of the button that goes ahead. */
  confirmLabel: string
  /** Label of the button that does not. */
  cancelLabel: string
}

/**
 * Put one confirmation in front of the user.
 *
 * Injected rather than called directly, which is what lets this whole protocol
 * be tested without Electron — and what keeps the dialog a native window the
 * web UI cannot draw over or answer for.
 * @param request - what to ask.
 * @returns true when the user chose to go ahead.
 */
type Confirm = (request: ConfirmRequest) => Promise<boolean>

/** What this service needs from the shell around it. */
export interface PluginAdminSpec {
  /** The Harness home whose profiles this acts in. */
  home: string
  /** How to run pnpm. */
  run: RunPnpm
  /** The native confirmation half. */
  confirm: Confirm
  /** Restart the application; called only after the user confirmed. */
  relaunch: () => void
  /** The bounds this deployment enforces. */
  limits: PluginAdminLimits
}

/** A listening plugin-admin service: where it is, what opens it, and how it stops. */
export interface PluginAdminHandle {
  /** Origin the server child is told to POST to, always on the loopback address. */
  endpoint: string
  /** The bearer token this service accepts, generated fresh for every launch. */
  token: string
  /** Stop listening and drop open connections; resolves once the listener is closed. */
  close: () => Promise<void>
}

/** A rejected request: the status to answer and the one line explaining it. */
interface Rejection {
  ok: false
  /** 400 for a malformed request, 422 for a well-formed one naming something this service will not act on. */
  status: 400 | 422
  message: string
}

/** What the four routes are, once method and path have been read. */
type Route = 'outdated' | 'peers' | 'update' | 'relaunch'

/**
 * Which route one request names.
 * @param method - the HTTP method.
 * @param path - the request path.
 * @returns the route, or undefined for the 404 every other method and path gets.
 */
function routeOf(method: string, path: string): Route | undefined {
  if (method !== 'POST') return undefined
  if (path === OUTDATED_PATH) return 'outdated'
  if (path === PEERS_PATH) return 'peers'
  if (path === UPDATE_PATH) return 'update'
  if (path === RELAUNCH_PATH) return 'relaunch'
  return undefined
}

/** The request fields these routes read, all still unknown before validation. */
interface AdminBody {
  profile?: unknown
  name?: unknown
  version?: unknown
  warning?: unknown
}

/**
 * The profile one request names.
 * @param value - the field as the body carried it.
 * @returns the profile, or the refusal.
 */
function profileOf(value: unknown): { ok: true; profile: AdminProfile } | Rejection {
  if (typeof value !== 'string') return { ok: false, status: 400, message: 'profile must be a string' }
  const found = ADMIN_PROFILES.find(one => one === value)
  if (found === undefined) {
    return { ok: false, status: 400, message: `profile must be one of ${ADMIN_PROFILES.join(', ')}` }
  }
  return { ok: true, profile: found }
}

/**
 * The exact version one request names.
 * @param value - the field as the body carried it.
 * @returns the version, or the refusal.
 */
function versionOf(value: unknown): { ok: true; version: string } | Rejection {
  if (typeof value !== 'string') return { ok: false, status: 400, message: 'version must be a string' }
  if (!EXACT_VERSION.test(value)) {
    return { ok: false, status: 400, message: 'version must be one exact published version (1.2.3 or 1.2.3-rc.4); a range, a tag, a URL, or a path is not a version this service installs' }
  }
  return { ok: true, version: value }
}

/**
 * The package one request names, checked against what that profile actually
 * installed.
 *
 * The dependency list is read from the manifest on every call rather than
 * carried in memory or believed from the request: it is the fence, and a
 * profile is user data that changes under this process.
 * @param value - the field as the body carried it.
 * @param profileDir - the directory whose manifest decides.
 * @returns the name, or the refusal.
 */
function packageOf(value: unknown, profileDir: string): { ok: true; name: string } | Rejection {
  if (typeof value !== 'string') return { ok: false, status: 400, message: 'name must be a string' }
  if (!PACKAGE_NAME.test(value)) return { ok: false, status: 400, message: `name ${JSON.stringify(value)} is not a package name` }
  if (!profileDependencyNames(profileDir).includes(value)) {
    return { ok: false, status: 422, message: `${value} is not a plugin this profile installed, so there is nothing here to update` }
  }
  return { ok: true, name: value }
}

/**
 * The caller's warning line, reduced to something a dialog can show.
 *
 * The text is composed by a plugin and shown to the user in a native window, so
 * it is treated as untrusted display data: every control character becomes a
 * space, so nothing can add a line or blank the rest of the dialog, and the
 * result is capped.
 * @param value - the field as the body carried it.
 * @param maxChars - the cap.
 * @returns the line, or the refusal; `undefined` is a request that sent none.
 */
function warningOf(value: unknown, maxChars: number): { ok: true; warning: string | undefined } | Rejection {
  if (value === undefined) return { ok: true, warning: undefined }
  if (typeof value !== 'string') return { ok: false, status: 400, message: 'warning must be a string' }
  const flattened = value.replace(CONTROL_CHARACTERS, ' ').replace(/ {2,}/g, ' ').trim()
  if (flattened === '') return { ok: true, warning: undefined }
  return { ok: true, warning: flattened.slice(0, maxChars) }
}

/**
 * One captured stream, cut to the answer's cap.
 * @param text - the whole stream.
 * @param maxBytes - the cap.
 * @returns the text, ending in an ellipsis when it was cut.
 */
function bounded(text: string, maxBytes: number): string {
  const trimmed = text.trim()
  return Buffer.byteLength(trimmed, 'utf8') <= maxBytes ? trimmed : `${trimmed.slice(0, maxBytes)}…`
}

/**
 * The exit facts every answer carries, so a caller reads how the run ended the
 * same way whichever route it asked.
 * @param result - the finished run.
 * @param limits - the bounds whose output cap applies.
 * @returns the fields to spread into the answer.
 */
function exitFields(result: PnpmResult, limits: PluginAdminLimits): Record<string, unknown> {
  const stderr = bounded(result.stderr, limits.maxOutputBytes)
  return {
    exitCode: result.code,
    signal: result.signal,
    ...result.failure === undefined ? {} : { failure: result.failure },
    ...stderr === '' ? {} : { stderr },
  }
}

/**
 * Read one pnpm `--json` answer.
 *
 * pnpm prints nothing at all where a query has no answer (`pnpm view` for a
 * package that declares no peers), and prints diagnostics rather than JSON when
 * a run failed. Both come back as `undefined` with the raw text carried beside
 * it, so the caller can tell "nothing to report" from "this did not run".
 * @param stdout - what the run printed.
 * @returns the parsed value, or undefined when there was none to parse.
 */
function parsedJson(stdout: string): unknown {
  const text = stdout.trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    // pnpm printed something other than the JSON it was asked for, which is
    // what a failed run looks like; `output` in the answer carries it verbatim.
    return undefined
  }
}

/** What one profile's own `node_modules` holds for a package right now. */
interface InstalledPackage {
  /** The version on disk. */
  version: string
  /** Whether that version declares itself a bundle layer. */
  bundle: boolean
}

/**
 * Read what a profile's own `node_modules` holds for a package.
 *
 * This is the fact that says whether an install worked, which is why it is
 * read rather than inferred: see the answer this route builds.
 * @param profileDir - the profile the package was installed into.
 * @param name - the package name.
 * @returns what is installed, or undefined when nothing readable is.
 */
function installedPackage(profileDir: string, name: string): InstalledPackage | undefined {
  let manifest: { version?: unknown; dsh?: { bundle?: unknown } }
  try {
    manifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8')) as typeof manifest
  } catch {
    // Absent on a profile whose install did not happen, and unreadable on one
    // whose package directory is half written; neither is a version to report.
    return undefined
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') return undefined
  return { version: manifest.version, bundle: manifest.dsh?.bundle !== undefined }
}

/**
 * Start the loopback plugin-admin service and listen on an ephemeral port.
 * @param spec - the home to act in, how to run pnpm, how to ask the user, and the bounds to enforce.
 * @returns the listening service: its endpoint, its token, and its stop.
 * @throws when the loopback listener cannot be opened.
 */
export async function startPluginAdminService(spec: PluginAdminSpec): Promise<PluginAdminHandle> {
  const { limits } = spec
  const token = mintToken()
  /**
   * Whether a mutating run is in flight. Two installs in the same profile
   * directory would race pnpm's own lockfile write, and two dialogs would ask
   * the user about the second before the first was applied.
   */
  let mutating = false

  const dirOf = (profile: AdminProfile): string => profileDirectory(spec.home, profile)

  const runOutdated = async (profile: AdminProfile, response: ServerResponse): Promise<void> => {
    const result = await spec.run({ args: ['outdated', '--json'], cwd: dirOf(profile), timeoutMs: limits.outdatedTimeoutMs })
    const packages = parsedJson(result.stdout)
    sendJson(response, 200, {
      profile,
      // pnpm's own object, name for name — this service adds no field to it and
      // renames none, so the caller reads what pnpm reported.
      packages: packages ?? null,
      ...packages === undefined && result.stdout.trim() !== '' ? { output: bounded(result.stdout, limits.maxOutputBytes) } : {},
      ...exitFields(result, limits),
    })
  }

  const runPeers = async (profile: AdminProfile, name: string, version: string, response: ServerResponse): Promise<void> => {
    const result = await spec.run({
      args: ['view', `${name}@${version}`, 'peerDependencies', '--json'],
      cwd: dirOf(profile),
      timeoutMs: limits.peersTimeoutMs,
    })
    const peers = parsedJson(result.stdout)
    sendJson(response, 200, {
      profile,
      name,
      version,
      // An empty answer is a package that declares no peers, which is a fact
      // rather than a failure; the exit fields say which of the two it was.
      peers: peers ?? null,
      ...exitFields(result, limits),
    })
  }

  const runUpdate = async (
    profile: AdminProfile,
    name: string,
    version: string,
    warning: string | undefined,
    response: ServerResponse,
  ): Promise<void> => {
    const confirmed = await spec.confirm({
      title: '更新插件',
      message: `将 ${name} 更新到 ${version}？`,
      ...warning === undefined ? {} : { detail: warning },
      confirmLabel: '更新',
      cancelLabel: '取消',
    })
    if (!confirmed) {
      sendJson(response, 200, { profile, name, version, confirmed: false })
      return
    }
    const dir = dirOf(profile)
    const result = await spec.run({ args: ['add', `${name}@${version}`], cwd: dir, timeoutMs: limits.updateTimeoutMs })
    // **The version on disk is what says the install worked, not the exit
    // status.** `pnpm add` exits 1 with `ERR_PNPM_IGNORED_BUILDS` while
    // installing correctly, on every profile that has not answered its
    // build-approval question — which is every profile this shell seeds, whose
    // `pnpm-workspace.yaml` names no `allowBuilds`, for any plugin whose tree
    // carries a package with an install script. Reading the exit status as the
    // outcome would report a finished install as a failure, and take the undo
    // and the restart prompt down with it. The status is still reported, so a
    // caller can say what pnpm complained about.
    const found = installedPackage(dir, name)
    const installed = found !== undefined && found.version === version
    // A package that stopped declaring `dsh.bundle` still resolves, so
    // `loadProfile` gets past resolution and then refuses the layer, ending the
    // boot. The same removal the seed performs for a migrated name that lost
    // its bundle applies here, and for the same reason: this shell put the name
    // in that list, so this shell takes it back out.
    const stillBundle = installed ? found.bundle : null
    // A write that fails here answers `stillBundle: false` with nothing
    // dropped, which is the state: the package stopped being a bundle and its
    // entry is still listed. The install itself succeeded, and reporting that
    // as a failed request would be wrong about what is on disk.
    let droppedFromBundles: string[] = []
    if (stillBundle === false) {
      try {
        droppedFromBundles = dropBundleNames(join(dir, 'package.json'), [name])
      } catch {
        // The manifest pnpm has just rewritten could not be replaced; the next
        // launch reports the entry it cannot mount, which is the same repair
        // path a migrated name takes.
      }
    }
    sendJson(response, 200, {
      profile,
      name,
      version,
      confirmed: true,
      // The whole outcome, in one field: equal to `version` when the install
      // put what was asked for on disk, and anything else — including null —
      // when it did not.
      installedVersion: found?.version ?? null,
      stillBundle,
      droppedFromBundles,
      ...result.stdout.trim() === '' ? {} : { output: bounded(result.stdout, limits.maxOutputBytes) },
      ...exitFields(result, limits),
    })
  }

  const runRelaunch = async (response: ServerResponse): Promise<void> => {
    const confirmed = await spec.confirm({
      title: '重启应用',
      message: '重启应用以完成更新？',
      confirmLabel: '重启',
      cancelLabel: '稍后',
    })
    // Answered before the relaunch, so the caller learns the verdict rather
    // than losing the socket to the quit it asked for.
    sendJson(response, 200, { confirmed })
    if (confirmed) spec.relaunch()
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const method = request.method ?? 'unknown'
      const route = routeOf(method, path)
      if (route === undefined) {
        sendText(response, 404, `no route for ${method} ${path}`)
        return
      }
      if (!authorized(request.headers.authorization, token)) {
        sendText(response, 401, 'authorization must be Bearer <token> carrying this service\'s token')
        return
      }
      if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
        sendText(response, 400, 'content-type must be application/json')
        return
      }
      const body = await readBody(request, limits.maxBodyBytes)
      if (body === undefined) {
        sendText(response, 400, `body must be at most ${String(limits.maxBodyBytes)} bytes`)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch (error) {
        sendText(response, 400, `body must be JSON: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (route === 'relaunch') {
        await runRelaunch(response)
        return
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        sendText(response, 400, 'body must be a JSON object')
        return
      }
      const fields = parsed as AdminBody
      const profile = profileOf(fields.profile)
      if (!profile.ok) {
        sendText(response, profile.status, profile.message)
        return
      }
      if (route === 'outdated') {
        await runOutdated(profile.profile, response)
        return
      }
      const named = packageOf(fields.name, dirOf(profile.profile))
      if (!named.ok) {
        sendText(response, named.status, named.message)
        return
      }
      const version = versionOf(fields.version)
      if (!version.ok) {
        sendText(response, version.status, version.message)
        return
      }
      if (route === 'peers') {
        await runPeers(profile.profile, named.name, version.version, response)
        return
      }
      const warning = warningOf(fields.warning, limits.maxWarningChars)
      if (!warning.ok) {
        sendText(response, warning.status, warning.message)
        return
      }
      if (mutating) {
        sendText(response, 503, 'busy: a plugin update is already running')
        return
      }
      mutating = true
      try {
        await runUpdate(profile.profile, named.name, version.version, warning.warning, response)
      } finally {
        mutating = false
      }
    } catch (error) {
      sendText(response, 500, `plugin admin failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const server = createServer((request, response) => {
    // `handle` answers every failure itself, so nothing here can reject.
    void handle(request, response)
  })
  const endpoint = await listenLoopback(server, 'plugin admin service')
  return {
    endpoint,
    token,
    close: async () => {
      // Sockets a caller left open would otherwise hold the listener open past
      // the quit that asked for it to close.
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
      })
    },
  }
}
