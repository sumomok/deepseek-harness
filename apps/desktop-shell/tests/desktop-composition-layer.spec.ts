/**
 * The rows a desktop profile ends up with, composed from the real layers a
 * launch applies rather than from a description of them.
 *
 * The layer patches seven rows and inserts three of its own.
 * `session-query-sqlite` opts into full-text search: dsh-base and dsh-web-app
 * both ship it off and
 * `apps/cli/tests/lazy-search-startup.compat.spec.ts` pins them that way, so
 * this product opts in from its own layer. `llm-deepseek` raises the
 * `Retry-After` wait a rate-limited request may accept, which dsh-llm-retry
 * reads from the provider's own `retryPolicy` rather than from its own config,
 * and sets no model catalog, so the picker lists the adapter's own.
 * `vision-switch` names where an image sent on a text-only model moves the
 * session, which the plugin otherwise takes from a constant compiled into it,
 * and `llm-permission-gateway` names the review model's own route, which the
 * gate otherwise takes from the pair its own layer ships, and sends every
 * `plugin_manager` call to a person. `plugin-manager`
 * points upstream's plugin installer at the pnpm launcher the payload ships,
 * and `desktop-product-telemetry` and `product-analytics` are switched off
 * outright rather than by dsh-web-app's profile-name expression.
 * `office-to-pdf` is left as the layers below ship it: the shell downloads
 * its engine on request, and so is `ui-chat`, whose work details take the
 * form's own default. The rows it
 * inserts are `desktop-brand`, this package itself, whose browser half names
 * the product in the sidebar and whose Host half ends every session's system
 * prompt with the protected-directories instruction, `desktop-server-log`,
 * which appends the server's own logger records to the desktop log file, and
 * `tool-session-query`, upstream's five session-history tools, which register
 * in the tool registry's global layer and so reach every preset's sessions and
 * their delegated children.
 *
 * An id-targeted patch replaces the target row's whole `config`, so each row
 * restates every key it owns — `path` beside `openAt`. Composing every layer
 * here is what catches a restatement that stops replacing what it meant to,
 * and a built-in that starts patching one of these rows.
 * @module
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { composeEntries, loadOverlayPatches, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as Persona from '@deepseek-ai/dsh-persona'
import { createScope, scopeOf, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { applyChildComposition } from '@deepseek-ai/dsh-subagent'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ToolSessionQuery from '@deepseek-ai/dsh-tool-session-query'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Config as DeepSeekConfig } from '@deepseek-ai/dsh-llm-deepseek'
import { PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import { apply as applyPluginManagerTool, inject as pluginManagerToolInject } from '@deepseek-ai/dsh-plugin-manager/tools'
import { LOG_DIR_ENV, UPDATE_CACHE_DIR_ENV, USER_DATA_DIR_ENV } from '../src/app-dirs.ts'
import { INSTALL_DIR_ENV } from '../src/install-dir.ts'
import { PNPM_LAUNCHER_ENV } from '../src/pnpm-launcher.ts'
import { SERVER_LOG_ENV } from '../src/server.ts'
import { BUILTIN_WEB_BUNDLES, REQUIRED_WEB_BUNDLES } from '../src/profile-seed.ts'

/** The bundle under test, which is also this repository's own composition layer. */
const DESKTOP_APP = '@deepseek-ai/dsh-desktop-app'

/** The protected-directories templates the desktop row states. */
const PROTECTED_DIRS_TEMPLATES = {
  protectedDirsPrompt: 'Unless the user explicitly asks, do not modify, move, or delete this app\'s own directories: {directories}. The skills folder {skillsDir} is exempt.',
  directoryClauses: {
    installDir: 'the installation directory ({installDir})',
    dataDir: 'the data directory ({dataDir})',
    appDataDir: 'the settings folder ({appDataDir})',
    logDir: 'the logs folder ({logDir})',
    updateCacheDir: 'the update download folder ({updateCacheDir})',
  },
  directorySeparator: ', ',
  directoryLastSeparator: ' and ',
}

/** The directory each variable the shell sets on the server names, keyed by the row's field. */
const SHELL_DIRECTORY_ENV = {
  installDir: INSTALL_DIR_ENV,
  appDataDir: USER_DATA_DIR_ENV,
  logDir: LOG_DIR_ENV,
  updateCacheDir: UPDATE_CACHE_DIR_ENV,
} as const

/** The composed-entry fields these cases read. */
interface Entry {
  id?: string
  disabled?: unknown
  config?: Record<string, unknown>
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
// The deploy root whose closure becomes the payload's `server/node_modules`.
// The shipped Loader's installation anchor is `@deepseek-ai/dsh`'s manifest
// inside that closure; resolving from there reaches the closure's top-level
// `node_modules`, where the deploy puts every bundle this manifest lists, and
// resolving from this manifest reaches the same packages through
// `apps/desktop-server/node_modules`.
const serverDir = join(repoRoot, 'apps', 'desktop-server')
const installAnchor = join(serverDir, 'package.json')

/**
 * One built-in bundle's patch layer, resolved and read the way `loadProfile`
 * reads it: the package directory from the installation anchor, then the file
 * its manifest's `dsh.bundle.patch` names. A name that does not resolve throws
 * out of `resolveBundleDir`, so a missing payload package fails these cases
 * rather than quietly composing one layer fewer.
 * @param packageName - the bundle package name from {@link BUILTIN_WEB_BUNDLES}.
 * @returns the layer's patch list.
 * @throws when the package does not resolve or declares no `dsh.bundle.patch`.
 */
function bundlePatches(packageName: string): ReturnType<typeof loadOverlayPatches> {
  const dir = resolveBundleDir('test', packageName, installAnchor, serverDir)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string } }
  }
  const declared = manifest.dsh?.bundle?.patch
  if (declared === undefined) throw new Error(`profile bundle ${packageName} declares no dsh.bundle.patch`)
  return loadOverlayPatches('test', join(dir, declared))
}

/** One composed entry by id; an absent id throws rather than returning undefined into an expectation. */
function entry(entries: Entry[], id: string): Entry {
  const found = entries.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`composed no entry with id ${id}`)
  return found
}

/**
 * One shipped bundle's patch layer, every file its manifest's
 * `dsh.bundle.patch` names in order, read from workspace source.
 * @param dir - the bundle's package directory.
 * @returns the layer's patch list.
 */
function shippedPatches(dir: string): ReturnType<typeof loadOverlayPatches> {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string | string[] } }
  }
  const declared = manifest.dsh?.bundle?.patch
  if (declared === undefined) throw new Error(`shipped bundle ${dir} declares no dsh.bundle.patch`)
  return (typeof declared === 'string' ? [declared] : declared).flatMap(file => loadOverlayPatches('test', join(dir, file)))
}

// The two shipped bundles are workspace source here rather than payload
// packages: a launch resolves them from the installation, not from the deploy
// root the built-ins come from. dsh-web-app's layer includes its agent-preset
// files, which declare the presets whose child rows the cases below read.
const shippedLayers = [
  shippedPatches(join(repoRoot, 'packages', 'bundle', 'base')),
  shippedPatches(join(repoRoot, 'packages', 'bundle', 'web-app')),
]
const builtinLayers = BUILTIN_WEB_BUNDLES.map(name => ({ name, patches: bundlePatches(name) }))

const below = composeEntries([
  ...shippedLayers,
  ...builtinLayers.filter(layer => layer.name !== DESKTOP_APP).map(layer => layer.patches),
]) as Entry[]
const desktop = composeEntries([...shippedLayers, ...builtinLayers.map(layer => layer.patches)]) as Entry[]

describe('the desktop payload', () => {
  it('seeds the composition layer, so the layer below is one a launch applies', () => {
    expect(BUILTIN_WEB_BUNDLES).toContain(DESKTOP_APP)
  })

  it('names it last, the one position a fresh and an upgraded profile agree on', () => {
    expect(BUILTIN_WEB_BUNDLES.at(-1)).toBe(DESKTOP_APP)
  })

  it('resolves the bundle from the deploy root that becomes the payload', () => {
    expect(resolveBundleDir('test', DESKTOP_APP, installAnchor, serverDir)).toContain(join('apps', 'desktop-server'))
  })
})

describe('the composed session-query row', () => {
  it('stays off through every bundle layer below the desktop one', () => {
    expect(entry(below, 'session-query-sqlite').config?.['openAt']).toBe('never')
  })

  it('opens the index at the first search once the desktop layer applies', () => {
    const row = entry(desktop, 'session-query-sqlite')
    expect(row.config?.['openAt']).toBe('first-search')
    expect(row.disabled).toBeUndefined()
  })

  it('indexes into a durable derived database, not the ephemeral shipped one', () => {
    expect(entry(below, 'session-query-sqlite').config?.['path']).toBe(':memory:')
    expect(entry(desktop, 'session-query-sqlite').config?.['path']).toMatchObject({
      __jsExpr: "dshHomePath('session-search/desktop.db')",
    })
  })
})

/** The model-facing session tools the desktop layer mounts. */
const TOOL_SESSION_QUERY = '@deepseek-ai/dsh-tool-session-query'

/** The five tools that package registers. */
const SESSION_TOOLS = ['session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read']

/** The composed Host row that provides each service the package injects. */
const SESSION_TOOL_SERVICE_ROWS: Record<string, string> = {
  tools: 'tools',
  systemPrompt: 'system-prompt',
  sessionQuery: 'session-query-sqlite',
  sessionProjections: 'session-projection',
}

describe('the composed tool-session-query row', () => {
  it('is the desktop layer\'s own, inserted by no layer below it', () => {
    expect(below.find(row => row.id === 'tool-session-query')).toBeUndefined()
    expect(entry(desktop, 'tool-session-query')).toEqual({ id: 'tool-session-query', name: TOOL_SESSION_QUERY })
  })

  // The runtime resolver supplies a row's module from the installation's
  // dependency closure and each selected bundle's own; `@deepseek-ai/dsh`
  // does not depend on this one, and apps/desktop-server's list reaches neither.
  it('has its module declared by the desktop layer, the bundle that names it', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'apps', 'desktop-app', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(Object.keys(manifest.dependencies ?? {})).toContain(TOOL_SESSION_QUERY)
  })

  // A Host row can inject only Host services; a service a preset's isolate
  // realm holds never reaches it.
  it('injects only services Host rows the desktop composes on provide', () => {
    expect([...ToolSessionQuery.inject].sort()).toEqual(Object.keys(SESSION_TOOL_SERVICE_ROWS).sort())
    for (const rowId of Object.values(SESSION_TOOL_SERVICE_ROWS)) {
      expect(entry(desktop, rowId).disabled).toBeUndefined()
    }
  })

  // The deploy installs no peers, so a required peer reaches the payload only
  // when the deploy root lists it.
  it('has every required peer listed by the deploy root', () => {
    const own = JSON.parse(readFileSync(join(repoRoot, 'packages', 'session-query', 'tool-session-query', 'package.json'), 'utf8')) as {
      name: string
      peerDependencies?: Record<string, string>
    }
    expect(own.name).toBe(TOOL_SESSION_QUERY)
    const listed = Object.keys((JSON.parse(readFileSync(installAnchor, 'utf8')) as { dependencies: Record<string, string> }).dependencies)
    for (const name of Object.keys(own.peerDependencies ?? {})) expect(listed).toContain(name)
  })

  it('takes the package\'s own search bounds, and keeps the spill policy that bounds long results on', () => {
    expect(ToolSessionQuery.Config({})).toEqual({ maxSearchResults: 100, searchTimeoutMs: 30_000 })
    expect(entry(desktop, 'spill-policy').disabled).toBeUndefined()
  })
})

describe('the session tools in composed sessions', () => {
  // Real modules on the composed rows: the base's system-prompt and tools
  // rows, each preset's persona row, and the desktop layer's session-tools
  // row. Registering the five tools reads nothing from the query service, so
  // an empty one stands in for the `session-query-sqlite` row.
  const roots: Context[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  })

  /**
   * A root with the session tools mounted, and one session scope under the
   * named preset's persona.
   * @param presetId - the preset declaration row's id.
   * @returns the root, the preset's scope key, and the session's scope.
   */
  async function session(presetId: string): Promise<{ root: Context; presetKey: ScopeKey; agent: Scope }> {
    const root = new Context()
    roots.push(root)
    await root.plugin(SystemPrompt, entry(desktop, 'system-prompt').config ?? {})
    root.systemPrompt.variable('cwd', () => '/workspace')
    root.systemPrompt.variable('model', () => 'deepseek-flash')
    await root.plugin(ToolRuntime)
    await root.plugin(SessionProjectionRegistry)
    root.provide('sessionQuery', {})
    await root.plugin(ToolSessionQuery, entry(desktop, 'tool-session-query').config ?? {})
    const presetKey: ScopeKey = { preset: presetId }
    await createScope(root, presetKey).ctx.plugin(Persona, personaConfig(presetId))
    const agent = createScope(root, { agent: presetId }, { parent: presetKey })
    return { root, presetKey, agent }
  }

  /** @returns the session tools one scope's model sees, in registration order. */
  function sessionTools(root: Context, scope: Scope): string[] {
    return root.tools.schemas(keyOf(scope)).map(schema => schema.name).filter(name => SESSION_TOOLS.includes(name))
  }

  it.each(['preset-standard', 'preset-ptc', 'preset-cordis'])('gives a %s session the five tools and their guidance', async (presetId) => {
    const { root, agent } = await session(presetId)
    expect(sessionTools(root, agent)).toEqual(SESSION_TOOLS)
    expect(await prompt(root, agent)).toContain('Use session_search to find relevant work from prior sessions')
  })

  // `minimal`'s persona is `complete`, which replaces every other section;
  // the tool catalog is not part of the prompt.
  it('gives a preset-minimal session the five tools without their guidance', async () => {
    const { root, agent } = await session('preset-minimal')
    expect(sessionTools(root, agent)).toEqual(SESSION_TOOLS)
    expect(await prompt(root, agent)).toBe(personaConfig('preset-minimal').prefix)
  })

  it('gives a child the session delegates to the five tools, unless its allow-list leaves them out', async () => {
    const { root, presetKey, agent } = await session('preset-standard')
    const children: Scope[] = []
    await root.plugin({
      inject: ['systemPrompt', 'tools'],
      apply: (ctx: Context) => {
        const open = createScope(ctx, { agent: 'child' }, { parent: presetKey })
        applyChildComposition(open.ctx, { ctx: agent.ctx } as Agent, { persona: 'You review one file.' })
        const narrowed = createScope(ctx, { agent: 'narrowed-child' }, { parent: presetKey })
        applyChildComposition(narrowed.ctx, { ctx: agent.ctx } as Agent, { toolFilter: { allow: ['session_trace'] } })
        children.push(open, narrowed)
      },
    })
    const [open, narrowed] = children
    if (open === undefined || narrowed === undefined) throw new Error('the children were not composed')
    expect(sessionTools(root, open)).toEqual(SESSION_TOOLS)
    expect(sessionTools(root, narrowed)).toEqual(['session_trace'])
  })
})

describe('the composed llm-deepseek row', () => {
  it('accepts only the shipped ten-second Retry-After through the layers below', () => {
    expect(entry(below, 'llm-deepseek').config?.['retryPolicy']).toBeUndefined()
  })

  it('waits out a five-minute rate-limit window once the desktop layer applies', () => {
    expect(entry(desktop, 'llm-deepseek').config?.['retryPolicy']).toEqual({
      mode: 'normal',
      backoff: { maxDelayMs: 300_000 },
    })
  })
})

describe('the composed vision-switch row', () => {
  it('takes the plugin\'s compiled-in target through the layers below', () => {
    expect(entry(below, 'vision-switch').config?.['target']).toBeUndefined()
  })

  // The plugin's DEFAULT_TARGET is `deepseek-flash`, the same model the
  // composed default starts on. Comparing against the composed default is what
  // keeps the two moving together, rather than restating a model id here that a
  // later default change would leave behind.
  it('moves a session onto the model it already starts on', () => {
    expect(entry(desktop, 'vision-switch').config?.['target'])
      .toEqual(entry(desktop, 'agent-default-model').config)
  })

  it('restates enabled, which a whole-config replacement would drop', () => {
    expect(entry(desktop, 'vision-switch').config?.['enabled']).toBe(true)
  })
})

describe('the composed llm-permission-gateway row', () => {
  it('takes the gate\'s own factory route through the layers below', () => {
    expect(entry(below, 'llm-permission-gateway').config?.['model']).toBe('deepseek-flash')
  })

  // The judge runs on the same model the product runs on. Comparing against
  // the composed default keeps the two moving together.
  it('reviews on the model sessions start on', () => {
    expect(entry(desktop, 'llm-permission-gateway').config?.['model'])
      .toBe(entry(desktop, 'agent-default-model').config?.['model'])
  })

  // `provider` and `model` are the gate's only required fields and the only
  // two its own layer sets, so replacing the whole config drops nothing but
  // the default `alwaysAsk` map the desktop row restates.
  it('replaces a config that held exactly the two keys it restates, adding alwaysAsk', () => {
    expect(Object.keys(entry(below, 'llm-permission-gateway').config ?? {}).sort())
      .toEqual(['model', 'provider'])
    expect(Object.keys(entry(desktop, 'llm-permission-gateway').config ?? {}).sort())
      .toEqual(['alwaysAsk', 'model', 'provider'])
  })

  // The desktop map replaces the gate's default one, so every default entry
  // has to come back with the gate's own sentence, and the one entry it adds
  // is keyed by the name upstream's tool registers.
  it('asks a person before every plugin_manager call, and keeps each of the gate\'s own entries', async () => {
    const gatewayDir = resolveBundleDir('test', '@haoran/dsh-llm-permission-gateway', installAnchor, serverDir)
    const gateway = await import(pathToFileURL(join(gatewayDir, 'lib', 'index.js')).href) as {
      Config: (config: Record<string, unknown>) => { alwaysAsk: Record<string, string> }
    }
    const defaults = gateway.Config({ provider: 'p', model: 'm' }).alwaysAsk
    const registered: string[] = []
    applyPluginManagerTool({ tools: { register: (tool: { name: string }) => { registered.push(tool.name) } } } as never)
    expect(registered).toEqual(['plugin_manager'])

    const alwaysAsk = entry(desktop, 'llm-permission-gateway').config?.['alwaysAsk'] as Record<string, string>
    expect(Object.keys(alwaysAsk).sort()).toEqual([...Object.keys(defaults), ...registered].sort())
    for (const [tool, sentence] of Object.entries(defaults)) expect(alwaysAsk[tool]).toBe(sentence)
    expect(alwaysAsk['plugin_manager']?.trim().length).toBeGreaterThan(0)
  })
})

/**
 * One row inside one preset's plugin list.
 * @param entries - a composed entry list.
 * @param presetId - the preset declaration row's id.
 * @param rowId - the child row's id.
 * @returns the preset's child row.
 */
function presetRow(entries: Entry[], presetId: string, rowId: string): Entry {
  const plugins = entry(entries, presetId).config?.['plugins'] as Entry[] | undefined
  const found = plugins?.find(candidate => candidate.id === rowId)
  if (found === undefined) throw new Error(`${presetId} lists no ${rowId} row`)
  return found
}

/**
 * One preset's composed persona row, read field by field.
 * @param presetId - the preset declaration row's id.
 * @returns the row's config.
 */
function personaConfig(presetId: string): Persona.Config {
  const { prefix, suffix, complete, includeRuntimeContext } = presetRow(desktop, presetId, 'persona').config ?? {}
  if (typeof prefix !== 'string') throw new Error(`${presetId}'s persona row states no prefix`)
  return {
    prefix,
    ...typeof suffix === 'string' ? { suffix } : {},
    ...typeof complete === 'boolean' ? { complete } : {},
    ...typeof includeRuntimeContext === 'boolean' ? { includeRuntimeContext } : {},
  }
}

/**
 * The key a composed scope was created under.
 * @param scope - a scope from `createScope`.
 * @returns its key.
 */
function keyOf(scope: Scope): ScopeKey {
  const key = scopeOf(scope.ctx)
  if (key === undefined) throw new Error('the scope carries no key')
  return key
}

/**
 * The system prompt one scope renders.
 * @param root - the root carrying the composed prompt registry.
 * @param scope - the session or child scope.
 * @returns the rendered prompt.
 */
async function prompt(root: Context, scope: Scope): Promise<string> {
  return renderPrompt(await root.systemPrompt.assemble({ scope: keyOf(scope) }))
}

/**
 * Evaluate a composed `!!js` value the way the Loader does, against a given
 * `process.env`.
 * @param value - the composed field, `{ __jsExpr }` as `loadOverlayPatches` reads it.
 * @param env - the environment the expression sees.
 * @returns what the expression evaluates to.
 */
function evaluateWithEnv(value: unknown, env: Record<string, string>): unknown {
  const expression = (value as { __jsExpr?: unknown } | undefined)?.__jsExpr
  if (typeof expression !== 'string') throw new Error(`not a !!js value: ${JSON.stringify(value)}`)
  // oxlint-disable-next-line typescript/no-implied-eval -- evaluates this repository's own layer, as the Loader does
  return (new Function('process', `return (${expression})`) as (process: { env: Record<string, string> }) => unknown)({ env })
}

describe('the composed server-log row', () => {
  it('is the desktop layer\'s own, inserted by no layer below it', () => {
    expect(below.find(candidate => candidate.id === 'desktop-server-log')).toBeUndefined()
    expect((entry(desktop, 'desktop-server-log') as Entry & { name?: string }).name).toBe('@deepseek-ai/dsh-desktop-app/server-log')
  })

  // The shell names its log file in this variable for the server child; a
  // boot without the shell names nothing and mounts no exporter.
  it('mounts only when the shell names a file, and appends to that file', () => {
    const row = entry(desktop, 'desktop-server-log')
    expect(evaluateWithEnv(row.disabled, { [SERVER_LOG_ENV]: '/logs/dsh-server.log' })).toBe(false)
    expect(evaluateWithEnv(row.disabled, {})).toBe(true)
    expect(evaluateWithEnv(row.config?.['file'], { [SERVER_LOG_ENV]: '/logs/dsh-server.log' })).toBe('/logs/dsh-server.log')
  })

  // cordis orders ERROR 0 < INFO 1 < WARN 2 < DEBUG 3, so the threshold that
  // keeps warnings is 2, not the INFO a reader would expect to cover them.
  it('keeps warnings and drops debug', () => {
    expect(entry(desktop, 'desktop-server-log').config?.['level']).toBe(2)
  })
})

describe('the composed plugin-manager rows', () => {
  const profileGate = { __jsExpr: "!ctx.get('profileContext')" }

  it('mounts upstream\'s installer under a profile through the layers below', () => {
    expect(entry(below, 'plugin-manager').disabled).toEqual(profileGate)
    expect(entry(below, 'plugin-manager').config).toBeUndefined()
    expect(entry(below, 'ui-plugin-manager').disabled).toBeUndefined()
  })

  it('keeps the Host service and the sidebar page on under a profile once the desktop layer applies', () => {
    expect(entry(desktop, 'plugin-manager').disabled).toEqual(profileGate)
    expect(entry(desktop, 'ui-plugin-manager').disabled).toBeUndefined()
  })

  it('sets pnpmCommand and requiredModules and nothing else', () => {
    expect(Object.keys(entry(desktop, 'plugin-manager').config ?? {})).toEqual(['pnpmCommand', 'requiredModules'])
  })

  // The seed puts a required bundle back into the profile at every launch and
  // the service locks the rows it names, so the two lists are one decision.
  it('requires exactly the bundles the shell seed puts back on at every launch', () => {
    expect(entry(desktop, 'plugin-manager').config?.['requiredModules']).toEqual([...REQUIRED_WEB_BUNDLES])
  })

  it('names in requiredModules only built-ins whose own layer inserts a row of that module', () => {
    for (const name of REQUIRED_WEB_BUNDLES) {
      expect(BUILTIN_WEB_BUNDLES).toContain(name)
      const inserted = composeEntries([bundlePatches(name)]) as (Entry & { name?: string })[]
      expect(inserted.map(row => row.name)).toContain(name)
    }
  })

  it('composes a config the plugin manager accepts', () => {
    const config = entry(desktop, 'plugin-manager').config ?? {}
    const resolved = PluginManager.Config({ ...config, pnpmCommand: String(evaluateWithEnv(config['pnpmCommand'], {})) })
    expect(resolved.requiredModules).toEqual([...REQUIRED_WEB_BUNDLES])
    expect(resolved.pnpmCommand).toBe('pnpm')
  })

  // The packaged shell names the launcher in this variable; a development
  // launch names nothing.
  it('runs the launcher the shell names, and pnpm on PATH when it names none', () => {
    const pnpmCommand = entry(desktop, 'plugin-manager').config?.['pnpmCommand']
    expect(evaluateWithEnv(pnpmCommand, { [PNPM_LAUNCHER_ENV]: '/app/runtime/dsh-pnpm' })).toBe('/app/runtime/dsh-pnpm')
    expect(evaluateWithEnv(pnpmCommand, {})).toBe('pnpm')
  })

  // The cordis preset enables the agent tool under a profile, and its row sits
  // in the preset's `config.plugins`, where no id-targeted patch reaches. It
  // injects the service the Host row provides, so with that row on it mounts;
  // the gateway row's `alwaysAsk` is what sends each of its calls to a person.
  it('leaves the cordis preset\'s tool row gated on the profile alone, over a service that now registers', () => {
    expect(presetRow(below, 'preset-cordis', 'tool-plugin-manager').disabled).toEqual(profileGate)
    expect(presetRow(desktop, 'preset-cordis', 'tool-plugin-manager').disabled).toEqual(profileGate)
    expect(pluginManagerToolInject).toContain('pluginManager')
  })
})

describe('the composed office-to-pdf row', () => {
  it('starts LibreOffice converters through the layers below', () => {
    expect(entry(below, 'office-to-pdf').disabled).toBeUndefined()
  })

  // The payload carries no engine; the shell downloads one into the data
  // directory on request and the converter the next preview creates finds it,
  // so the row stays on from launch.
  it('stays on once the desktop layer applies', () => {
    expect(entry(desktop, 'office-to-pdf')).toEqual(entry(below, 'office-to-pdf'))
    expect(entry(desktop, 'office-to-pdf').disabled).toBeUndefined()
  })
})

describe('the composed ui-chat row', () => {
  it('takes the form\'s default through the layers below', () => {
    expect(entry(below, 'ui-chat').config).toBeUndefined()
  })

  // No base value for `transcriptView`, so work details start at the form's
  // own default, as on upstream's Web client.
  it('stays as the layers below ship it once the desktop layer applies', () => {
    expect(entry(desktop, 'ui-chat')).toEqual(entry(below, 'ui-chat'))
    expect(entry(desktop, 'ui-chat').config).toBeUndefined()
  })
})

describe('the composed brand row', () => {
  it('is absent below the desktop layer', () => {
    expect(below.find(row => row.id === 'desktop-brand')).toBeUndefined()
  })

  it('mounts this package with the protected-directories templates its Host half fills', () => {
    expect(entry(desktop, 'desktop-brand')).toEqual({
      id: 'desktop-brand',
      name: DESKTOP_APP,
      config: {
        ...PROTECTED_DIRS_TEMPLATES,
        ...Object.fromEntries(Object.entries(SHELL_DIRECTORY_ENV).map(([field, name]) => [field, { __jsExpr: `process.env.${name}` }])),
      },
    })
  })

  it.each(Object.entries(SHELL_DIRECTORY_ENV))('takes %s from %s, and nothing when the shell sets none', (field, name) => {
    const expression = entry(desktop, 'desktop-brand').config?.[field]
    expect(evaluateWithEnv(expression, { [name]: '/some/北冥 dir' })).toBe('/some/北冥 dir')
    expect(evaluateWithEnv(expression, {})).toBeUndefined()
  })
})

describe('the protected-directories section in composed sessions', () => {
  // The composed rows drive real modules: the base's system-prompt row, each
  // preset's persona row, and the desktop row through this package's Host
  // half resolved from the payload's deploy root. A preset's rows compose
  // behind the preset's own scope, and the agent-preset registry binds a
  // session's scope, and a delegated child's, under it; the child then adds
  // its own persona prefix through dsh-subagent's composition step.
  // The Host half's own `Config` validates the composed row as the Loader's mount does.
  type RowPlugin = Plugin.Object<Entry['config']>

  const INSTALL_DIR = '/Applications/北冥.app'
  const DATA_DIR = '/Users/test user/.dsh'
  const USER_DATA_DIR = '/Users/test user/Library/Application Support/@deepseek-ai/dsh-desktop'
  const LOG_DIR = '/Users/test user/Library/Logs/@deepseek-ai/dsh-desktop'
  const UPDATE_CACHE_DIR = '/Users/test user/Library/Caches/@deepseek-aidsh-desktop-updater'
  // `resolveDshHome` resolves the home with the platform's path rules.
  const LINE = 'Unless the user explicitly asks, do not modify, move, or delete this app\'s own directories: '
    + `the installation directory (\`${INSTALL_DIR}\`), the data directory (\`${resolve(DATA_DIR)}\`), `
    + `the settings folder (\`${USER_DATA_DIR}\`), the logs folder (\`${LOG_DIR}\`) and the update download folder (\`${UPDATE_CACHE_DIR}\`). `
    + `The skills folder \`${join(resolve(DATA_DIR), 'skills')}\` is exempt.`
  const roots: Context[] = []
  beforeEach(() => {
    vi.stubEnv('DSH_HOME', DATA_DIR)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  })

  /**
   * A root with the composed registry and the desktop row mounted, and one
   * session scope under the named preset's persona.
   * @param presetId - the preset declaration row's id.
   * @returns the root, the preset's scope key, and the session's scope.
   */
  async function session(presetId: string): Promise<{ root: Context; presetKey: ScopeKey; agent: Scope }> {
    const root = new Context()
    roots.push(root)
    await root.plugin(SystemPrompt, entry(desktop, 'system-prompt').config ?? {})
    root.systemPrompt.variable('cwd', () => '/workspace')
    root.systemPrompt.variable('model', () => 'deepseek-flash')
    const hostDir = resolveBundleDir('test', DESKTOP_APP, installAnchor, serverDir)
    const host = await import(pathToFileURL(join(hostDir, 'src', 'index.ts')).href) as RowPlugin
    const brand = entry(desktop, 'desktop-brand').config ?? {}
    const env = {
      [INSTALL_DIR_ENV]: INSTALL_DIR,
      [USER_DATA_DIR_ENV]: USER_DATA_DIR,
      [LOG_DIR_ENV]: LOG_DIR,
      [UPDATE_CACHE_DIR_ENV]: UPDATE_CACHE_DIR,
    }
    const evaluated = Object.fromEntries(Object.keys(SHELL_DIRECTORY_ENV).map(field => [field, evaluateWithEnv(brand[field], env)]))
    await root.plugin(host, { ...brand, ...evaluated })
    const presetKey: ScopeKey = { preset: presetId }
    await createScope(root, presetKey).ctx.plugin(Persona, personaConfig(presetId))
    const agent = createScope(root, { agent: presetId }, { parent: presetKey })
    return { root, presetKey, agent }
  }

  it.each(['preset-standard', 'preset-ptc', 'preset-cordis'])('ends the prompt of a %s session', async (presetId) => {
    const { root, agent } = await session(presetId)
    const text = await prompt(root, agent)
    expect(text.endsWith(`Your working directory is /workspace.\n\n${LINE}`)).toBe(true)
  })

  it('ends the prompt of a child that session delegates to, under the child\'s own persona', async () => {
    const { root, presetKey, agent } = await session('preset-standard')
    // The driver composes a child from a context that injects the registry.
    let child: Scope | undefined
    await root.plugin({
      inject: ['systemPrompt'],
      apply: (ctx: Context) => {
        child = createScope(ctx, { agent: 'child' }, { parent: presetKey })
        applyChildComposition(child.ctx, { ctx: agent.ctx } as Agent, { persona: 'You review one file.' })
      },
    })
    if (child === undefined) throw new Error('the child was not composed')
    const text = await prompt(root, child)
    expect(text).toContain('You review one file.')
    expect(text.endsWith(LINE)).toBe(true)
  })

  // `minimal`'s persona is `complete`, which replaces every other section.
  it('is absent from a preset-minimal session', async () => {
    const { root, agent } = await session('preset-minimal')
    expect(personaConfig('preset-minimal').complete).toBe(true)
    expect(await prompt(root, agent)).toBe(personaConfig('preset-minimal').prefix)
  })
})

describe('the composed telemetry rows', () => {
  // The composed row is what a launch applies, so a later bundle layer
  // re-enabling one of these shows up here and nowhere else. The shipped rows
  // belong to `packages/bundle/base/tests/base.spec.ts` and the reason a mode
  // cannot carry the decision to
  // `packages/session/session-telemetry-otel/tests/otel.spec.ts`; the second
  // layer — the `DSH_TELEMETRY_DISABLED` this shell puts on the spawned server,
  // which reaches the telemetry row alone — belongs to `tests/server.spec.ts`.
  it('composes every DeepSeek-bound reporter off, through every bundle layer', () => {
    expect(entry(desktop, 'otel').disabled).toBe(true)
    expect(entry(desktop, 'session-telemetry-otel').disabled).toBe(true)
    expect(entry(desktop, 'plugin-package-inventory-deepseek').disabled).toBe(true)
    // The desktop layer's own two; below it, an expression on the profile
    // name keeps them off.
    expect(entry(desktop, 'desktop-product-telemetry').disabled).toBe(true)
    expect(entry(desktop, 'product-analytics').disabled).toBe(true)
    // Mounted rather than disabled, so Settings → General serves its upload
    // switch; `enabled: false` is that switch's shipped value, and the
    // request contribution adds nothing while it reads false.
    expect(entry(desktop, 'session-log-deepseek').config).toEqual({ enabled: false })
  })

  it('switches the product analytics rows off without replacing their config', () => {
    for (const id of ['desktop-product-telemetry', 'product-analytics']) {
      expect(entry(below, id).disabled).not.toBe(true)
      expect(entry(desktop, id).config).toEqual(entry(below, id).config)
    }
  })
})

describe('the desktop composition layer as a whole', () => {
  it('changes exactly seven rows, adds its own three, and nothing else', () => {
    const changed = desktop.filter((row) => {
      const before = below.find(candidate => candidate.id === row.id)
      return before === undefined || JSON.stringify(before) !== JSON.stringify(row)
    })
    // Sorted, because the order these come back in is the order dsh-base
    // happens to list them and carries nothing about this layer.
    expect(changed.map(row => row.id).sort()).toEqual([
      'desktop-brand', 'desktop-product-telemetry', 'desktop-server-log', 'llm-deepseek', 'llm-permission-gateway',
      'plugin-manager', 'product-analytics', 'session-query-sqlite', 'tool-session-query', 'vision-switch',
    ])
  })

  // No layer of this payload picks the default model: a session starts on
  // dsh-base's own `agent-default-model`, the value upstream ships.
  it('starts sessions on dsh-base\'s own default model', () => {
    const base = composeEntries([shippedLayers[0] ?? []]) as Entry[]
    expect(entry(desktop, 'agent-default-model')).toEqual(entry(base, 'agent-default-model'))
  })

  // `resolveModels` reads `config.models ?? DEFAULT_MODELS`, so a row without
  // `models` leaves the picker on the adapter's own catalog, and a table any
  // layer sets would replace that catalog whole.
  it('sets no model catalog, so the picker lists the adapter\'s own', () => {
    const composed = entry(desktop, 'llm-deepseek').config ?? {}
    expect(Object.keys(composed)).toEqual(['retryPolicy'])
    expect(DeepSeekConfig(composed).models.get()).toEqual(DeepSeekConfig({}).models.get())
  })

  it('lists the model the composed default starts every session on', () => {
    const models = DeepSeekConfig(entry(desktop, 'llm-deepseek').config ?? {}).models.get()
    expect(entry(desktop, 'agent-default-model').config?.['provider']).toBe('deepseek-official')
    expect(models.map(row => row.id)).toContain(entry(desktop, 'agent-default-model').config?.['model'])
  })
})
