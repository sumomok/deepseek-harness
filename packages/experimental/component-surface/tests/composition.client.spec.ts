/**
 * REAL-composition coverage for this row: a test-only cordis.yml booted through
 * the vendored Loader mounts the tool runtime, the session store, the
 * projection registry, and the content-surface router, and every assertion
 * observes what the composed application offers — the tool a model would see,
 * the entry a call produces in the column, and the release of both on fiber
 * disposal (HMR safety).
 *
 * The composition without a content column is asserted too, because that is the
 * `develop`-shaped one: the tool must still be offered, and the calls it
 * records must still be in the log for a composition that later grows a column.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import * as ShowComponent from '../src/index.ts'

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

const SPEC = { nodes: [{ id: 'bar', component: 'el.confirm-bar', props: { buttons: [{ id: 'ok', label: '确认' }] } }] }

/** Write a cordis.yml and boot it through the real Loader. */
async function loadComposition(withColumn = true): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-show-component-'))
  const configPath = join(world, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    ...withColumn ? ["- name: '@deepseek-ai/dsh-experimental-content-surface'"] : [],
    '- id: show-component',
    "  name: '@deepseek-ai/dsh-experimental-component-surface'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(world).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-experimental-content-surface', ContentSurfaceRegistry],
    ['@deepseek-ai/dsh-experimental-component-surface', ShowComponent],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** One session on the loaded composition. */
function newSession(ctx: Context): Session {
  return (ctx.get('sessions') as unknown as SessionStore).create()
}

/** Append one `show_component` call to a session's log. */
function call(session: Session, callId: string, args: unknown): void {
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: ToolCallId(callId),
    name: 'show_component',
    arguments: JSON.stringify(args),
  })
}

describe('the composed row', () => {
  it('offers show_component to the model', async () => {
    const ctx = await loadComposition()
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('show_component')
  })

  it('turns an accepted call into the entry the column shows', async () => {
    const ctx = await loadComposition()
    const session = newSession(ctx)
    call(session, 'call_1', { id: 'budget', title: '预算确认', spec: SPEC })
    expect(ctx.sessionProjections.snapshot(session).values.contentSurface?.entries).toEqual([{
      kind: 'component',
      entryId: 'budget',
      seq: 0,
      title: '预算确认',
      payload: { spec: SPEC },
    }])
  })

  it('still offers the tool where no content column is composed', async () => {
    const ctx = await loadComposition(false)
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('show_component')
    // Nothing folds the calls here, and nothing has to: the log carries them,
    // and a composition that later grows a column reads them from it.
    expect(ctx.sessionProjections.snapshot(newSession(ctx)).values.contentSurface).toBeUndefined()
  })

  it('releases the tool and the kind when the row unloads', async () => {
    const ctx = await loadComposition()
    const session = newSession(ctx)
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'show-component')
    await row?.fiber?.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('show_component')
    call(session, 'call_1', { id: 'budget', title: '预算确认', spec: SPEC })
    expect(ctx.sessionProjections.snapshot(newSession(ctx)).values.contentSurface?.entries).toEqual([])
  })
})
