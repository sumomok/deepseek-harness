/**
 * The Host half against a real prompt registry: the section it registers,
 * where that section renders, the config it refuses, and its disposal.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as DesktopApp from '../src/index.ts'

const TEXT = 'Leave the {{app}} directories alone.'

let root: Context

beforeEach(async () => {
  root = new Context()
  await root.plugin(SystemPrompt, { personaPrefix: 'Deployment persona.', personaSuffix: 'Deployment suffix.' })
})

afterEach(async () => {
  await root.fiber.dispose()
})

describe('the protected-directories section', () => {
  it('ends the assembled prompt, after the persona suffix, as literal text', async () => {
    await root.plugin(DesktopApp, { protectedDirsPrompt: TEXT })

    const assembly = await root.systemPrompt.assemble()
    expect(assembly.sections.at(-1)).toEqual({ name: DesktopApp.PROTECTED_DIRECTORIES_SECTION, text: TEXT, interpolate: false })
    expect(renderPrompt(assembly).endsWith(`Deployment suffix.\n\n${TEXT}`)).toBe(true)
  })

  it('leaves the prompt when the row is disposed', async () => {
    const fiber = root.plugin(DesktopApp, { protectedDirsPrompt: TEXT })
    await fiber
    await fiber.dispose()

    expect(renderPrompt(await root.systemPrompt.assemble())).not.toContain(TEXT)
  })

  it.each([{}, { protectedDirsPrompt: '' }, { protectedDirsPrompt: ' \n' }])('refuses a row without text: %j', (config) => {
    expect(() => DesktopApp.Config(config as DesktopApp.Config)).toThrow(/protectedDirsPrompt/)
  })
})
