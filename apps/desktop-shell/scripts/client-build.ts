/**
 * The repository build the desktop package runs, with the desktop's own public
 * client values.
 *
 * `pnpm run build` (scripts/build.ts) embeds the repository's `package.json`
 * version as `DSH_CLIENT_VERSION` and replaces any inherited value, so the
 * desktop runs the same steps itself through the same exported helpers and
 * puts two values of its own into the client environment: `DSH_CLIENT_TITLE`,
 * the browser title in every language, and `DSH_CLIENT_VERSION`, this
 * application's release version, which Settings → General's current-version row
 * and the sidebar brand occupant render. The same environment then bundles
 * `@deepseek-ai/dsh-desktop-app`, whose browser half is outside the root
 * client build, and the build record is written from it.
 * @module
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  CLIENT_BUILD_RECORD_PATH,
  clientBuildProcessEnvironment,
  readClientBuildRecord,
  repositoryClientBuildEnvironment,
  writeClientBuildRecord,
  type ClientBuildEnvironment,
} from '../../../scripts/client-build-environment.ts'

/** Browser title of the desktop application, in every UI language. */
export const DESKTOP_CLIENT_TITLE = '北冥'

/** The `pnpm run` scripts scripts/build.ts runs, in its order. */
export const REPOSITORY_BUILD_SCRIPTS = ['build:native-system', 'build:lib', 'build:web'] as const

/** Package whose browser half names the product in the sidebar. */
export const DESKTOP_APP_PACKAGE = '@deepseek-ai/dsh-desktop-app'

/** One subprocess step, run with the environment given. */
export type BuildStep = (label: string, command: string, args: string[], environment: NodeJS.ProcessEnv) => Promise<void>

/**
 * Read the desktop application's release version.
 * @param shellDir - `apps/desktop-shell`, whose package.json carries the version.
 * @returns the version string, such as `0.1.0-rc.34`.
 */
export function desktopVersion(shellDir: string): string {
  const { version } = JSON.parse(readFileSync(join(shellDir, 'package.json'), 'utf8')) as { version: unknown }
  if (typeof version !== 'string' || version === '') throw new Error(`package: ${shellDir}/package.json has no version.`)
  return version
}

/**
 * Resolve the public client values the desktop build embeds.
 * @param root - repository root supplying the commit and dirty-tree metadata.
 * @param environment - caller environment.
 * @param version - the desktop release version.
 * @returns the repository's own values with the desktop title and version in place.
 */
export function desktopClientBuildEnvironment(
  root: string,
  environment: NodeJS.ProcessEnv,
  version: string,
): ClientBuildEnvironment {
  return {
    ...repositoryClientBuildEnvironment(root, environment),
    DSH_CLIENT_TITLE: DESKTOP_CLIENT_TITLE,
    DSH_CLIENT_VERSION: version,
  }
}

/**
 * Run the repository build and the desktop-app bundle with the desktop's public
 * client values, then write the client build record.
 * @param root - repository root.
 * @param environment - caller environment.
 * @param version - the desktop release version.
 * @param step - runs one subprocess; non-zero exit must reject.
 * @returns the public client values the build embedded.
 */
export async function runDesktopRepositoryBuild(
  root: string,
  environment: NodeJS.ProcessEnv,
  version: string,
  step: BuildStep,
): Promise<ClientBuildEnvironment> {
  const client = desktopClientBuildEnvironment(root, environment, version)
  const child = clientBuildProcessEnvironment(environment, client)
  rmSync(resolve(root, CLIENT_BUILD_RECORD_PATH), { force: true })
  for (const script of REPOSITORY_BUILD_SCRIPTS) await step(`repo build ${script}`, 'pnpm', ['run', script], child)
  await step('desktop-app bundle', 'pnpm', ['--filter', DESKTOP_APP_PACKAGE, 'run', 'bundle'], child)
  writeClientBuildRecord(root, client)
  return client
}

/**
 * Prove the client artifacts on disk carry the desktop title and version: the
 * build record matches the artifacts and names both values, the web page's
 * initial title is the desktop title, and Settings → General and the sidebar
 * brand bundles embed the version.
 * @param root - repository root.
 * @param version - the desktop release version.
 * @throws when any artifact was built without the desktop values.
 */
export function verifyDesktopClientBuild(root: string, version: string): void {
  const { environment } = readClientBuildRecord(root)
  if (environment.DSH_CLIENT_TITLE !== DESKTOP_CLIENT_TITLE || environment.DSH_CLIENT_VERSION !== version) {
    throw new Error(`package: the client build embeds title ${JSON.stringify(environment.DSH_CLIENT_TITLE)} and version ${JSON.stringify(environment.DSH_CLIENT_VERSION)}; the desktop needs ${JSON.stringify(DESKTOP_CLIENT_TITLE)} and ${JSON.stringify(version)}. Run without --skip-repo-build.`)
  }
  const title = `<title>${DESKTOP_CLIENT_TITLE}</title>`
  if (!readFileSync(join(root, 'apps', 'web', 'dist', 'index.html'), 'utf8').includes(title)) {
    throw new Error(`package: apps/web/dist/index.html carries no ${title}.`)
  }
  for (const bundle of ['packages/client/ui-settings-general/lib/client.js', 'apps/desktop-app/lib/client.js']) {
    const path = join(root, bundle)
    if (!existsSync(path) || !readFileSync(path, 'utf8').includes(JSON.stringify(version))) {
      throw new Error(`package: ${bundle} does not embed the desktop version ${version}.`)
    }
  }
}
