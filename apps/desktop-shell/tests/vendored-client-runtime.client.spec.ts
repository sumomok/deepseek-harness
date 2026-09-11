// @vitest-environment jsdom
/**
 * Every vendored built-in's browser half, applied in the client runtime the
 * shipped page actually uses.
 *
 * The page loads a plugin's `lib/client.js` through the client module table and
 * then applies its exported Cordis plugin; one `apply` that throws fails the
 * whole boot, so a single bad bundle takes the application down rather than
 * degrading. The checks that would have caught rc.32's
 * `@haoran/dsh-desktop-update` failure all live in production code the bundle
 * only meets at that moment — `RemoteNamespaceService.assertMethodAvailable`
 * rejecting a Remote method that collides with its own namespace service, the
 * SlotRegistry's declaration ledger, and the locale registry — so a static scan
 * of the manifest and a `vm` run against a hand-written `ctx` both reported a
 * healthy payload.
 *
 * What is real here: the {@link ClientModuleSystem} module table and its
 * `require` resolution over the production platform seed, the SlotRegistry, the
 * locale runtime, the Typert registry, and the Client Remote service that owns
 * the namespace and method rules. What is stubbed is the Host across the wire:
 * the Connection carrier answers nothing, the settings transport is an
 * in-memory scope, and the Host-served `session` namespace is
 * {@link HOST_SESSION_NAMESPACE}, mounted through the real registrar because
 * the generated contributions exist only in built `lib/` and this suite runs on
 * the source plane. Nothing here calls a Remote method, so the vendored halves
 * never depend on an answer.
 *
 * The HTML `__ModuleLoader__` facade is rebuilt here as a plain object instead
 * of evaluating the injected script, which needs a built client-modules bundle;
 * `packages/client/modules/tests` owns the facade's own behavior.
 * @module
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as clientModules from '@deepseek-ai/dsh-client-modules/client'
import type {
  ClientBundleRegistration, ClientModuleCreateOptions, ClientModuleLoaderTarget, ClientModuleSystem,
  WebBootEntry, WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'
import { orderByModuleGraph } from '@deepseek-ai/dsh-client-modules'
import { getStaticModules } from '@deepseek-ai/dsh-client-web'
import { SlotTestRuntime, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import * as gatewayClient from '@deepseek-ai/dsh-api-gateway/client'
import * as typertRegistryClient from '@deepseek-ai/dsh-typert-registry/client'
import * as localeClient from '@deepseek-ai/dsh-client-locale/client'
import * as inputTriggerClient from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BUILTIN_WEB_BUNDLES } from '../src/profile-seed.ts'

// The deploy root whose `node_modules` becomes the payload's server closure:
// resolving from its manifest reads the very package files the packaged app
// ships, vendored tarball contents included.
const serverManifest = join(process.cwd(), 'apps', 'desktop-server', 'package.json')
const fromServer = createRequire(serverManifest)

/** The `dsh.client` fields this suite reads from a built-in's manifest. */
interface ClientDeclaration {
  platform?: string
  inject?: string[]
  external?: string[]
  immediately?: boolean
}

/** The manifest fields this suite reads from a built-in package. */
interface BuiltinPackage {
  name?: string
  exports?: Record<string, string | { default?: string }>
  dsh?: { client?: ClientDeclaration }
}

/** One built-in's boot row plus the built bundle behind it. */
interface BuiltinRow extends WebBootEntry {
  /** Absolute path to the `./client` artifact the package declares. */
  readonly bundlePath: string
}

/**
 * Resolve the built browser artifact a package's `./client` export names.
 * @param manifestPath - absolute path to the package manifest.
 * @param pkg - the parsed manifest.
 * @returns absolute path to the client bundle.
 */
function clientBundlePath(manifestPath: string, pkg: BuiltinPackage): string {
  const declared = pkg.exports?.['./client']
  const relative = typeof declared === 'string' ? declared : declared?.default
  if (relative === undefined) {
    throw new Error(`vendored client runtime: ${pkg.name ?? manifestPath} declares dsh.client without a ./client export`)
  }
  return resolve(dirname(manifestPath), relative)
}

/**
 * Read every seeded built-in that carries a browser half, in the order the
 * shell seeds them.
 * @returns one row per built-in declaring `dsh.client`.
 */
function builtinRows(): readonly BuiltinRow[] {
  const rows: BuiltinRow[] = []
  for (const name of BUILTIN_WEB_BUNDLES) {
    const manifestPath = fromServer.resolve(`${name}/package.json`)
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuiltinPackage
    const declaration = pkg.dsh?.client
    if (declaration === undefined) continue
    if (declaration.platform !== 'web') {
      throw new Error(`vendored client runtime: ${name} declares dsh.client for ${String(declaration.platform)}`)
    }
    rows.push({
      id: name,
      bundlePath: clientBundlePath(manifestPath, pkg),
      url: `/plugins/??${name}/client.js&rev=fx`,
      rev: 'fx',
      ...(declaration.inject === undefined ? {} : { inject: declaration.inject }),
      ...(declaration.external === undefined ? {} : { external: declaration.external }),
      ...(declaration.immediately === true ? { immediately: true } : {}),
    })
  }
  return rows
}

const ROWS = builtinRows()

/**
 * Seeded built-ins with no browser half: `default-model` composes Host rows
 * only, and `desktop-app` is this repository's own composition layer. Neither
 * gives this gate anything to apply.
 */
const WITHOUT_CLIENT_HALF = ['@haoran/dsh-default-model', '@deepseek-ai/dsh-desktop-app']

/**
 * Compose the boot graph for one selection of rows, ordered the way the Host
 * orders the served graph.
 * @param rows - the rows this page carries.
 * @returns the graph handed to the module table.
 */
function bootGraph(rows: readonly BuiltinRow[]): WebBootGraph {
  const ordered = orderByModuleGraph(rows.map(({ bundlePath: _bundlePath, ...entry }) => entry))
  return {
    rev: 'fx',
    entries: [...ordered],
    batches: [{
      phase: 'application',
      url: '/plugins/??application&rev=fx',
      rev: 'fx',
      entries: ordered.map(entry => entry.id),
    }],
  }
}

/**
 * Build the production module table over the built bundles of one selection.
 * @param rows - the rows this page carries.
 * @returns the live module system, with every bundle reachable by id.
 */
function moduleSystem(rows: readonly BuiltinRow[]): ClientModuleSystem {
  const graph = bootGraph(rows)
  const bundles = new Map(rows.map(row => [row.url, readFileSync(row.bundlePath, 'utf8')]))
  for (const batch of graph.batches) {
    bundles.set(batch.url, batch.entries.map((id) => {
      const code = bundles.get(`/plugins/??${id}/client.js&rev=fx`)
      if (code === undefined) throw new Error(`vendored client runtime: batch names unknown row ${id}`)
      return code
    }).join('\n;\n'))
  }
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load(registration) { pendingQueue.push(registration) },
    create(options: ClientModuleCreateOptions) {
      return clientModules.createClientModuleSystem(
        target,
        { id: '@deepseek-ai/dsh-client-modules', exports: clientModules },
        options,
      )
    },
  }
  ;(globalThis as { __ModuleLoader__?: ClientModuleLoaderTarget }).__ModuleLoader__ = target
  return target.create({
    boot: graph,
    staticModules: getStaticModules(),
    loadBundle: (url) => {
      const code = bundles.get(url)
      if (code === undefined) throw new Error(`vendored client runtime: no bundle for ${url}`)
      // Classic-script execution, exactly how the served combo bundle arrives.
      ;(0, eval)(code)
      return Promise.resolve()
    },
  })
}

/**
 * Stand-in for the Host-served `session` namespace three vendored halves
 * inject. The generated contribution the Client assembly mounts in production
 * is emitted into built `lib/` only, so this suite mounts one descriptor of its
 * own through the same registrar to publish `remote.session`. No vendored half
 * calls a method on it while applying.
 */
const HOST_SESSION_NAMESPACE = {
  package: 'apps/desktop-shell/tests/vendored-client-runtime',
  descriptors: [{
    id: 'apps/desktop-shell/tests/vendored-client-runtime#session/ping',
    service: 'session',
    namespace: 'session',
    method: 'ping',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: 'apps/desktop-shell/tests/vendored-client-runtime#Ping',
      schema: { parse: (value: unknown) => value },
    },
  }],
} as unknown as TypertRemoteContribution

/** One assembled page: the runtime plus the teardown that unwinds it. */
interface Page {
  /** The slot runtime carrying the Cordis root every half mounts on. */
  readonly runtime: SlotTestRuntime
  /** Unwind the page; feature fibers fall before the Host namespaces they injected. */
  dispose(): Promise<void>
}

/**
 * The Connection carrier with no Host behind it: the Client Remote service
 * needs a handle to construct, and nothing in this suite sends a request.
 * @returns the carrier stub.
 */
function connectionStub(): unknown {
  return {
    isLoopback: true,
    rpc: {
      open: () => { throw new Error('vendored client runtime: this gate serves no Host stream') },
      call: () => Promise.reject(new Error('vendored client runtime: this gate serves no Host RPC')),
    },
    generation: { getSnapshot: () => undefined },
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
  }
}

/**
 * Assemble the page a vendored half mounts on: the production slot runtime,
 * the Typert registry, the Client Remote service, the locale runtime, the input
 * trigger service, and the Conversation assembly.
 * @returns the assembled page.
 */
async function page(): Promise<Page> {
  const runtime = await SlotTestRuntime.create()
  const ctx: Context = runtime.ctx
  ctx.provide('connection', connectionStub() as never)
  await ctx.plugin(typertRegistryClient).await()
  await ctx.plugin(gatewayClient).await()
  // The Host settings document: the locale runtime binds one namespace on it
  // during apply and reads the snapshot, never the wire.
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope, describe: () => ({}) } as never)
  await ctx.plugin(localeClient).await()
  await ctx.plugin(inputTriggerClient).await()
  new UiConversation(ctx, runtime.sessions)
  const unmountSession = await ctx.remote.$mount(HOST_SESSION_NAMESPACE)
  return {
    runtime,
    dispose: async () => {
      await runtime.dispose()
      await unmountSession()
    },
  }
}

describe('vendored built-in client halves', () => {
  let open: Page | undefined
  afterEach(async () => {
    await open?.dispose()
    open = undefined
  })

  it('covers every seeded built-in that carries a browser half', () => {
    // A seeded package that grows a `dsh.client` declaration joins the rows
    // automatically and leaves this list stale, which is what says so aloud.
    expect([...ROWS.map(row => row.id), ...WITHOUT_CLIENT_HALF].sort())
      .toStrictEqual([...BUILTIN_WEB_BUNDLES].sort())
    const manifest = JSON.parse(readFileSync(serverManifest, 'utf8')) as { dependencies?: Record<string, string> }
    for (const row of ROWS) {
      expect(manifest.dependencies?.[row.id], `${row.id} is not a vendored tarball`).toMatch(/^file:/)
    }
  })

  it('materializes every bundle through the real module table', async () => {
    const modules = moduleSystem(ROWS)
    for (const row of ROWS) {
      const half = await modules.import(row.id) as { apply?: unknown }
      expect(typeof half.apply, `${row.id} exports no apply`).toBe('function')
    }
  })

  it.each(ROWS.map(row => [row.id, row] as const))('%s applies', async (_id, row) => {
    const modules = moduleSystem([row])
    const half = await modules.import(row.id) as object
    const mounted = await page()
    open = mounted
    mounted.runtime.ctx.provide('modules', modules as never)
    await mounted.runtime.mount(half as never)
  })

  it('applies the whole seeded set on one page', async () => {
    const modules = moduleSystem(ROWS)
    const mounted = await page()
    open = mounted
    mounted.runtime.ctx.provide('modules', modules as never)
    for (const row of ROWS) {
      await mounted.runtime.mount(await modules.import(row.id) as never)
    }
  })
})
