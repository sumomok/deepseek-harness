/**
 * The review-gate overlay pinned against the tool names this package actually
 * registers. `overlay/permission-gateway.patch.yml` classifies the content
 * column's reads for `@haoran/dsh-llm-permission-gateway`, which lives outside
 * this repository and knows nothing about this package: the two are joined by
 * tool-name strings alone, so a read this package declares and the overlay does
 * not classify goes silently in front of the judge. The classified set is
 * derived from `wire.ts` rather than listed here — every `*_TOOL_NAME` export
 * it declares, less the one the gate is meant to judge — so a read added or
 * renamed there fails this file before it reaches a console.
 *
 * `content_act` is asserted absent. It drives the page and the gate is meant to
 * judge it, so the pin holds the negative rather than trusting the comment.
 *
 * Nothing here pins the gate's own eleven defaults. The overlay copies them
 * because a patch replaces the whole `config`; the gate owns and pins that
 * list, and a second copy under assertion would be a second source of truth.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as wire from '../src/access/wire.ts'
import { CONTENT_SHOW_TOOL_NAME } from '../src/tool.ts'

/**
 * Every tool name `wire.ts` declares, taken from the module rather than listed,
 * so the set follows the source. A rename of the suffix convention empties this
 * and is caught by the count assertion below rather than passing vacuously.
 */
const declaredToolNames = Object.entries(wire)
  .filter(([key]) => key.endsWith('_TOOL_NAME'))
  .map(([, value]) => value)
  .filter((value): value is string => typeof value === 'string')

/** The names the overlay must classify: everything declared but the act tool. */
const readsToClassify = declaredToolNames.filter(name => name !== wire.CONTENT_ACT_TOOL_NAME)

interface GatewayRow {
  id?: string
  name?: string
  config?: { provider?: unknown; model?: unknown; readOnlyTools?: unknown }
}

const overlay = yaml.load(
  readFileSync(
    resolve(fileURLToPath(new URL('..', import.meta.url)), 'overlay/permission-gateway.patch.yml'),
    'utf8',
  ),
  { schema: entryListSchema },
) as GatewayRow[]

describe('the review-gate overlay', () => {
  it('patches the one gateway row by id and by package name', () => {
    expect(Array.isArray(overlay)).toBe(true)
    expect(overlay).toHaveLength(1)
    expect(overlay[0]).toMatchObject({
      id: 'llm-permission-gateway',
      name: '@haoran/dsh-llm-permission-gateway',
    })
  })

  it('restates the two fields the gateway rejects empty, because a patch replaces the whole config', () => {
    const config = overlay[0]?.config
    expect(typeof config?.provider).toBe('string')
    expect(config?.provider).not.toBe('')
    expect(typeof config?.model).toBe('string')
    expect(config?.model).not.toBe('')
  })

  it('classifies every read tool the wire module declares, plus content_show, and lists each name once', () => {
    const readOnlyTools = overlay[0]?.config?.readOnlyTools
    expect(Array.isArray(readOnlyTools)).toBe(true)
    const names = readOnlyTools as string[]
    expect(readsToClassify.length).toBeGreaterThan(0)
    expect(names).toEqual(expect.arrayContaining([...readsToClassify, CONTENT_SHOW_TOOL_NAME]))
    expect(new Set(names).size).toBe(names.length)
  })

  it('leaves the tool that drives the page for the judge to review', () => {
    expect(overlay[0]?.config?.readOnlyTools).not.toContain(wire.CONTENT_ACT_TOOL_NAME)
  })
})
