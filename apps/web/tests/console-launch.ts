/**
 * How a Web scenario launches the product console: the
 * `dsh-experimental-console-profile` bundle and one generated deployment layer,
 * both enabled in `dsh.profile.bundles` after the shipped Web bundles, with the
 * bundle's permission lock composed above the profile patch — the way a
 * deployment installs the console (see the bundle's README).
 *
 * The console's rows live in the bundle layer, so a scenario that passes only a
 * deployment layer as `extraOverlayPath` composes no sidebar at all. The
 * settings service saves the sidebar's menu into the profile patch, which only
 * works for a row composed below that patch; a `--patch` overlay composes above
 * it.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the Loader resolves the console's rows through are created here rather
 * than by `healProfilesModuleFallback` (the same approach `content-show.e2e.ts`
 * uses for its own experimental rows).
 */

import { copyFile, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { launchWebScaffold, type LaunchOptions, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

/**
 * The customer console's own bundle layer, installed into the scenario's
 * profile the way a deployment installs it (see its README): the sidebar row
 * must sit below the profile patch for the settings service to save its menu.
 */
const CONSOLE_BUNDLE = join(REPO_ROOT, 'packages/experimental/console-profile')
/**
 * The console's lock rows, which a deployment composes above the profile patch
 * either as the home patch or with `--patch`. The scaffold moves an
 * `extraOverlayPath` row's config into a bundle layer (its editable form
 * defaults), so these scenarios compose the lock in one of the two deployed
 * forms: the home patch, or the scaffold's `commandLinePatchPath`, which
 * appends it to the command-line overlays verbatim.
 */
const PERMISSION_LOCK = join(CONSOLE_BUNDLE, 'permission-lock.patch.yml')

/**
 * Every experimental package the console bundle's and the deployment layer's
 * rows need resolvable, as package name and source directory. Most are inserted
 * by name; `library-skills` is instead named by the `bundledSkillDir`
 * expression of the bundle's `skill-filesystem` row, which resolves it from the
 * profile the same way. `@haoran/dsh-auto-compact` is the console bundle's
 * vendored tarball, linked from where the workspace install unpacked it.
 */
export const CONSOLE_ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-content-surface', join(REPO_ROOT, 'packages/experimental/content-surface')],
  ['@deepseek-ai/dsh-experimental-content-column', join(REPO_ROOT, 'packages/experimental/content-column')],
  ['@deepseek-ai/dsh-experimental-content-frame', join(REPO_ROOT, 'packages/experimental/content-frame')],
  ['@deepseek-ai/dsh-experimental-server-sidebar', join(REPO_ROOT, 'packages/experimental/server-sidebar')],
  ['@deepseek-ai/dsh-experimental-library-skills', join(REPO_ROOT, 'packages/experimental/library-skills')],
  ['@deepseek-ai/dsh-experimental-console-mcp', join(REPO_ROOT, 'packages/experimental/console-mcp')],
  ['@deepseek-ai/dsh-experimental-page-refresh', join(REPO_ROOT, 'packages/experimental/page-refresh')],
  ['@haoran/dsh-auto-compact', join(CONSOLE_BUNDLE, 'node_modules/@haoran/dsh-auto-compact')],
] as const

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @param rows - package names and the directories their links point at.
 * @returns the harness home the scaffold should adopt.
 */
export async function harnessHomeWithRowLinks(rows: readonly (readonly [string, string])[] = CONSOLE_ROWS): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-console-'))
  const modules = join(home, 'profiles', 'node_modules')
  for (const [packageName, dir] of rows) {
    const link = join(modules, packageName)
    await mkdir(dirname(link), { recursive: true })
    await symlink(dir, link, 'dir')
  }
  return home
}

/** The replay options {@link launchConsole} passes through to the scaffold. */
export type ConsoleReplayOptions = Pick<
  LaunchOptions, 'replayFixture' | 'replayOverride' | 'replayContextWindow' | 'compareReplaySession' | 'paceMs'
>

/**
 * Launch the scaffold over a profile carrying the console bundle and one
 * deployment layer, both enabled in `dsh.profile.bundles` after the shipped
 * Web bundles, with {@link PERMISSION_LOCK} composed above the profile patch.
 * The deployment layer is a generated package whose one patch is `deployment`,
 * the same form a deployment's own rows take.
 * @param harnessHome - the harness home from {@link harnessHomeWithRowLinks}.
 * @param deployment - the deployment layer's patch file.
 * @param lockForm - `home` copies the lock to the home patch; `command-line`
 *   passes it where the launcher's `--patch` goes and leaves no home patch.
 * @param replay - the scaffold's replay options, for a scenario that calls a model.
 * @returns the launched scaffold.
 */
export async function launchConsole(
  harnessHome: string,
  deployment: string,
  lockForm: 'home' | 'command-line' = 'home',
  replay: ConsoleReplayOptions = {},
): Promise<WebScaffold> {
  const dir = join(harnessHome, 'console-e2e-deployment')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'console-e2e-deployment', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await copyFile(deployment, join(dir, 'cordis.patch.yml'))
  if (lockForm === 'home') await copyFile(PERMISSION_LOCK, join(harnessHome, 'cordis.patch.yml'))
  return await launchWebScaffold({
    ...replay,
    harnessHome,
    profile: { packages: [{ dir: CONSOLE_BUNDLE, enabled: true }, { dir, enabled: true }] },
    ...lockForm === 'command-line' ? { commandLinePatchPath: PERMISSION_LOCK } : {},
  })
}
