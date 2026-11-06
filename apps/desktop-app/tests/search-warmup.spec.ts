/**
 * The desktop Host half's search warmup trigger: the first served page asks
 * the query backend to prepare, repeats do not, and disposal stops it.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as DesktopApp from '../src/index.ts'

const CONFIG = {
  protectedDirsPrompt: 'Keep {directories}; {skillsDir} is exempt.',
  directoryClauses: {
    installDir: 'install {installDir}',
    dataDir: 'data {dataDir}',
    appDataDir: 'settings {appDataDir}',
    logDir: 'logs {logDir}',
    updateCacheDir: 'updates {updateCacheDir}',
  },
  directorySeparator: ', ',
  directoryLastSeparator: ' and ',
} satisfies DesktopApp.Config

/** The peer a page speaks for; the trigger reads no field of it. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]

let root: Context
let requests: number

beforeEach(async () => {
  root = new Context()
  requests = 0
  root.on('session-query/warmup-requested', () => { requests += 1 })
  await root.plugin(DesktopApp, CONFIG)
})

afterEach(async () => {
  await root.fiber.dispose()
})

describe('desktop search warmup', () => {
  it('asks once, on the first page the server renders', () => {
    expect(requests).toBe(0)
    root.emit('webserver/index-inject', [], PAGE_PEER)
    expect(requests).toBe(1)
    root.emit('webserver/index-inject', [], PAGE_PEER)
    expect(requests).toBe(1)
  })

  it('stops asking after the plugin is disposed', async () => {
    await root.fiber.dispose()
    root.emit('webserver/index-inject', [], PAGE_PEER)
    expect(requests).toBe(0)
    root = new Context()
  })
})
