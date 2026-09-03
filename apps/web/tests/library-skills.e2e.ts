/**
 * Web e2e scenario: bundled component-library knowledge
 * (`@deepseek-ai/dsh-experimental-library-skills`) reaches the agent's skill
 * catalog through one composition row, loads by name, loses to a user's
 * same-named skill, disappears with the row, and throws while its config is
 * interpolated when the profile cannot resolve the package it names.
 *
 * Structural rather than transcript-shaped, and browser-free: every claim is
 * about the catalog the model is handed at the start of a session, which
 * `ctx.skills` answers directly for an agent scope — the same view
 * `dsh-tool-skill` renders its catalog message and its `skill` tool result
 * from. Nothing here needs a model turn, so the scenario owns no recorded
 * session and no corpus entry (`snapshots/web/*` scenarios are recordings).
 *
 * An experimental package cannot be a dependency of `apps/web`, so this file
 * creates the profile link the row's `bundledSkillDir` expression resolves,
 * the same way `server-sidebar.e2e.ts` does for the rows it inserts.
 */

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { SkillRegistry, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const PACKAGE_DIR = join(REPO_ROOT, 'packages/experimental/library-skills')
const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-library-skills'
const OVERLAY = fileURLToPath(new URL('./library-skills.overlay.yml', import.meta.url))
/** Every file that must carry the identical composition row. */
const ROW_SOURCES = [
  OVERLAY,
  join(PACKAGE_DIR, 'cordis.patch.yml'),
  join(REPO_ROOT, 'packages/experimental/server-sidebar/overlay/customer.patch.yml'),
  fileURLToPath(new URL('./server-sidebar.overlay.yml', import.meta.url)),
  fileURLToPath(new URL('./server-sidebar-homepage.overlay.yml', import.meta.url)),
]
/** The placeholder skill this package ships; slice 1 replaces it with real library knowledge. */
const SKILL_NAME = 'library-skills-placeholder'
/** A description no shipped file carries, so the override assertion cannot pass by accident. */
const USER_DESCRIPTION = 'User-authored replacement for the bundled placeholder'

interface InsertRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
}

/**
 * The `library-skills` insert row a composition file declares.
 * @param path - the YAML file to read.
 * @returns the row, or `undefined` when the file declares none.
 */
async function libraryRow(path: string): Promise<InsertRow | undefined> {
  const parsed = yaml.load(await readFile(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`composition file at ${path} must be a list`)
  const rows = parsed as { insert?: InsertRow[] }[]
  return rows.flatMap(row => row.insert ?? []).find(entry => entry.id === 'library-skills')
}

/**
 * A harness home whose profile fallback resolves this package by name.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithPackageLink(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-library-skills-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  await symlink(PACKAGE_DIR, join(scope, PACKAGE_NAME.slice('@deepseek-ai/'.length)), 'dir')
  return home
}

/**
 * Evaluate the shipped `bundledSkillDir` expression the way the Loader does —
 * against one profile directory as `baseUrl` — in a child process.
 *
 * Out of process because vitest exports pnpm's flat store directory on
 * `NODE_PATH`, which puts every workspace package on `Module.globalPaths` and
 * makes this expression resolve from any directory at all. In this process the
 * missing-package case therefore cannot happen; the child runs without it, the
 * way a deployed console does.
 * @param expression - the row's `!!js` source, read from a shipped file.
 * @param profileDir - the directory to evaluate it against.
 * @returns the child's exit status and streams.
 */
function evaluateBundledSkillDir(expression: string, profileDir: string): {
  status: number
  stdout: string
  stderr: string
} {
  const script = [
    `const baseUrl = ${JSON.stringify(`${pathToFileURL(profileDir).href}/`)}`,
    `process.stdout.write(String(${expression}))`,
  ].join('\n')
  const env = { ...process.env }
  delete env.NODE_PATH
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' })
  return { status: child.status ?? -1, stdout: child.stdout, stderr: child.stderr }
}

/**
 * Write one user skill into a harness home's `$DSH_HOME/skills` root.
 * @param home - the harness home the scaffold will adopt.
 * @param name - skill name, which is also its bundle directory.
 * @param description - the catalog description that proves which file won.
 */
async function writeUserSkill(home: string, name: string, description: string): Promise<void> {
  const bundle = join(home, 'skills', name)
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'SKILL.md'), `---
name: ${name}
description: ${description}
---

User-authored body.
`)
}

/**
 * The skill catalog one composed agent sees, as `dsh-tool-skill` would render it.
 * @param scaffold - a launched scaffold.
 * @param sessionId - session id for the agent this view belongs to.
 * @param visit - what to assert against the registry and the composed agent.
 */
async function withComposedAgent(
  scaffold: WebScaffold,
  sessionId: string,
  visit: (skills: SkillRegistry, options: SkillViewOptions) => Promise<void>,
): Promise<void> {
  const ctx = scaffold.ctx
  const handle = await ctx.agents.create({
    sessionId: SessionId(sessionId),
    setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
  })
  try {
    const skills = ctx.get('skills')
    if (skills === undefined) throw new Error('the composition mounts no skill registry')
    await visit(skills, { cwd: scaffold.workspaceCwd, scope: handle.agent })
  } finally {
    await handle.dispose()
  }
}

describe('web e2e: bundled library skills', () => {
  let scaffold: WebScaffold | undefined
  let home: string | undefined

  afterEach(async () => {
    try {
      await scaffold?.close()
    } finally {
      scaffold = undefined
      if (home !== undefined) await rm(home, { recursive: true, force: true })
      home = undefined
    }
  })

  it('declares one identical row in the package patch and every overlay that ships it', async () => {
    const rows = await Promise.all(ROW_SOURCES.map(libraryRow))
    for (const [index, row] of rows.entries()) {
      expect(row, `${ROW_SOURCES[index] as string}: library-skills row`).toBeDefined()
    }
    expect(rows.slice(1)).toEqual(rows.slice(1).map(() => rows[0]))
    expect(rows[0]).toMatchObject({
      name: '@deepseek-ai/dsh-skill-filesystem',
      config: { providerName: 'library-skills', includeDefaultRoots: false },
    })
  })

  it('lists and loads the bundled skill for a composed agent', async () => {
    home = await harnessHomeWithPackageLink()
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, harnessHome: home })
    await withComposedAgent(scaffold, 'library-skills-listed', async (skills, options) => {
      const listed = (await skills.list(options)).find(skill => skill.name === SKILL_NAME)
      expect(listed, 'the bundled skill must reach the agent catalog').toBeDefined()
      expect(listed).toMatchObject({ provider: 'library-skills', source: 'bundled' })
      // Library knowledge is written for the model, never for a `/` menu: the
      // console composing this package also mounts `ui-skill`, so a skill left
      // user-invocable would list maintainer vocabulary as a user command.
      expect(listed?.invocation).toEqual({ modelInvocable: true, userInvocable: false })

      const loaded = await skills.get(SKILL_NAME, options)
      expect(loaded?.content).toContain('carries no component-library knowledge')
      expect(loaded?.metadata).toMatchObject({ library: 'placeholder-library' })

      // The row is a top-level row of the composed profile tree, so it registers
      // into the registry's global layer, which a scope-free view reads alone.
      const global = (await skills.list({ cwd: options.cwd })).map(skill => skill.name)
      expect(global).toContain(SKILL_NAME)
    })
  }, 120_000)

  it('lets a user skill of the same name replace the bundled one', async () => {
    home = await harnessHomeWithPackageLink()
    await writeUserSkill(home, SKILL_NAME, USER_DESCRIPTION)
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, harnessHome: home })
    await withComposedAgent(scaffold, 'library-skills-overridden', async (skills, options) => {
      const listed = (await skills.list(options)).filter(skill => skill.name === SKILL_NAME)
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({ description: USER_DESCRIPTION, source: 'user-dsh' })
      expect((await skills.get(SKILL_NAME, options))?.content).toContain('User-authored body.')

      // The user root belongs to the agent's preset layer and the bundled row to
      // the global layer, so the scope-free view still answers with the shipped
      // file: the user wins by layer, before rank is ever consulted.
      const global = (await skills.list({ cwd: options.cwd })).find(skill => skill.name === SKILL_NAME)
      expect(global).toMatchObject({ provider: 'library-skills', source: 'bundled' })
    })
  }, 120_000)

  it('resolves the package from a profile that links it and throws from one that does not', async () => {
    // The row makes the package a deployment dependency of every composition
    // carrying it. A profile that cannot resolve it throws while the row's
    // config is interpolated, `boot()`'s activation audit turns that into a
    // failed launch, and the console does not come up — the loud half of this
    // package's two failure modes, and the one a silent empty root must never
    // be mistaken for. The expression is read from the shipped patch rather
    // than restated, so rewriting it into something that swallows the miss
    // reddens here.
    const row = await libraryRow(join(PACKAGE_DIR, 'cordis.patch.yml'))
    const expression = (row?.config?.bundledSkillDir as { __jsExpr?: string } | undefined)?.__jsExpr
    expect(expression, 'the row must carry a `!!js` bundledSkillDir').toBeTypeOf('string')

    home = await harnessHomeWithPackageLink()
    const linked = evaluateBundledSkillDir(expression as string, join(home, 'profiles', 'scaffold'))
    expect(linked.stderr).toBe('')
    expect(linked.status).toBe(0)
    expect(linked.stdout).toBe(realpathSync(join(PACKAGE_DIR, 'skills')))

    const bare = await mkdtemp(join(tmpdir(), 'dsh-library-skills-unlinked-'))
    try {
      const unlinked = evaluateBundledSkillDir(expression as string, join(bare, 'profiles', 'scaffold'))
      expect(unlinked.status).not.toBe(0)
      expect(unlinked.stderr).toContain('MODULE_NOT_FOUND')
      expect(unlinked.stderr).toContain(PACKAGE_NAME)
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  it('carries no bundled skill without the composition row', async () => {
    home = await harnessHomeWithPackageLink()
    scaffold = await launchWebScaffold({ harnessHome: home })
    await withComposedAgent(scaffold, 'library-skills-absent', async (skills, options) => {
      const names = (await skills.list(options)).map(skill => skill.name)
      expect(names).not.toContain(SKILL_NAME)
    })
  }, 120_000)
})
