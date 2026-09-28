/**
 * The Host half against a real prompt registry: the section it registers,
 * where that section renders, which template a launch gets, the templates and
 * config it refuses, its disposal, and the skill folder it names against the
 * skill provider that reads it.
 * @module
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as DesktopApp from '../src/index.ts'

const TEMPLATES = {
  protectedDirsPrompt: 'Keep {installDir} and {dataDir}, except {skillsDir}.',
  protectedDirsPromptDataOnly: 'Keep {dataDir}, except {skillsDir}.',
}

let root: Context
let temp: string

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'dsh-desktop-app-'))
  root = new Context()
  await root.plugin(SystemPrompt, { personaPrefix: 'Deployment persona.', personaSuffix: 'Deployment suffix.' })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await root.fiber.dispose()
  await rm(temp, { recursive: true, force: true })
})

/** @returns the prompt the global scope renders. */
async function prompt(): Promise<string> {
  return renderPrompt(await root.systemPrompt.assemble())
}

describe('the protected-directories section', () => {
  it('names the installation, data, and skills directories after the persona suffix, as literal text', async () => {
    const home = join(temp, 'Application Support', '北冥 数据')
    vi.stubEnv('DSH_HOME', home)
    await root.plugin(DesktopApp, { ...TEMPLATES, installDir: '/Applications/北冥 Beta.app' })

    const assembly = await root.systemPrompt.assemble()
    const text = `Keep \`/Applications/北冥 Beta.app\` and \`${home}\`, except \`${join(home, 'skills')}\`.`
    expect(assembly.sections.at(-1)).toEqual({ name: DesktopApp.PROTECTED_DIRECTORIES_SECTION, text, interpolate: false })
    expect(renderPrompt(assembly).endsWith(`Deployment suffix.\n\n${text}`)).toBe(true)
  })

  it('names the data directory alone when the launch has no installation directory', async () => {
    const home = join(temp, 'home')
    vi.stubEnv('DSH_HOME', home)
    await root.plugin(DesktopApp, TEMPLATES)

    expect((await prompt()).endsWith(`Keep \`${home}\`, except \`${join(home, 'skills')}\`.`)).toBe(true)
  })

  it('fills Windows paths verbatim', () => {
    const dataDir = 'C:\\Users\\张三\\.dsh'
    expect(DesktopApp.renderProtectedDirsPrompt({ ...TEMPLATES }, {
      installDir: 'C:\\Users\\张三\\AppData\\Local\\Programs\\北冥',
      dataDir,
      skillsDir: `${dataDir}\\skills`,
    })).toBe('Keep `C:\\Users\\张三\\AppData\\Local\\Programs\\北冥` and `C:\\Users\\张三\\.dsh`, except `C:\\Users\\张三\\.dsh\\skills`.')
  })

  it('leaves the prompt when the row is disposed', async () => {
    vi.stubEnv('DSH_HOME', join(temp, 'home'))
    const fiber = root.plugin(DesktopApp, TEMPLATES)
    await fiber
    await fiber.dispose()

    expect(await prompt()).not.toContain('Keep ')
  })

  it.each([
    { protectedDirsPrompt: 'Keep {dataDir}, except {skillsDir}.' },
    { protectedDirsPrompt: 'Keep {installDir} and {dataDir}, except {skillsDir} and {homeDir}.' },
    { protectedDirsPromptDataOnly: 'Keep {installDir} and {dataDir}, except {skillsDir}.' },
    { protectedDirsPromptDataOnly: 'Keep {dataDir}.' },
  ])('refuses to mount a template whose placeholders are wrong: %j', async (override) => {
    const config = { ...TEMPLATES, ...override }
    expect(() => { DesktopApp.checkTemplates(config) }).toThrow(/must contain exactly/)
    await expect(root.plugin(DesktopApp, config)).rejects.toThrow(/must contain exactly/)
    expect(await prompt()).not.toContain('Keep ')
  })

  it.each([
    {},
    { ...TEMPLATES, protectedDirsPrompt: '' },
    { ...TEMPLATES, protectedDirsPromptDataOnly: ' \n' },
    { ...TEMPLATES, installDir: '' },
  ])('refuses a row config: %j', (config) => {
    expect(() => DesktopApp.Config(config as DesktopApp.Config)).toThrow()
  })
})

describe('the skills folder the line exempts', () => {
  it('is the folder the skill provider reads user skills from', async () => {
    const dataDir = join(temp, 'data')
    const skill = join(dataDir, DesktopApp.SKILLS_DIR_NAME, 'probe')
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), '---\nname: probe\ndescription: probe skill\n---\n\nBody.\n')
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillFileSystem, { dshHome: dataDir, agentsHome: join(temp, 'agents'), claudeHome: join(temp, 'claude'), watch: false })
      expect((await ctx.skills.list({ cwd: temp })).map(entry => [entry.name, entry.source])).toEqual([['probe', 'user-dsh']])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
