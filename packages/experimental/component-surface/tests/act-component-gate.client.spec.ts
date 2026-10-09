/**
 * `act_component` stays out of the review gate's read-only list.
 *
 * The classification lives in the deployment overlay `content-frame` ships —
 * this repository owns that file, and the gate it targets lives outside it and
 * knows nothing about either content package. What joins them is tool-name
 * strings alone, so a tool added to that list would be silently allowed without
 * either the judge or a person seeing it. This file holds the negative for the
 * tool that drives a drawn entry, which is the same reason `content_act` is held
 * out of it by that package's own overlay test.
 *
 * The overlay is read as text rather than parsed: it is a YAML document this
 * package does not depend on a parser for, and the assertion is the absence of
 * one name in the one list the file carries.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACT_COMPONENT_TOOL_NAME } from '../src/act-component-call.ts'

/** The gateway overlay `content-frame` ships and a console deployment passes. */
const OVERLAY = resolve(process.cwd(), 'packages/experimental/content-frame/overlay/permission-gateway.patch.yml')

describe('the review gate and act_component', () => {
  it('names no read-only entry for a tool that drives what the user is looking at', () => {
    const overlay = readFileSync(OVERLAY, 'utf8')
    // Non-vacuous: this is the file that classifies the content tools, and it
    // does carry a read-only list naming the reads.
    expect(overlay).toContain('readOnlyTools:')
    expect(overlay).toContain('content_read')
    expect(overlay).not.toContain(ACT_COMPONENT_TOOL_NAME)
  })
})
