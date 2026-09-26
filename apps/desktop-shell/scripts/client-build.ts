/**
 * The desktop's browser title in the repository build, and the desktop-app
 * browser half built from the same client values.
 *
 * `pnpm run build` passes an inherited `DSH_CLIENT_TITLE` through to every
 * client bundle and the build record, so the package script sets it to the
 * desktop title. `@deepseek-ai/dsh-desktop-app`'s browser half is outside the
 * root client build; it is bundled afterwards with the values the build record
 * names, so its sidebar version line is the version the rest of the client
 * embeds.
 * @module
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  clientBuildProcessEnvironment,
  readClientBuildRecord,
} from '../../../scripts/client-build-environment.ts'

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
 * Require the client artifacts on disk to carry the desktop title, and return
 * the environment the desktop-app bundle runs in: the build record must match
 * the artifacts and name the title, and the web page's initial title must be it.
 * @param root - repository root.
 * @param environment - caller environment.
 * @returns the caller environment with exactly the recorded public client values.
 * @throws when the client artifacts were built without the desktop title.
 */
export function desktopAppBundleEnvironment(root: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const record = readClientBuildRecord(root)
  if (record.environment.DSH_CLIENT_TITLE !== DESKTOP_CLIENT_TITLE) {
    throw new Error(`package: the client build embeds title ${JSON.stringify(record.environment.DSH_CLIENT_TITLE)}; the desktop needs ${JSON.stringify(DESKTOP_CLIENT_TITLE)}. Run without --skip-repo-build.`)
  }
  const title = `<title>${DESKTOP_CLIENT_TITLE}</title>`
  if (!readFileSync(join(root, 'apps', 'web', 'dist', 'index.html'), 'utf8').includes(title)) {
    throw new Error(`package: apps/web/dist/index.html carries no ${title}.`)
  }
  return clientBuildProcessEnvironment(environment, record.environment)
}
