/**
 * Loopback Office engine service: the desktop shell lends the embedded server
 * the one thing it cannot do for itself, installing the LibreOffice engine the
 * payload leaves out.
 *
 * The shell starts this before it spawns the server and passes the address and
 * the bearer token to that child process alone ([[ENDPOINT_ENV]] /
 * [[TOKEN_ENV]]). A deployment that is not this shell — every `dsh web` on a
 * server, which ships its engine — sets neither, and the plugin that reads them
 * then offers no download.
 *
 * The service has its own token, separate from the render and update
 * services: this one buys a package install into the data directory, and
 * admission to one service is never admission to another.
 *
 * The protocol is three routes and no request body.
 *
 * | Route | Answer |
 * |---|---|
 * | `GET /state` | `200` — the {@link EngineSnapshot} |
 * | `POST /install` | `202` — the snapshot, now `confirming`; `409` — an {@link EngineRefusal} |
 * | `POST /cancel` | `202` — the snapshot; `409` — an {@link EngineRefusal} |
 *
 * Every other path and method is `404`, decided before the token is read. A
 * missing or wrong token is `401`.
 *
 * **Nothing downloads without the person at the keyboard.** `POST /install`
 * puts a native confirmation up and answers at once; the download starts only
 * when the person chooses the confirming button there, which is not the
 * dialog's default button. A native modal is the one window a page in the app
 * cannot draw over or answer for. After the person declines, `POST /install`
 * is refused for {@link DECLINE_COOLDOWN_MS} without asking again, so a page
 * cannot put the question back up the moment it is answered. A caller names
 * nothing: the package and version are the ones the shipped kit declares, read
 * by the shell, so no request can make this service install anything else.
 * @module @deepseek-ai/dsh-desktop-shell/office-engine-service
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { authorized, listenLoopback, mintToken, sendJson, sendText } from './loopback-service.ts'
import type { PnpmInvocation } from './pnpm-launcher.ts'
import {
  engineInstalled, installEngine, pruneEngineRoot, type EngineRequirement, type InstallOutcome, type InstallSpec,
  type RequirementResult,
} from './office-engine.ts'

/** Environment variable naming this service's origin, set on the server child alone. */
export const ENDPOINT_ENV = 'DSH_DESKTOP_OFFICE_ENGINE_ENDPOINT'

/** Environment variable carrying this service's bearer token, set on the server child alone. */
export const TOKEN_ENV = 'DSH_DESKTOP_OFFICE_ENGINE_TOKEN'

/** The route reporting where the engine stands. */
export const STATE_PATH = '/state'

/** The route asking the person to confirm, then downloading. */
export const INSTALL_PATH = '/install'

/** The route stopping a running download. */
export const CANCEL_PATH = '/cancel'

/** How long one package-manager run may take before it is stopped; a cold download on a slow link is the case it is scaled to. */
export const INSTALL_TIMEOUT_MS = 30 * 60_000

/** How long `POST /install` is refused after the person declines the confirmation. */
export const DECLINE_COOLDOWN_MS = 30_000

/**
 * Why a command was refused, the `code` of a `409` body.
 *
 * - `unsupported` — this launch offers no engine.
 * - `installed` — the engine is already installed.
 * - `confirming` — the confirmation is on screen.
 * - `installing` — a download is running.
 * - `declined-recently` — the person declined the confirmation less than
 *   {@link DECLINE_COOLDOWN_MS} ago.
 * - `not-running` — a cancel arrived with no download running.
 */
export type EngineRefusalCode = 'unsupported' | 'installed' | 'confirming' | 'installing' | 'declined-recently' | 'not-running'

/** The `409` body: the refusal's code, and a sentence for logs and tooltips. */
export interface EngineRefusal {
  /** Why the command was refused. */
  code: EngineRefusalCode
  /** The same, as one plain sentence. */
  message: string
}

/**
 * Where the engine stands.
 *
 * - `unsupported` — this launch can offer no engine (no native build for the
 *   host, or a kit that names none); `reason` says which.
 * - `absent` — not installed; a download can be offered.
 * - `confirming` — the native confirmation is on screen.
 * - `installing` — the package manager is running.
 * - `installed` — the engine is on disk where the server looks for it.
 * - `failed` — the last download did not finish; `reason` says why, and a
 *   download can be offered again.
 */
export type EnginePhase = 'unsupported' | 'absent' | 'confirming' | 'installing' | 'installed' | 'failed'

/** The `/state` body. */
export interface EngineSnapshot {
  /** Where the engine stands. */
  phase: EnginePhase
  /** The engine version this launch requires, when there is one. */
  version?: string
  /** The published download size in bytes, when the shell knows it. */
  downloadBytes?: number
  /** Bytes received so far, while `installing`. */
  transferredBytes?: number
  /** The download's total bytes, while `installing`, when known. */
  totalBytes?: number
  /** The plain sentence for `unsupported` and `failed`. */
  reason?: string
}

/** What one native confirmation asks. */
export interface EngineConfirmRequest {
  /** The dialog's title. */
  title: string
  /** The question. */
  message: string
  /** The line under it. */
  detail: string
  /** Label of the button that downloads. */
  confirmLabel: string
  /** Label of the button that does not. */
  cancelLabel: string
}

/** Runs one install; {@link installEngine} in production, injected so a test needs no package manager. */
export type RunInstall = (spec: InstallSpec) => Promise<InstallOutcome>

/** What the engine manager needs from the shell around it. */
export interface OfficeEngineSpec {
  /** The engine this launch requires, or why there is none. */
  requirement: RequirementResult
  /** {@link officeEngineRoot} of this launch's data directory. */
  root: string
  /** How to run the package manager. */
  pnpm: PnpmInvocation
  /**
   * Put the confirmation in front of the person.
   * @param request - what to ask.
   * @returns true when they chose to download.
   */
  confirm: (request: EngineConfirmRequest) => Promise<boolean>
  /** Receives one line per state change worth keeping in the log; never the token. */
  log: (line: string) => void
  /** Wall-clock budget for one package-manager run. */
  installTimeoutMs: number
  /** How long `POST /install` is refused after the person declines; {@link DECLINE_COOLDOWN_MS} in production. */
  declineCooldownMs: number
  /** The installer; {@link installEngine} when omitted. */
  install?: RunInstall
  /** The clock the cooldown reads; `Date.now` when omitted. */
  now?: () => number
}

/**
 * The confirmation text for one engine.
 * @param requirement - the engine to be downloaded.
 * @returns the dialog's fields.
 */
export function confirmRequest(requirement: EngineRequirement): EngineConfirmRequest {
  const size = requirement.downloadBytes === undefined ? '' : `约 ${String(Math.round(requirement.downloadBytes / (1024 * 1024)))} MB，`
  return {
    title: '下载预览组件',
    message: '下载预览 Word 和 PPT 文件需要的组件？',
    detail: `${size}下载后保存在这台电脑上，之后在应用里打开这类文件会直接显示内容。`,
    confirmLabel: '下载',
    cancelLabel: '取消',
  }
}

/** The fields of a native message box, as Electron's `showMessageBox` takes them. */
export interface ConfirmDialogOptions {
  /** Always `question`. */
  type: 'question'
  /** The dialog's title. */
  title: string
  /** The question. */
  message: string
  /** The line under it. */
  detail: string
  /** The button labels, confirming first. */
  buttons: [string, string]
  /** The button Return chooses. */
  defaultId: number
  /** The answer Escape or closing the dialog gives. */
  cancelId: number
}

/**
 * The native message box for one confirmation. Return, Escape, and closing
 * the dialog all choose the cancelling button; only choosing the confirming
 * button downloads.
 * @param request - what to ask.
 * @returns the message box fields; the confirming button is index 0.
 */
export function confirmDialogOptions(request: EngineConfirmRequest): ConfirmDialogOptions {
  return {
    type: 'question',
    title: request.title,
    message: request.message,
    detail: request.detail,
    buttons: [request.confirmLabel, request.cancelLabel],
    defaultId: 1,
    cancelId: 1,
  }
}

/** The engine's state machine: what it reports, and the one install it may run at a time. */
export class OfficeEngineManager {
  private readonly spec: OfficeEngineSpec
  private readonly run: RunInstall
  private readonly now: () => number
  private declinedAt: number | undefined
  private phase: 'idle' | 'confirming' | 'installing' = 'idle'
  private failure: string | undefined
  private progress: { transferredBytes: number; totalBytes?: number } | undefined
  private controller: AbortController | undefined
  private running: Promise<void> | undefined
  private closed = false

  /**
   * @param spec - the requirement, the root, and the shell hooks.
   */
  constructor(spec: OfficeEngineSpec) {
    this.spec = spec
    this.run = spec.install ?? installEngine
    this.now = spec.now ?? Date.now
  }

  /**
   * Where the engine stands. `installed` is read from disk on every call, so
   * an engine removed by hand reads `absent` again without a restart.
   * @returns the snapshot.
   */
  snapshot(): EngineSnapshot {
    const found = this.spec.requirement
    if (!found.ok) return { phase: 'unsupported', reason: found.reason }
    const { requirement } = found
    const base = {
      version: requirement.version,
      ...requirement.downloadBytes === undefined ? {} : { downloadBytes: requirement.downloadBytes },
    }
    if (this.phase === 'confirming') return { phase: 'confirming', ...base }
    if (this.phase === 'installing') {
      return {
        phase: 'installing',
        ...base,
        transferredBytes: this.progress?.transferredBytes ?? 0,
        ...this.progress?.totalBytes === undefined ? {} : { totalBytes: this.progress.totalBytes },
      }
    }
    if (engineInstalled(this.spec.root, requirement)) return { phase: 'installed', ...base }
    if (this.failure !== undefined) return { phase: 'failed', ...base, reason: this.failure }
    return { phase: 'absent', ...base }
  }

  /**
   * Ask the person, then download. Returns once the question is on screen.
   * @returns undefined when the confirmation went up, or the refusal the 409 carries.
   */
  requestInstall(): EngineRefusal | undefined {
    const found = this.spec.requirement
    if (!found.ok) return { code: 'unsupported', message: found.reason }
    if (this.phase === 'confirming') return { code: 'confirming', message: 'the download is waiting for the person to confirm it' }
    if (this.phase === 'installing') return { code: 'installing', message: 'the preview component is already downloading' }
    if (engineInstalled(this.spec.root, found.requirement)) return { code: 'installed', message: 'the preview component is already installed' }
    if (this.declinedAt !== undefined && this.now() - this.declinedAt < this.spec.declineCooldownMs) {
      return { code: 'declined-recently', message: 'the download was just declined; it can be asked for again in a moment' }
    }
    this.declinedAt = undefined
    this.phase = 'confirming'
    this.running = this.confirmThenInstall(found.requirement)
    return undefined
  }

  /**
   * Stop the running download.
   * @returns undefined when a download was stopped, or the refusal the 409 carries.
   */
  cancel(): EngineRefusal | undefined {
    if (this.phase !== 'installing' || this.controller === undefined) return { code: 'not-running', message: 'no download of the preview component is running' }
    this.controller.abort()
    return undefined
  }

  /**
   * Stop whatever is running and wait for it to end. A quit calls this, so a
   * download cut off by it leaves only a staging directory the next launch
   * removes.
   */
  async close(): Promise<void> {
    this.closed = true
    // A confirmation still on screen is not waited for: the quit takes the
    // dialog with it, and `closed` keeps an answer that arrives first from
    // starting a download.
    if (this.controller === undefined) return
    this.controller.abort()
    await this.running
  }

  /**
   * The confirmation, then the install it allows.
   * @param requirement - the engine to install.
   */
  private async confirmThenInstall(requirement: EngineRequirement): Promise<void> {
    let confirmed: boolean
    try {
      confirmed = await this.spec.confirm(confirmRequest(requirement))
    } catch (error) {
      this.phase = 'idle'
      this.spec.log(`[desktop] office engine: the confirmation could not be shown (${error instanceof Error ? error.message : String(error)})\n`)
      return
    }
    if (!confirmed || this.closed) {
      this.phase = 'idle'
      if (!confirmed) this.declinedAt = this.now()
      return
    }
    this.phase = 'installing'
    this.failure = undefined
    this.progress = requirement.downloadBytes === undefined
      ? { transferredBytes: 0 }
      : { transferredBytes: 0, totalBytes: requirement.downloadBytes }
    const controller = new AbortController()
    this.controller = controller
    this.spec.log(`[desktop] office engine: installing ${requirement.name}@${requirement.version} into ${this.spec.root}\n`)
    const outcome = await this.run({
      root: this.spec.root,
      requirement,
      pnpm: this.spec.pnpm,
      signal: controller.signal,
      timeoutMs: this.spec.installTimeoutMs,
      onProgress: (progress) => { this.progress = progress },
    })
    this.controller = undefined
    this.progress = undefined
    this.phase = 'idle'
    if (outcome.ok) {
      this.spec.log(`[desktop] office engine: ${requirement.name}@${requirement.version} installed\n`)
      const pruned = pruneEngineRoot(this.spec.root, requirement.version)
      for (const line of pruned.failed) this.spec.log(`[desktop] office engine: could not remove ${line}\n`)
      return
    }
    this.spec.log(`[desktop] office engine: install ${outcome.cancelled ? 'cancelled' : `failed: ${outcome.reason}`}\n`)
    this.failure = outcome.cancelled ? undefined : outcome.reason
  }
}

/** A listening engine service: where it is, what opens it, and how it stops. */
export interface OfficeEngineServiceHandle {
  /** Origin the server child is told to call, always on the loopback address. */
  endpoint: string
  /** The bearer token this service accepts, generated fresh for every launch. */
  token: string
  /** Stop listening, stop any download, and resolve once both have ended. */
  close: () => Promise<void>
}

/** What the three routes are, once method and path have been read. */
type Route = 'state' | 'install' | 'cancel'

/**
 * Which route one request names.
 * @param method - the HTTP method.
 * @param path - the request path.
 * @returns the route, or undefined for the 404 every other method and path gets.
 */
function routeOf(method: string, path: string): Route | undefined {
  if (method === 'GET' && path === STATE_PATH) return 'state'
  if (method !== 'POST') return undefined
  if (path === INSTALL_PATH) return 'install'
  if (path === CANCEL_PATH) return 'cancel'
  return undefined
}

/**
 * Start the loopback engine service over one manager.
 * @param manager - the state machine the routes read and drive.
 * @returns the listening service.
 * @throws when the loopback listener cannot be opened.
 */
export async function startOfficeEngineService(manager: OfficeEngineManager): Promise<OfficeEngineServiceHandle> {
  const token = mintToken()

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    // No route reads a body; an unread request would take the socket down
    // with the answer rather than letting the connection be reused.
    request.resume()
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
    if (route === 'state') {
      sendJson(response, 200, manager.snapshot())
      return
    }
    const refusal = route === 'install' ? manager.requestInstall() : manager.cancel()
    if (refusal !== undefined) {
      sendJson(response, 409, refusal)
      return
    }
    sendJson(response, 202, manager.snapshot())
  }

  const server = createServer((request, response) => {
    try {
      handle(request, response)
    } catch (error) {
      sendText(response, 500, `office engine service failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const endpoint = await listenLoopback(server, 'office engine service')
  return {
    endpoint,
    token,
    close: async () => {
      server.closeAllConnections()
      await Promise.all([
        manager.close(),
        new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
      ])
    },
  }
}
