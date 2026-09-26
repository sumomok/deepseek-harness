/**
 * Experimental packages excluded from public releases and npm baselines: the
 * product console line's own packages, which ship only inside its deployments.
 */
export const PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES: readonly string[] = [
  'packages/experimental/auth-gate',
  'packages/experimental/biz-backend',
  'packages/experimental/component-kit',
  'packages/experimental/component-surface',
  'packages/experimental/console-mcp',
  'packages/experimental/console-profile',
  'packages/experimental/content-column',
  'packages/experimental/content-frame',
  'packages/experimental/content-surface',
  'packages/experimental/library-skills',
  'packages/experimental/server-base',
  'packages/experimental/server-layout',
  'packages/experimental/server-sidebar',
  'packages/experimental/skill-pack',
  'packages/experimental/skill-pack-components',
  'packages/experimental/system-map',
  'packages/experimental/vue-ui-poc',
  'packages/experimental/vue2-echarts-poc',
  'packages/experimental/vue2-echarts-tool-poc',
]

/**
 * Whether an experimental package publishes under the default-public policy.
 * @param directory - repository-relative package directory.
 * @param privateDirectories - experimental directories excluded from publication.
 * @returns Whether the package publishes with the dsh family.
 */
export function isPublicExperimentalPackageDirectory(
  directory: string,
  privateDirectories: readonly string[] = PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
): boolean {
  return /^packages\/experimental\/[^/]+$/.test(directory)
    && !privateDirectories.includes(directory)
}
