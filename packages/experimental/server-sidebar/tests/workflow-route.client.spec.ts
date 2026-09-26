/**
 * REAL-composition coverage for this package's node half: a profile booted
 * through the app boot mounts the config editor, the settings service, the
 * webserver, and the server-sidebar row, and every assertion observes the
 * served HTTP surface — the server-menu document, the same-site and
 * content-type fences on the mutating method, the schema and duplicate-id
 * refusals, the merge-not-replace patch semantics, persistence into the
 * profile patch surviving a restart, the one-time import of a menu the
 * removed `settings.yaml` held, and route release on fiber disposal.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test — the node half of a dual-face client package is
 * spelled this way (dsh-client-modules, dsh-client-hmr).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { SERVER_MENU_ROUTE } from '../src/route.ts'
import { bootProfile } from './profile-composition.client.ts'

/** One served response, reduced to what the assertions read. */
interface Answer {
  status: number
  type: string | null
  allow: string | null
  cacheControl: string | null
  body: string
}

/** Issue one request against the running server. */
async function call(ctx: Context, path: string, init: RequestInit = {}): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${path}`, init)
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    allow: response.headers.get('allow'),
    cacheControl: response.headers.get('cache-control'),
    body: await response.text(),
  }
}

/** POST one server-menu patch. */
function postPatch(ctx: Context, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  return call(ctx, SERVER_MENU_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const WORKFLOW = {
  id: 'w1', name: 'Alpha', order: 0, homeSessionId: 's1',
  navSnapshot: [{ kind: 'page', entryId: 'home' }, { kind: 'view', entryId: 'sales' }], savedAt: 1,
}
const GROUP = { id: 'g1', name: '每日', pinned: true, order: 0 }

/** The stored document as the route answers it, with the fields the schema defaults filled in. */
function document(fields: Record<string, unknown>): Record<string, unknown> {
  return { workflows: [], groups: [], ...fields }
}

describe('server-sidebar server-menu route', () => {
  it('answers an empty document before anything is saved, uncached', async () => {
    const { ctx } = await bootProfile()
    const answer = await call(ctx, SERVER_MENU_ROUTE)
    expect(answer.status).toBe(200)
    expect(answer.type).toBe('application/json')
    expect(answer.cacheControl).toBe('no-store')
    expect(JSON.parse(answer.body)).toEqual(document({}))
  })

  it('serves a HEAD of the server-menu document', async () => {
    const { ctx } = await bootProfile()
    expect((await call(ctx, SERVER_MENU_ROUTE, { method: 'HEAD' })).status).toBe(200)
  })

  it('persists a posted workflows patch and answers the server\'s authoritative document', async () => {
    const { ctx } = await bootProfile()
    const posted = await postPatch(ctx, { workflows: [WORKFLOW] })
    expect(posted.status).toBe(200)
    expect(JSON.parse(posted.body)).toEqual(document({ workflows: [WORKFLOW] }))

    const read = await call(ctx, SERVER_MENU_ROUTE)
    expect(JSON.parse(read.body)).toEqual(document({ workflows: [WORKFLOW] }))
  })

  it('merges a workbenchSessionId-only patch without disturbing an existing workflow list', async () => {
    const { ctx } = await bootProfile()
    await postPatch(ctx, { workflows: [WORKFLOW] })
    const posted = await postPatch(ctx, { workbenchSessionId: 'home-1' })
    expect(JSON.parse(posted.body)).toEqual(document({ workflows: [WORKFLOW], workbenchSessionId: 'home-1' }))

    const workflowsOnly = await postPatch(ctx, { workflows: [WORKFLOW, { ...WORKFLOW, id: 'w2', name: 'Beta', order: 1 }] })
    expect(JSON.parse(workflowsOnly.body)).toEqual(document({
      workflows: [WORKFLOW, { ...WORKFLOW, id: 'w2', name: 'Beta', order: 1 }],
      workbenchSessionId: 'home-1',
    }))
  })

  it('persists a posted groups patch and answers the server\'s authoritative document', async () => {
    const { ctx } = await bootProfile()
    const posted = await postPatch(ctx, { groups: [GROUP] })
    expect(posted.status).toBe(200)
    expect(JSON.parse(posted.body)).toEqual(document({ groups: [GROUP] }))
  })

  it('merges a groups-only patch without disturbing an existing workflow list', async () => {
    const { ctx } = await bootProfile()
    await postPatch(ctx, { workflows: [WORKFLOW] })
    const posted = await postPatch(ctx, { groups: [GROUP] })
    expect(JSON.parse(posted.body)).toEqual(document({ workflows: [WORKFLOW], groups: [GROUP] }))
  })

  it('takes a workflow and the group it is filed under in one patch', async () => {
    const { ctx } = await bootProfile()
    const filed = { ...WORKFLOW, groupId: GROUP.id }
    const posted = await postPatch(ctx, { workflows: [filed], groups: [GROUP] })
    expect(posted.status).toBe(200)
    expect(JSON.parse(posted.body)).toEqual(document({ workflows: [filed], groups: [GROUP] }))
  })

  it('refuses a groups patch that would orphan a stored workflow\'s group', async () => {
    const { ctx } = await bootProfile()
    await postPatch(ctx, { workflows: [{ ...WORKFLOW, groupId: GROUP.id }], groups: [GROUP] })
    const answer = await postPatch(ctx, { groups: [] })
    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body)).toEqual({
      error: 'server-sidebar: workflow "w1" names group "g1", which no group defines',
    })
    expect(JSON.parse((await call(ctx, SERVER_MENU_ROUTE)).body))
      .toEqual(document({ workflows: [{ ...WORKFLOW, groupId: GROUP.id }], groups: [GROUP] }))
  })

  it('refuses a groups list with a duplicate id', async () => {
    const { ctx } = await bootProfile()
    const answer = await postPatch(ctx, { groups: [GROUP, { ...GROUP, name: 'Duplicate' }] })
    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body)).toEqual({ error: 'server-sidebar: duplicate group id "g1"' })
    expect(JSON.parse((await call(ctx, SERVER_MENU_ROUTE)).body)).toEqual(document({}))
  })

  it('refuses a group with a blank name', async () => {
    const { ctx } = await bootProfile()
    const answer = await postPatch(ctx, { groups: [{ ...GROUP, name: '  ' }] })
    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body)).toEqual({ error: 'server-sidebar: group "g1" has a blank name' })
  })

  it('refuses a workflows list with a duplicate id', async () => {
    const { ctx } = await bootProfile()
    const answer = await postPatch(ctx, { workflows: [WORKFLOW, { ...WORKFLOW, name: 'Duplicate' }] })
    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body)).toEqual({ error: 'server-sidebar: duplicate workflow id "w1"' })
    expect(JSON.parse((await call(ctx, SERVER_MENU_ROUTE)).body)).toEqual(document({}))
  })

  it('refuses a pre-view navSnapshot, naming the converter an operator has to run', async () => {
    const { ctx } = await bootProfile()
    const answer = await postPatch(ctx, { workflows: [{ ...WORKFLOW, navSnapshot: ['home'] }] })
    expect(answer.status).toBe(400)
    expect((JSON.parse(answer.body) as { error: string }).error)
      .toContain('run convert-nav-snapshot')
    expect(JSON.parse((await call(ctx, SERVER_MENU_ROUTE)).body)).toEqual(document({}))
  })

  it('refuses a body shaped wrong before it ever reaches the schema', async () => {
    const { ctx } = await bootProfile()
    for (const body of [
      'not json', {}, { workflows: 'nope' }, { groups: 'nope' }, { workbenchSessionId: 42 }, { workflows: [{ id: 1 }] },
      { groups: [{ id: 1 }] },
    ]) {
      const answer = await postPatch(ctx, body)
      expect(answer.status).toBe(400)
    }
  })

  it('refuses a post a browser labelled cross-site', async () => {
    const { ctx } = await bootProfile()
    const answer = await postPatch(ctx, { workflows: [] }, { 'sec-fetch-site': 'cross-site' })
    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.body)).toEqual({ error: 'server-sidebar: the server-menu route serves same-site requests only' })
  })

  it('refuses a post that is not sent as JSON', async () => {
    const { ctx } = await bootProfile()
    const answer = await call(ctx, SERVER_MENU_ROUTE, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    })
    expect(answer.status).toBe(415)
    expect(JSON.parse(answer.body)).toEqual({ error: 'server-sidebar: the server-menu route accepts application/json only' })
  })

  it('refuses a body past the bound instead of buffering it', async () => {
    const { ctx } = await bootProfile()
    const answer = await postPatch(ctx, {
      workflows: [{ ...WORKFLOW, name: 'A'.repeat(80 * 1024) }],
    })
    expect(answer.status).toBe(413)
  })

  it('states the complete method set it serves', async () => {
    const { ctx } = await bootProfile()
    const answer = await call(ctx, SERVER_MENU_ROUTE, { method: 'DELETE' })
    expect({ status: answer.status, allow: answer.allow }).toEqual({ status: 405, allow: 'GET, HEAD, POST' })
  })

  it('persists into the profile patch without remounting the row, and across a restart (per-account durability)', async () => {
    const { ctx, profile, start } = await bootProfile()
    const row = ctx.configEditor.entries().find(entry => entry.options.id === 'server-sidebar')
    const fiber = row?.fiber
    await postPatch(ctx, { workflows: [WORKFLOW], workbenchSessionId: 'home-1' })
    expect(row?.fiber).toBe(fiber)
    expect(parse(readFileSync(profile.patchPath, 'utf8'))).toContainEqual({
      id: 'server-sidebar',
      name: 'cordis:sidebar',
      config: { displayNameClaim: 'login_uname', workflows: [WORKFLOW], workbenchSessionId: 'home-1' },
    })
    await ctx.fiber.dispose()

    const restarted = await start()
    expect(JSON.parse((await call(restarted, SERVER_MENU_ROUTE)).body))
      .toEqual(document({ workflows: [WORKFLOW], workbenchSessionId: 'home-1' }))
  })

  it('imports the menu section of the removed settings.yaml into its own entry once', async () => {
    const { ctx, home } = await bootProfile({
      beforeStart: (dir) => {
        writeFileSync(join(dir, 'settings.yaml'), [
          'server-sidebar:',
          '  workbenchSessionId: home-1',
          '  groups:',
          '    - { id: g1, name: 每日, pinned: true, order: 0 }',
          '',
        ].join('\n'))
      },
    })
    await vi.waitFor(async () => {
      expect(JSON.parse((await call(ctx, SERVER_MENU_ROUTE)).body))
        .toEqual(document({ groups: [GROUP], workbenchSessionId: 'home-1' }))
    })
    expect(existsSync(join(home, 'settings.yaml'))).toBe(false)
    expect(existsSync(join(home, 'settings.yaml.imported'))).toBe(true)
  })

  it('answers 500 when the settings service refuses a write a higher layer overrides', async () => {
    const { ctx, home } = await bootProfile()
    writeFileSync(join(home, 'cordis.patch.yml'), JSON.stringify([{ id: 'server-sidebar', config: { workbenchSessionId: 'pinned' } }]))
    const answer = await postPatch(ctx, { workbenchSessionId: 'home-1' })
    expect(answer.status).toBe(500)
    expect((JSON.parse(answer.body) as { error: string }).error).toMatch(/^server-sidebar: the server-menu could not be saved: /)
  })

  it('releases the route when the fiber disposes (HMR safety)', async () => {
    const { ctx } = await bootProfile()
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'server-sidebar')
    await row?.fiber?.dispose()
    const answer = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${SERVER_MENU_ROUTE}`)
    expect(answer.status).toBe(404)
    await answer.arrayBuffer()
  })
})

describe('server-sidebar without the settings capability', () => {
  it('loads with no server-menu route rather than failing the row', async () => {
    const { ctx } = await bootProfile({ settings: { name: 'no-settings', apply: () => {} } })
    const unloaded = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    expect(unloaded).toEqual([])
    const answer = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${SERVER_MENU_ROUTE}`)
    expect(answer.status).toBe(404)
    await answer.arrayBuffer()
  })
})
