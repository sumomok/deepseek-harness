/**
 * The Host half against a real prompt registry: the section it registers,
 * where that section renders, which directories a launch names, the templates
 * and config it refuses, its disposal, and the skill folder it names against
 * the skill provider that reads it.
 * @module
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as DesktopApp from '../src/index.ts'

const TEMPLATES = {
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
  it('names every directory a packaged launch knows after the persona suffix, as literal text', async () => {
    const home = join(temp, 'Application Support', '北冥 数据')
    vi.stubEnv('DSH_HOME', home)
    await root.plugin(DesktopApp, {
      ...TEMPLATES,
      installDir: '/Applications/北冥 Beta.app',
      appDataDir: '/Users/张三/Library/Application Support/@deepseek-ai/dsh-desktop',
      logDir: '/Users/张三/Library/Logs/@deepseek-ai/dsh-desktop',
      updateCacheDir: '/Users/张三/Library/Caches/@deepseek-aidsh-desktop-updater',
    })

    const assembly = await root.systemPrompt.assemble()
    const text = `Keep install \`/Applications/北冥 Beta.app\`, data \`${home}\`, `
      + 'settings `/Users/张三/Library/Application Support/@deepseek-ai/dsh-desktop`, '
      + 'logs `/Users/张三/Library/Logs/@deepseek-ai/dsh-desktop` and updates `/Users/张三/Library/Caches/@deepseek-aidsh-desktop-updater`; '
      + `\`${join(home, 'skills')}\` is exempt.`
    expect(assembly.sections.at(-1)).toEqual({ name: DesktopApp.PROTECTED_DIRECTORIES_SECTION, text, interpolate: false })
    expect(renderPrompt(assembly).endsWith(`Deployment suffix.\n\n${text}`)).toBe(true)
  })

  it('leaves out the installation directory in a development launch of the shell', async () => {
    const home = join(temp, 'home')
    vi.stubEnv('DSH_HOME', home)
    await root.plugin(DesktopApp, { ...TEMPLATES, appDataDir: '/ud', logDir: '/logs', updateCacheDir: '/cache' })

    expect((await prompt()).endsWith(`Keep data \`${home}\`, settings \`/ud\`, logs \`/logs\` and updates \`/cache\`; \`${join(home, 'skills')}\` is exempt.`)).toBe(true)
  })

  it('names the data directory alone when no shell names its directories', async () => {
    const home = join(temp, 'home')
    vi.stubEnv('DSH_HOME', home)
    await root.plugin(DesktopApp, TEMPLATES)

    expect((await prompt()).endsWith(`Keep data \`${home}\`; \`${join(home, 'skills')}\` is exempt.`)).toBe(true)
  })

  it('joins two clauses with the last separator alone', () => {
    expect(DesktopApp.renderProtectedDirsPrompt(TEMPLATES, { installDir: '/i', dataDir: '/d', skillsDir: '/d/skills' }))
      .toBe('Keep install `/i` and data `/d`; `/d/skills` is exempt.')
  })

  it('fills Windows paths verbatim, and never rescans an inserted path', () => {
    const dataDir = 'C:\\Users\\张三\\.dsh {skillsDir}'
    expect(DesktopApp.renderProtectedDirsPrompt(TEMPLATES, {
      installDir: 'C:\\Users\\张三\\AppData\\Local\\Programs\\北冥',
      dataDir,
      appDataDir: 'C:\\Users\\张三\\AppData\\Roaming\\@deepseek-ai\\dsh-desktop',
      skillsDir: win32.join(dataDir, 'skills'),
    })).toBe('Keep install `C:\\Users\\张三\\AppData\\Local\\Programs\\北冥`, data `C:\\Users\\张三\\.dsh {skillsDir}` '
      + 'and settings `C:\\Users\\张三\\AppData\\Roaming\\@deepseek-ai\\dsh-desktop`; `C:\\Users\\张三\\.dsh {skillsDir}\\skills` is exempt.')
  })

  it('leaves the prompt when the row is disposed', async () => {
    vi.stubEnv('DSH_HOME', join(temp, 'home'))
    const fiber = root.plugin(DesktopApp, TEMPLATES)
    await fiber
    await fiber.dispose()

    expect(await prompt()).not.toContain('Keep ')
  })

  it.each<Partial<typeof TEMPLATES>>([
    { protectedDirsPrompt: 'Keep {directories}.' },
    { protectedDirsPrompt: 'Keep {directories} in {dataDir}; {skillsDir} is exempt.' },
    { directoryClauses: { ...TEMPLATES.directoryClauses, logDir: 'logs' } },
    { directoryClauses: { ...TEMPLATES.directoryClauses, installDir: 'install {installDir} of {dataDir}' } },
  ])('refuses to mount a template whose placeholders are wrong: %j', async (override) => {
    const config = { ...TEMPLATES, ...override }
    expect(() => { DesktopApp.checkTemplates(config) }).toThrow(/must contain exactly/)
    await expect(root.plugin(DesktopApp, config)).rejects.toThrow(/must contain exactly/)
    expect(await prompt()).not.toContain('Keep ')
  })

  it.each<Record<string, unknown>>([
    {},
    { ...TEMPLATES, protectedDirsPrompt: '' },
    { ...TEMPLATES, directoryClauses: { ...TEMPLATES.directoryClauses, updateCacheDir: ' \n' } },
    { ...TEMPLATES, directoryClauses: { installDir: 'install {installDir}' } },
    { ...TEMPLATES, logDir: '' },
  ])('refuses a row config: %j', (config) => {
    expect(() => DesktopApp.Config(config as never)).toThrow()
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
