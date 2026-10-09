/**
 * Where this package's two tools stand in the review gate's read-only list.
 *
 * The classification lives in the deployment overlay `content-frame` ships —
 * this repository owns that file, and the gate it targets lives outside it and
 * knows nothing about either content package. What joins them is tool-name
 * strings alone, so a tool added to that list would be silently allowed without
 * either the judge or a person seeing it, and a read left out of it is judged
 * on every call. This file holds both dispositions for the two tools that reach
 * a drawn entry, the same pair `content_act` and the page reads are held to by
 * that package's own overlay test.
 *
 * The overlay is read as text rather than parsed: it is a YAML document this
 * package does not depend on a parser for, and the assertions are one name's
 * absence and one name's presence in the one list the file carries.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACT_COMPONENT_TOOL_NAME } from '../src/act-component-call.ts'
import { READ_COMPONENT_TOOL_NAME } from '../src/read-component-call.ts'

/** The gateway overlay `content-frame` ships and a console deployment passes. */
const OVERLAY = resolve(process.cwd(), 'packages/experimental/content-frame/overlay/permission-gateway.patch.yml')

/** The overlay's own lines, trimmed, which is how the list is read. */
function overlayLines(): string[] {
  return readFileSync(OVERLAY, 'utf8').split('\n').map(line => line.trim())
}

describe('the review gate and this package\'s tools', () => {
  it('names no read-only entry for the tool that drives what the user is looking at', () => {
    const overlay = readFileSync(OVERLAY, 'utf8')
    // Non-vacuous: this is the file that classifies the content tools, and it
    // does carry a read-only list naming the reads.
    expect(overlay).toContain('readOnlyTools:')
    expect(overlay).toContain('content_read')
    expect(overlay).not.toContain(ACT_COMPONENT_TOOL_NAME)
  })

  it('lists the reading tool, which writes nothing and reads the model\'s own drawing', () => {
    expect(overlayLines()).toContain(`- ${READ_COMPONENT_TOOL_NAME}`)
  })
})
