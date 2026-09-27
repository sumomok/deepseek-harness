/**
 * The desktop's browser title in the repository build, and the check that the
 * client artifacts carry it before the desktop-app browser half is bundled.
 *
 * `pnpm run build` passes an inherited `DSH_CLIENT_TITLE` through to every
 * client bundle and the build record, so the package script sets it to the
 * desktop title. `@deepseek-ai/dsh-desktop-app`'s browser half is outside the
 * root client build and reads no build-time value; it is bundled afterwards.
 * @module
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readClientBuildRecord } from '../../../scripts/client-build-environment.ts'

/** Browser title of the desktop application, in every UI language. */
export const DESKTOP_CLIENT_TITLE = '北冥'

/** `pnpm` arguments that bundle the desktop-app browser and Host halves. */
export const DESKTOP_APP_BUNDLE_ARGS = ['--filter', '@deepseek-ai/dsh-desktop-app', 'run', 'bundle'] as const

/**
 * The environment `pnpm run build` runs in for the desktop package.
 * @param environment - caller environment.
 * @returns the caller environment with the desktop title.
 */
export function desktopRepositoryBuildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...environment, DSH_CLIENT_TITLE: DESKTOP_CLIENT_TITLE }
}

/**
 * Require the client artifacts on disk to carry the desktop title: the build
 * record must match the artifacts and name the title, and the web page's
 * initial title must be it.
 * @param root - repository root.
 * @throws when the client artifacts were built without the desktop title.
 */
export function assertDesktopClientTitle(root: string): void {
  const record = readClientBuildRecord(root)
  if (record.environment.DSH_CLIENT_TITLE !== DESKTOP_CLIENT_TITLE) {
    throw new Error(`package: the client build embeds title ${JSON.stringify(record.environment.DSH_CLIENT_TITLE)}; the desktop needs ${JSON.stringify(DESKTOP_CLIENT_TITLE)}. Run without --skip-repo-build.`)
  }
  const title = `<title>${DESKTOP_CLIENT_TITLE}</title>`
  if (!readFileSync(join(root, 'apps', 'web', 'dist', 'index.html'), 'utf8').includes(title)) {
    throw new Error(`package: apps/web/dist/index.html carries no ${title}.`)
  }
}
