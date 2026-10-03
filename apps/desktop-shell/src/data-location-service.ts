/**
 * Loopback data-location service: the desktop shell lends the embedded server
 * what the Settings window needs to show where the data is and to move it —
 * the native folder picker, the move's checks, and the move itself, which
 * stops that server and relaunches the application.
 *
 * Built like the update service ([[@deepseek-ai/dsh-desktop-shell/update-service]]):
 * the shell starts it before it spawns the server and passes the address and
 * the bearer token to that child alone ([[ENDPOINT_ENV]] / [[TOKEN_ENV]]); a
 * deployment that is not this shell sets neither, and the plugin reports the
 * capability unavailable. It has a token of its own: moving the data is not
 * something admission to another service may buy.
 *
 * | Route | Body | Answer |
 * |---|---|---|
 * | `GET /state` | — | `200` — the {@link DataLocationState} |
 * | `POST /choose` | — | `200` — `{ "path": "…" }`, or `{}` if cancelled; `409` — `{ "reason": "choosing" }` |
 * | `POST /preflight` | {@link MoveBody} | `200` — the {@link PreflightResult} |
 * | `POST /start` | {@link MoveBody} | `202` — `{ "ok": true }` once the journal is written; `409` — the {@link MoveRefusal} |
 * | `POST /retry-cleanup` | — | `202` — `{ "ok": true }` when the cleanup runs again; `409` — `{ "reason" }` |
 *
 * One picker is open at a time (`choosing`); a `/start` while another is still
 * checking is refused as `in-progress`; `/retry-cleanup`'s reasons are
 * {@link RetryCleanupAnswer}.
 *
 * Every other path and method is `404`, decided before the token is read; a
 * missing or wrong token is `401`; a body over {@link MAX_BODY_BYTES} is
 * `413`, and one that is not a {@link MoveBody} is `400`. Errors are one line
 * of `text/plain`. Answers carry kinds and paths, never sentences: the
 * Settings window words them.
 *
 * **`POST /start` answers before it acts.** The move stops the embedded server
 * that is waiting on this response, so the checks run and the journal is
 * written first (a refusal is the `409`), `202` is written, and only on the
 * next tick is the move carried on. What happens after that — a withdrawal
 * because the server's processes did not stop, say — is reported by the next
 * `GET /state`, when the server is running again.
 * @module @deepseek-ai/dsh-desktop-shell/data-location-service
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { TerminalSync } from './data-location-boot.ts'
import { authorized, listenLoopback, mintToken, readBody, sendJson, sendText } from './loopback-service.ts'
import type { MoveRefusal, MoveStartOutcome } from './move-start.ts'
import type { MoveJournal, MoveResult } from './move/journal.ts'
import type { PreflightResult } from './move/preflight.ts'

/** Environment variable naming this service's origin, set on the server child alone. */
export const ENDPOINT_ENV = 'DSH_DESKTOP_DATA_ENDPOINT'

/** Environment variable carrying this service's bearer token, set on the server child alone. */
export const TOKEN_ENV = 'DSH_DESKTOP_DATA_TOKEN'

/** The route reporting where the data is and how the last move went. */
export const STATE_PATH = '/state'

/** The route opening the native folder picker. */
export const CHOOSE_PATH = '/choose'

/** The route checking a folder without moving anything. */
export const PREFLIGHT_PATH = '/preflight'

/** The route starting a move. */
export const START_PATH = '/start'

/** The route carrying a cleanup that left files behind on again. */
export const RETRY_CLEANUP_PATH = '/retry-cleanup'

/** The largest request body accepted: a folder path and the workspace folders. */
export const MAX_BODY_BYTES = 256 * 1024

/** What the Settings window sends to check or start a move. */
export interface MoveBody {
  /** The folder the person picked. */
  target: string
  /** Every workspace folder the server knows; the data may not go inside one, and their count is the health check's baseline. */
  workspaces: string[]
}

/** Where the data is and what the last move came to. */
export interface DataLocationState {
  /** The data directory in use. */
  home: string
  /** Whether a move is recorded on disk (in progress, or waiting for its cleanup). */
  moving: boolean
  /**
   * Whether this launch is removing a finished move's old copy right now; true
   * only while the journal is in the cleanup phase.
   */
  cleanupRunning: boolean
  /**
   * Whether the journal is in the cleanup phase and no removal runs now: the
   * removal carries on at the next launch or a `/retry-cleanup`. False in every
   * other phase, including a move asked for and not yet carried.
   */
  cleanupWaiting: boolean
  /**
   * The finished move's cleanup kept leaving files behind, and Settings says
   * so and offers `/retry-cleanup`: present only while the journal is in phase
   * `cleanup` and enough removals in a row left something (`cleanupPrompt`).
   */
  cleanup?: { leftoverBytes: number }
  /**
   * The last finished move's result, with what it left where; `failure`
   * names why it failed, as a kind Settings puts into words.
   */
  lastResult?: MoveResult
  /** Why the last move asked for from Settings was taken back after `/start` answered. */
  lastRefusal?: MoveRefusal
  /**
   * What the terminal's data location came to when this launch last wrote
   * it, or else, on a launch that checks a data move's switch to its new
   * location, when that move wrote it; absent when neither wrote it.
   */
  terminal?: TerminalSync
}

/** What the shell gives this service to read and to drive. */
export interface DataLocationServiceSpec {
  /**
   * Where the data is now.
   * @returns the state to answer with.
   */
  state: () => DataLocationState
  /**
   * Open the native folder picker over the app window.
   * @returns the folder picked, or undefined when the picker was cancelled.
   */
  choose: () => Promise<string | undefined>
  /**
   * Check a move to a folder without writing anything.
   * @param body - the folder and the workspace folders.
   * @returns the verdict.
   */
  preflight: (body: MoveBody) => Promise<PreflightResult>
  /**
   * Check the move again and, when it may start, take the lock and write its journal.
   * @param body - the folder and the workspace folders.
   * @returns the journal, or why it did not start.
   */
  begin: (body: MoveBody) => Promise<MoveStartOutcome>
  /**
   * Carry a move whose journal was just written: stop the server and its processes, then move in the move's window.
   * Called only after the `202` was written.
   * @param journal - the journal {@link begin} wrote.
   */
  carry: (journal: MoveJournal) => void
  /**
   * Carry a move that finished but left files behind through its cleanup again.
   * @returns `started`, or why not.
   */
  retryCleanup: () => RetryCleanupAnswer
}

/**
 * What asking for the cleanup again came to: `started`; `none-waiting` when no
 * finished move waits for its cleanup; `running` when a cleanup is already
 * running (the launch's own, or an earlier retry); `no-window` when the app
 * window the cleanup's prompts would belong to is not open.
 */
export type RetryCleanupAnswer = 'started' | 'none-waiting' | 'running' | 'no-window'

/** A listening data-location service: where it is, what opens it, and how it stops. */
export interface DataLocationServiceHandle {
  /** Origin the server child is told to call, always on the loopback address. */
  endpoint: string
  /** The bearer token this service accepts, generated fresh for every launch. */
  token: string
  /** Stop listening and drop open connections; resolves once the listener is closed. */
  close: () => Promise<void>
}

/** The routes, once method and path have been read. */
type Route = 'state' | 'choose' | 'preflight' | 'start' | 'retry-cleanup'

/**
 * Which route one request names.
 * @param method - the HTTP method.
 * @param path - the request path.
 * @returns the route, or undefined for the 404 every other method and path gets.
 */
function routeOf(method: string, path: string): Route | undefined {
  if (method === 'GET' && path === STATE_PATH) return 'state'
  if (method !== 'POST') return undefined
  if (path === CHOOSE_PATH) return 'choose'
  if (path === PREFLIGHT_PATH) return 'preflight'
  if (path === START_PATH) return 'start'
  if (path === RETRY_CLEANUP_PATH) return 'retry-cleanup'
  return undefined
}

/**
 * Read a move request's body.
 * @param text - the body.
 * @returns the body, or a sentence saying what is wrong with it.
 */
export function parseMoveBody(text: string): MoveBody | string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // SyntaxError: the caller sent something that is not JSON; the answer says so.
    return 'the body must be JSON'
  }
  if (typeof value !== 'object' || value === null) return 'the body must be a JSON object'
  const record = value as Record<string, unknown>
  const target = record['target']
  const workspaces = record['workspaces']
  if (typeof target !== 'string' || target === '') return 'target must be a non-empty string'
  if (!Array.isArray(workspaces) || !workspaces.every(entry => typeof entry === 'string')) return 'workspaces must be an array of strings'
  return { target, workspaces: workspaces.filter((entry): entry is string => typeof entry === 'string') }
}

/**
 * Start the loopback data-location service and listen on an ephemeral port.
 * @param spec - what to report and what the routes drive.
 * @returns the listening service: its endpoint, its token, and its stop.
 * @throws when the loopback listener cannot be opened.
 */
export async function startDataLocationService(spec: DataLocationServiceSpec): Promise<DataLocationServiceHandle> {
  const token = mintToken()
  let choosing = false

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const method = request.method ?? 'unknown'
    const route = routeOf(method, path)
    if (route === undefined) {
      request.resume()
      sendText(response, 404, `no route for ${method} ${path}`)
      return
    }
    if (!authorized(request.headers.authorization, token)) {
      request.resume()
      sendText(response, 401, 'authorization must be Bearer <token> carrying this service\'s token')
      return
    }
    switch (route) {
      case 'state':
        request.resume()
        sendJson(response, 200, spec.state())
        return
      case 'choose': {
        request.resume()
        // One picker at a time: a second request would stack a second dialog over the first.
        if (choosing) {
          sendJson(response, 409, { reason: 'choosing' })
          return
        }
        choosing = true
        try {
          const picked = await spec.choose()
          sendJson(response, 200, picked === undefined ? {} : { path: picked })
        } finally {
          choosing = false
        }
        return
      }
      case 'retry-cleanup': {
        request.resume()
        const answer = spec.retryCleanup()
        if (answer === 'started') sendJson(response, 202, { ok: true })
        else sendJson(response, 409, { reason: answer })
        return
      }
      case 'preflight':
      case 'start': {
        const text = await readBody(request, MAX_BODY_BYTES)
        if (text === undefined) {
          sendText(response, 413, `the body must be at most ${String(MAX_BODY_BYTES)} bytes`)
          return
        }
        const body = parseMoveBody(text)
        if (typeof body === 'string') {
          sendText(response, 400, body)
          return
        }
        if (route === 'preflight') {
          sendJson(response, 200, await spec.preflight(body))
          return
        }
        const outcome = await spec.begin(body)
        if (outcome.kind === 'refused') {
          sendJson(response, 409, outcome.refusal)
          return
        }
        sendJson(response, 202, { ok: true })
        // After the answer, never before it: the move stops the server that is waiting on it.
        const journal = outcome.journal
        setImmediate(() => { spec.carry(journal) })
        return
      }
      default:
        route satisfies never
    }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      sendText(response, 500, `data location service failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  const endpoint = await listenLoopback(server, 'data location service')
  return {
    endpoint,
    token,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
      })
    },
  }
}
