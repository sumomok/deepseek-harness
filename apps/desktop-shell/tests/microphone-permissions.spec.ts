/**
 * Which frames the app window's session lets open the microphone, and when
 * macOS is asked for its own grant.
 * @module
 */

import type { MediaAccessPermissionRequest, Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { installMicrophonePermissions, servedByServer, type MicrophoneHost } from '../src/microphone-permissions.ts'

type CheckHandler = Parameters<Session['setPermissionCheckHandler']>[0]
type RequestHandler = Parameters<Session['setPermissionRequestHandler']>[0]

const SERVER = 'http://127.0.0.1:43111'
const primary = {} as WebContents
const other = {} as WebContents

/** The two installed handlers and the host they read. */
type Installed = { check: NonNullable<CheckHandler>; request: NonNullable<RequestHandler>; host: MicrophoneHost }

/**
 * Install the policy on a recording session.
 * @param overrides - host fields that differ from a Windows host with a running server and an open window.
 * @returns the two installed handlers and the host they read.
 */
function install(overrides: Partial<MicrophoneHost> = {}): Installed {
  let check: CheckHandler = null
  let request: RequestHandler = null
  const host: MicrophoneHost = {
    primary: () => primary,
    serverOrigin: () => SERVER,
    platform: 'win32',
    microphoneStatus: () => 'granted',
    askForMicrophone: vi.fn(async () => true),
    ...overrides,
  }
  installMicrophonePermissions({
    setPermissionCheckHandler: (handler) => { check = handler },
    setPermissionRequestHandler: (handler) => { request = handler },
  }, host)
  if (check === null || request === null) throw new Error('both handlers must be installed')
  return { check, request, host }
}

type CheckDetails = Parameters<NonNullable<CheckHandler>>[3]
type RequestDetails = Parameters<NonNullable<RequestHandler>>[3]

const audioCheck = { isMainFrame: true, mediaType: 'audio', requestingUrl: `${SERVER}/` } as CheckDetails
const audioRequest: MediaAccessPermissionRequest = { isMainFrame: true, mediaTypes: ['audio'], requestingUrl: `${SERVER}/chat` }

/**
 * Answer one request through the installed handler.
 * @param request - the installed request handler.
 * @param contents - the requesting contents.
 * @param permission - the permission asked for.
 * @param details - the request details.
 * @returns the answer the handler gave.
 */
async function answer(
  request: NonNullable<RequestHandler>, contents: WebContents, permission: string, details: RequestDetails,
): Promise<boolean> {
  return await new Promise((resolve) => {
    request(contents, permission as Parameters<NonNullable<RequestHandler>>[1], resolve, details)
  })
}

describe('servedByServer', () => {
  it('matches the server origin with or without a path', () => {
    expect(servedByServer(`${SERVER}/chat?x=1`, SERVER)).toBe(true)
    expect(servedByServer(SERVER, SERVER)).toBe(true)
  })

  it('refuses another port, another host, a non-URL, and a missing server', () => {
    expect(servedByServer('http://127.0.0.1:43112/', SERVER)).toBe(false)
    expect(servedByServer('http://localhost:43111/', SERVER)).toBe(false)
    expect(servedByServer('not a url', SERVER)).toBe(false)
    expect(servedByServer(`${SERVER}/`, undefined)).toBe(false)
  })
})

describe('installMicrophonePermissions', () => {
  it('lets the served UI in the app window record audio on Windows without asking the system', async () => {
    const { check, request, host } = install()
    expect(check(primary, 'media', SERVER, audioCheck)).toBe(true)
    expect(await answer(request, primary, 'media', audioRequest)).toBe(true)
    expect(host.askForMicrophone).not.toHaveBeenCalled()
  })

  it('refuses a subframe, another window, another origin, video, and no server', async () => {
    const { check, request } = install()
    expect(check(primary, 'media', SERVER, { ...audioCheck, isMainFrame: false })).toBe(false)
    expect(check(other, 'media', SERVER, audioCheck)).toBe(false)
    expect(check(null, 'media', SERVER, audioCheck)).toBe(false)
    expect(check(primary, 'media', 'https://example.com', audioCheck)).toBe(false)
    expect(check(primary, 'media', SERVER, { ...audioCheck, mediaType: 'video' })).toBe(false)
    expect(await answer(request, primary, 'media', { ...audioRequest, isMainFrame: false })).toBe(false)
    expect(await answer(request, other, 'media', audioRequest)).toBe(false)
    expect(await answer(request, primary, 'media', { ...audioRequest, requestingUrl: 'https://example.com/' })).toBe(false)
    expect(await answer(request, primary, 'media', { ...audioRequest, mediaTypes: ['audio', 'video'] })).toBe(false)
    const serverless = install({ serverOrigin: () => undefined })
    expect(await answer(serverless.request, primary, 'media', audioRequest)).toBe(false)
  })

  it('keeps Electron\'s default yes for every other permission', async () => {
    const { check, request } = install()
    expect(check(other, 'notifications', 'https://example.com', { isMainFrame: false })).toBe(true)
    expect(await answer(request, other, 'notifications', { isMainFrame: false, requestingUrl: 'https://example.com/' })).toBe(true)
  })

  it('on macOS asks the system and passes its answer through', async () => {
    const granted = install({ platform: 'darwin', askForMicrophone: vi.fn(async () => true) })
    expect(await answer(granted.request, primary, 'media', audioRequest)).toBe(true)
    expect(granted.host.askForMicrophone).toHaveBeenCalledTimes(1)
    const declined = install({ platform: 'darwin', askForMicrophone: vi.fn(async () => false) })
    expect(await answer(declined.request, primary, 'media', audioRequest)).toBe(false)
    const failed = install({ platform: 'darwin', askForMicrophone: vi.fn(async () => { throw new Error('denied') }) })
    expect(await answer(failed.request, primary, 'media', audioRequest)).toBe(false)
  })

  it('on macOS answers a check from the system grant', () => {
    expect(install({ platform: 'darwin', microphoneStatus: () => 'granted' }).check(primary, 'media', SERVER, audioCheck)).toBe(true)
    expect(install({ platform: 'darwin', microphoneStatus: () => 'not-determined' }).check(primary, 'media', SERVER, audioCheck)).toBe(false)
  })
})
