/**
 * Two server-menu route branches the real settings service cannot reach:
 * every refusal it produces is an `Error` instance, so the route's
 * `renderThrown` fallback for a non-Error rejection needs a stand-in service;
 * and a row mounted outside the Loader has no profile entry to persist into.
 * The `settings` Service Definition places no constraint on a provider's
 * rejection values, so the stand-in is a legitimate configuration of the same
 * seam, not a hostile input to a value the static interface requires.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as ServerSidebar from '../src/index.ts'
import { SERVER_IDENTITY_ROUTE, SERVER_MENU_ROUTE } from '../src/route.ts'
import { bootProfile } from './profile-composition.client.ts'

/** A settings stand-in whose every write rejects with a non-Error value. */
const RejectingSettings = {
  name: 'rejecting-settings',
  apply: (ctx: Context) => {
    ctx.effect(() => ctx.reflect.provide('settings', {
      configure: () => () => {},
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario under test.
      update: () => Promise.reject('not an Error instance'),
    }))
  },
}

describe('server-sidebar server-menu route: non-Error rejection fallback', () => {
  it('renders a thrown non-Error value through String() rather than crashing', async () => {
    const { ctx } = await bootProfile({ settings: RejectingSettings })
    const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${SERVER_MENU_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflows: [] }),
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'server-sidebar: the server-menu could not be saved: not an Error instance' })
  })
})

describe('server-sidebar outside the Loader', () => {
  it('serves its identity but no server-menu route, which has no profile entry to persist into', async () => {
    const paths: string[] = []
    const ctx = new Context()
    ctx.provide('settings', { configure: () => () => {} } as never)
    ctx.provide('webServer', {
      register: (route: { path: string }) => {
        paths.push(route.path)
        return () => {}
      },
    } as never)
    await ctx.plugin(ServerSidebar, { displayNameClaim: 'login_uname' }).await()
    expect(paths).toEqual([SERVER_IDENTITY_ROUTE])
    expect(paths).not.toContain(SERVER_MENU_ROUTE)
  })
})
