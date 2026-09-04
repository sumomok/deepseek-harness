// Shared scaffolding for the assembled-jsdom snapshots: the real built
// workspace `lib/client.js` artifacts booted through AppWebEntry's
// ModuleLoader path (loadBundle) against the keyless FixtureApiClient
// transport. Every file that mounts this graph needs the same boot entry list,
// the same bundle map, the same jsdom globals, and the same mount call, and
// differs only in what it asserts afterwards, so the scaffolding lives here.
//
// Keyless and deterministic: the fixture is the fake server, so nothing here
// reaches a model or the network.
//
// The harness mounts on a deployment prefix as well as on the origin root. A
// prefixed mount reproduces what `dsh-server-base` injects at run time — the
// page address, `<base href>`, and `__DSH_BASE__` — so a scenario can assert
// that the shell resolves its own URLs against the deployment prefix instead of
// the origin root.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { bootInjections, orderByModuleGraph } from '@deepseek-ai/dsh-client-modules'
import type { ClientModuleLoaderTarget, WebBootEntry } from '@deepseek-ai/dsh-client-modules/client'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

interface AssembledPlugin extends WebBootEntry {
  /** Absolute path to the built client artifact declared by this package. */
  bundlePath: string
}

interface ClientPackageManifest {
  name?: string
  exports?: Record<string, string | { default?: string }>
  dsh?: {
    client?: {
      platform?: string
      inject?: string[]
      external?: string[]
      immediately?: boolean
    }
  }
}

interface ComposedEntry {
  name?: unknown
  disabled?: unknown
}

interface BootComposition {
  loadOverlayPatches(binName: string, file: string): unknown[]
  composeEntries(layers: readonly unknown[][]): ComposedEntry[]
}

const REPO_ROOT = process.cwd()
const BUNDLE_LAYERS = [
  {
    manifest: join(REPO_ROOT, 'packages/bundle/base/package.json'),
    patch: join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml'),
  },
  {
    manifest: join(REPO_ROOT, 'packages/bundle/web-app/package.json'),
    patch: join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml'),
  },
] as const
const bundleResolvers = BUNDLE_LAYERS.map(layer => createRequire(layer.manifest))
const webBundleResolver = bundleResolvers[1]
if (webBundleResolver === undefined) throw new Error('assembled boot: web bundle resolver missing')
const appBoot = await import(pathToFileURL(webBundleResolver.resolve('@deepseek-ai/dsh-app-boot')).href) as unknown as BootComposition

function resolvePackageManifest(specifier: string): string | undefined {
  for (const require of bundleResolvers) {
    try {
      return require.resolve(`${specifier}/package.json`)
    } catch {
      continue
    }
  }
  return undefined
}

function resolveClientExport(packagePath: string, pkg: ClientPackageManifest): string {
  const declared = pkg.exports?.['./client']
  const relative = typeof declared === 'string' ? declared : declared?.default
  if (relative === undefined) {
    throw new Error(`assembled boot: ${pkg.name ?? packagePath} declares dsh.client without a ./client export`)
  }
  return resolve(dirname(packagePath), relative)
}

/** Derive the assembled browser graph from the same bundle patches and package declarations as `dsh web`. */
function loadAssembledPlugins(): readonly AssembledPlugin[] {
  const entries = appBoot.composeEntries(BUNDLE_LAYERS.map(layer =>
    appBoot.loadOverlayPatches('assembled boot', layer.patch)))
  const plugins = new Map<string, AssembledPlugin>()
  for (const entry of entries) {
    if (entry.disabled === true || typeof entry.name !== 'string') continue
    const packagePath = resolvePackageManifest(entry.name)
    if (packagePath === undefined) continue
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as ClientPackageManifest
    const declaration = pkg.dsh?.client
    if (declaration?.platform !== 'web') continue
    if (pkg.name !== entry.name) {
      throw new Error(`assembled boot: ${entry.name} resolved package ${pkg.name ?? '<unnamed>'}`)
    }
    plugins.set(entry.name, {
      id: entry.name,
      bundlePath: resolveClientExport(packagePath, pkg),
      // Mirrors the url `graphRow` in @deepseek-ai/dsh-client-modules mints for
      // a bundle row. It is a mirror, not an import (that helper is private),
      // so it moves whenever that one does — the prefixed-mount scenario is
      // what makes a drift fail rather than pass quietly.
      url: `plugins/${entry.name}/client.js?rev=fx`,
      rev: 'fx',
      ...(declaration.inject === undefined ? {} : { inject: declaration.inject }),
      ...(declaration.external === undefined ? {} : { external: declaration.external }),
      ...(declaration.immediately === true ? { immediately: true } : {}),
    })
  }
  return orderByModuleGraph([...plugins.values()]).map(({ id }) => {
    const plugin = plugins.get(id)
    /* v8 ignore next -- orderByModuleGraph returns the input row identities */
    if (plugin === undefined) throw new Error(`assembled boot: ordered unknown client package ${id}`)
    return plugin
  })
}

const PLUGINS = loadAssembledPlugins()

let bundleSources: Map<string, string> | undefined

/**
 * The built bundle bytes, keyed by manifest url and read on first mount. Read
 * lazily so the boot-manifest assertions below (which need only the composed
 * graph) run on a checkout whose `lib/` has not been built yet.
 * @returns the bundle source for every row of the assembled graph.
 */
function bundles(): Map<string, string> {
  bundleSources ??= new Map(PLUGINS.map(plugin => [
    plugin.url,
    readFileSync(plugin.bundlePath, 'utf8'),
  ]))
  return bundleSources
}

/** Deployment prefix of an origin-root mount, which is where this lane serves the shell. */
const ROOT_BASE_PATH = '/'

/**
 * Reject a prefix the Host would reject: `dsh-server-base` requires a leading
 * and a trailing slash so `<base href>` names a directory rather than a file.
 * @param basePath - the deployment prefix under test.
 */
function assertBasePath(basePath: string): void {
  if (!basePath.startsWith('/') || !basePath.endsWith('/')) {
    throw new Error(`assembled boot: deployment prefix ${JSON.stringify(basePath)} must start and end with '/'`)
  }
}

interface FixtureWindow extends Window {
  __DSH_BOOT__?: { rev: string; entries: WebBootEntry[] }
  __DSH_BASE__?: string
  __ModuleLoader__?: ClientModuleLoaderTarget
}

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

class EventSourceStub {
  addEventListener(): void {}
  close(): void {}
}

const win = window as FixtureWindow
let unmount: (() => Promise<void>) | undefined

/**
 * Register the per-test jsdom setup and teardown the assembled boot needs:
 * English pinned before boot so role/text locators stay deterministic across
 * localized component migrations (the newEnglishPage e2e convention), the
 * observers and frame callbacks jsdom lacks, and a full reset of the document,
 * the boot globals, and the injected plugin styles afterwards.
 */
export function installAssembledBootEnv(): void {
  beforeEach(() => {
    localStorage.clear()
    // The locale service derives its provisional locale from the browser and
    // takes an explicit choice only from Host settings, which this lane's
    // fixture transport does not serve; pinning the navigator is what selects
    // English here.
    Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true })
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
    document.title = 'DeepSeek Harness'
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('EventSource', EventSourceStub)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => { callback(0) }, 0) as unknown as number)
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(id) })
  })

  afterEach(async () => {
    await act(async () => { await unmount?.() })
    unmount = undefined
    cleanup()
    delete win.__DSH_BOOT__
    delete win.__ModuleLoader__
    document.body.innerHTML = ''
    document.head.querySelectorAll('style[data-plugin]').forEach((style) => { style.remove() })
    document.head.querySelectorAll('base[data-dsh-base]').forEach((base) => { base.remove() })
    delete win.__DSH_BASE__
    document.title = ''
    history.replaceState(null, '', ROOT_BASE_PATH)
    // Deleting the own properties uncovers jsdom's own accessors again
    // (Navigator declares both readonly, hence the erased receiver).
    const ownNavigator = navigator as unknown as Record<string, unknown>
    delete ownNavigator.languages
    delete ownNavigator.language
    vi.unstubAllGlobals()
  })
}

/**
 * Put the document on a deployment prefix the way `dsh-server-base` does at run
 * time: the page address, the `<base href>` head row, and the `__DSH_BASE__`
 * global. The teardown registered by installAssembledBootEnv undoes all three.
 * @param basePath - deployment prefix, leading and trailing slash included.
 * @param search - query string appended to the page address.
 */
export function installDeploymentBase(basePath = ROOT_BASE_PATH, search = ''): void {
  assertBasePath(basePath)
  history.replaceState(null, '', `${basePath}${search}`)
  // The Host injects this row first in `<head>`, ahead of every asset the shell
  // references, so a relative `<script src>` resolves under the prefix. One
  // document carries one base — the first in tree order is the one the parser
  // honors, so a second call replaces rather than shadows.
  document.head.querySelectorAll('base[data-dsh-base]').forEach((stale) => { stale.remove() })
  const base = document.createElement('base')
  base.setAttribute('href', basePath)
  base.setAttribute('data-dsh-base', '')
  document.head.prepend(base)
  win.__DSH_BASE__ = basePath
}

/**
 * The boot manifest the Host would inject for the assembled graph, without
 * mounting anything.
 * @returns the composed graph in boot order.
 */
function bootGraph(): { rev: string; entries: WebBootEntry[] } {
  return { rev: 'fx', entries: PLUGINS.map(({ bundlePath: _bundlePath, ...plugin }) => plugin) }
}

/**
 * Every URL the boot manifest asks the browser to fetch: the graph rows the
 * module loader resolves and the parser-blocking preloads the Host injects as
 * `<script src>`. A URL that resolves outside the deployment prefix is a
 * request the reverse proxy never routes.
 * @returns the manifest urls followed by the injected preload sources.
 */
export function bootRequestUrls(): readonly string[] {
  const graph = bootGraph()
  const preloads = bootInjections(graph).flatMap(row => row.kind === 'script-src' ? [row.src] : [])
  return [...graph.entries.map(entry => entry.url), ...preloads]
}

/**
 * Mount the assembled application on the fixture transport; the teardown
 * registered by installAssembledBootEnv disposes it.
 * @param search - fixture query string used to select deterministic host behavior.
 * @param basePath - deployment prefix the page is served under.
 */
export function mountAssembledApp(search = '?fixture', basePath = ROOT_BASE_PATH): void {
  installDeploymentBase(basePath, search)
  const sources = bundles()
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
  win.__DSH_BOOT__ = bootGraph()
  const [facadeRow] = bootInjections(win.__DSH_BOOT__)
  if (facadeRow?.kind !== 'script') throw new Error('missing injected ModuleLoader facade row')
  ;(0, eval)(facadeRow.text)
  // Mirror the blocking Host-injected scripts before the Vite entry calls create().
  for (const id of ['@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-runtime']) {
    const plugin = PLUGINS.find(candidate => candidate.id === id)
    if (plugin === undefined) throw new Error(`missing parser-preloaded fixture row ${id}`)
    const code = sources.get(plugin.url)
    if (code === undefined) throw new Error(`missing built bundle ${plugin.url}`)
    ;(0, eval)(code)
  }
  act(() => {
    const entry = new AppWebEntry(root, {
      loadBundle: async (url) => {
        const code = sources.get(url)
        if (code === undefined) throw new Error(`missing built bundle ${url}`)
        ;(0, eval)(code)
      },
    })
    void entry.run()
    unmount = () => entry.dispose()
  })
}

/**
 * Match a CSS-module class by its logical name.
 * Module class names carry a per-build hash in one of two schemes —
 * ui-primitives emits `_<name>_<hash>` (name bounded by underscores),
 * feature bundles emit `<hash>_<name>` (name at the end) — and a longer name
 * containing this one must not match (`line` must not hit `lineNumber`).
 * @param el - element whose class list is inspected.
 * @param name - logical (unhashed) module class name.
 * @returns whether the element carries that module class.
 */
export function hasClass(el: Element, name: string): boolean {
  return [...el.classList].some(cls => cls === name || cls.endsWith(`_${name}`) || cls.startsWith(`_${name}_`) || cls.includes(`_${name}_`))
}

/**
 * Whether this run rewrites its golden instead of comparing against it, set by
 * the snapshot gate's `DSH_SNAPSHOT` mode (`record` re-runs the scenarios from
 * scratch, `refresh` re-derives the expected text from the existing ones).
 */
export const REFRESHING_GOLDEN = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'
