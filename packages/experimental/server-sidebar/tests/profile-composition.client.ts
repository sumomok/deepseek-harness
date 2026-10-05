/**
 * A profile booted through the real app boot, Loader, config editor, and
 * webserver, with this package's row at entry id `server-sidebar`: the
 * composition the server-menu route persists through. `settings` selects the
 * settings row — the real service by default, or a stand-in plugin for a case
 * about a service failure the real one cannot produce. `sidebar` adds fields
 * to this package's row, and `members` composes the test-only member directory
 * after it.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import { Logger, type Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import Settings from '@deepseek-ai/dsh-settings'
import * as ServerSidebar from '../src/index.ts'
import * as MembersFixture from './fixtures/console-members.client.ts'

/** A booted profile and the handles a case needs to restart or inspect it. */
export interface ProfileComposition {
  /** The booted root context. */
  ctx: Context
  /** The harness home: the removed `settings.yaml` and home patches live here. */
  home: string
  /** The active profile, whose patch the settings service writes. */
  profile: ProfileContext
  /** Boot the same profile again after the current root is disposed. */
  start: () => Promise<Context>
  /** Every line the booted roots logged, in order. */
  logs: LogLine[]
}

/** One log line, as the root exporter received it. */
export interface LogLine {
  name: string
  type: string
  text: string
}

/**
 * Boot one profile carrying the server-sidebar row.
 * @param options - `settings` replaces the settings row's plugin; `beforeStart`
 * writes files into the home before the first boot; `sidebar` adds fields to
 * the server-sidebar row's config; `members` composes the test-only member
 * directory with these tables after that row.
 * @returns the booted composition.
 */
export async function bootProfile(options: {
  settings?: object
  beforeStart?: (home: string) => void
  sidebar?: Record<string, unknown>
  members?: MembersFixture.Config
} = {}): Promise<ProfileComposition> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-server-sidebar-profile-')))
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'webserver', name: 'cordis:webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'server-sidebar', name: 'cordis:sidebar', config: { displayNameClaim: 'login_uname', ...options.sidebar } },
    ...options.members === undefined ? [] : [{ id: 'console-members', name: 'cordis:members', config: options.members }],
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  options.beforeStart?.(home)
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const logs: LogLine[] = []
  const start = async (): Promise<Context> => {
    const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
      root.logger.exporter({
        export: (message) => { logs.push({ name: message.name, type: message.type, text: Logger.format({ export() {} }, message) }) },
      })
      root.provide('profileContext', profile)
      Object.assign(root.loader.builtins, {
        editor: ConfigEditor, settings: options.settings ?? Settings, webserver: HttpServer, sidebar: ServerSidebar,
        members: MembersFixture,
      })
    })
    onTestFinished(async () => { await ctx.fiber.dispose() })
    // Loader settlement does not reject a failed plugin; each fiber's own await rethrows it.
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    return ctx
  }
  return { ctx: await start(), home, profile, start, logs }
}
