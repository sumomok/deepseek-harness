/**
 * The review-gate overlay pinned against the tool names this package actually
 * registers. `overlay/permission-gateway.patch.yml` classifies the content
 * column's reads for `@haoran/dsh-llm-permission-gateway`, which lives outside
 * this repository and knows nothing about this package: the two are joined by
 * tool-name strings alone, so renaming a read here and forgetting the overlay
 * would silently put that read back in front of the judge. Every name below is
 * imported rather than written out, which makes the rename fail here first.
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
import {
  CONTENT_ACT_TOOL_NAME,
  CONTENT_READ_ATTRS_TOOL_NAME,
  CONTENT_READ_DOM_CONTENT_TOOL_NAME,
  CONTENT_READ_DOM_TOOL_NAME,
  CONTENT_READ_IMAGE_TOOL_NAME,
  CONTENT_READ_TOOL_NAME,
} from '../src/access/wire.ts'
import { CONTENT_SHOW_TOOL_NAME } from '../src/tool.ts'

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

  it('classifies every read this package registers, and lists each name once', () => {
    const readOnlyTools = overlay[0]?.config?.readOnlyTools
    expect(Array.isArray(readOnlyTools)).toBe(true)
    const names = readOnlyTools as string[]
    expect(names).toEqual(expect.arrayContaining([
      CONTENT_READ_TOOL_NAME,
      CONTENT_READ_DOM_TOOL_NAME,
      CONTENT_READ_ATTRS_TOOL_NAME,
      CONTENT_READ_DOM_CONTENT_TOOL_NAME,
      CONTENT_READ_IMAGE_TOOL_NAME,
      CONTENT_SHOW_TOOL_NAME,
    ]))
    expect(new Set(names).size).toBe(names.length)
  })

  it('leaves the tool that drives the page for the judge to review', () => {
    expect(overlay[0]?.config?.readOnlyTools).not.toContain(CONTENT_ACT_TOOL_NAME)
  })
})
