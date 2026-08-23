/**
 * What a packaging run must have produced, and what `dist-app` actually holds.
 *
 * `dist-app` accumulates: it is never cleared between runs, so every past
 * version's artifacts sit beside this one's. Listing the directory therefore
 * says nothing about whether the build that just ran produced anything —
 * a platform that never built looks exactly like a platform whose files are
 * older. Naming the files this version and these platforms owe, and then
 * checking each one, is what tells the two apart.
 *
 * The names are electron-builder's defaults for the targets
 * `apps/desktop/electron-builder.yml` declares — no `artifactName` overrides
 * it — so they follow from `productName` and each target's single arch.
 * `apps/desktop/tests/artifact-names.spec.ts` reads that config and pins both
 * against it.
 * @module
 */

/** `productName` in electron-builder.yml, which every default artifact name starts from. */
const PRODUCT_NAME = 'DSH Desktop'

/** The single arch the mac targets declare; electron-builder writes it into their names because it is not x64. */
const MAC_ARCH = 'arm64'

/** Suffix electron-builder gives the block map beside each artifact. */
const BLOCKMAP_SUFFIX = '.blockmap'

/** The platforms one packaging run was asked to build. */
export interface PlatformSelection {
  /** The macOS zip and dmg. */
  mac: boolean
  /** The Windows NSIS installer. */
  win: boolean
}

/** One expected artifact and what the filesystem holds for it. */
export interface ArtifactSize {
  /** The file name inside `dist-app`. */
  name: string
  /** Its size in bytes. */
  bytes: number
}

/** Every expected artifact, sorted by what `dist-app` holds for it. */
export interface ArtifactAudit {
  /** Files that are there with content. */
  verified: ArtifactSize[]
  /** Files the build owed and did not produce. */
  missing: string[]
  /** Files that are there at zero bytes, which is a build that wrote a stub or died mid-write. */
  empty: string[]
}

/**
 * The files a packaging run of one version owes for the platforms it built.
 *
 * Each artifact is listed with its `.blockmap`, because the blockmap is what
 * lets a client download only the changed chunks of the next build and a
 * publish refuses to ship an artifact without one.
 * @param version - the version apps/desktop/package.json declares.
 * @param platforms - the platforms this run built.
 * @returns every file name the run must have left in `dist-app`.
 */
export function expectedArtifacts(version: string, platforms: PlatformSelection): string[] {
  const artifacts: string[] = []
  if (platforms.mac) {
    artifacts.push(`${PRODUCT_NAME}-${version}-${MAC_ARCH}-mac.zip`, `${PRODUCT_NAME}-${version}-${MAC_ARCH}.dmg`)
  }
  if (platforms.win) artifacts.push(`${PRODUCT_NAME} Setup ${version}.exe`)
  return artifacts.flatMap(name => [name, `${name}${BLOCKMAP_SUFFIX}`])
}

/**
 * Sort the expected files by what the build directory holds for each.
 * @param expected - the names [[expectedArtifacts]] produced.
 * @param sizes - byte size per name, absent for a name the directory does not hold.
 * @returns each expected name in exactly one of the three groups.
 */
export function auditArtifacts(expected: string[], sizes: ReadonlyMap<string, number>): ArtifactAudit {
  const audit: ArtifactAudit = { verified: [], missing: [], empty: [] }
  for (const name of expected) {
    const bytes = sizes.get(name)
    if (bytes === undefined) audit.missing.push(name)
    else if (bytes === 0) audit.empty.push(name)
    else audit.verified.push({ name, bytes })
  }
  return audit
}
