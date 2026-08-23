/**
 * What a packaging run must have produced, and what `dist-app` actually holds.
 *
 * `dist-app` accumulates: it is never cleared between runs, so every past
 * version's artifacts sit beside this one's, and a repackage of one version
 * after a fix finds that version's own files already there. Listing the
 * directory therefore says nothing about whether the build that just ran
 * produced anything. Naming the files this version and these platforms owe,
 * and requiring each to be present, non-empty, and written by this run, is
 * what tells a build from a leftover.
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

/** What `dist-app` holds for one expected name. */
export interface ArtifactFile {
  /** Size in bytes. */
  bytes: number
  /** Last-modified time in epoch milliseconds. */
  mtimeMs: number
}

/** Every expected artifact, sorted by what `dist-app` holds for it. */
export interface ArtifactAudit {
  /** Files this run wrote, with content. */
  verified: ArtifactSize[]
  /** Files the build owed and did not produce. */
  missing: string[]
  /** Files that are there at zero bytes, which is a build that wrote a stub or died mid-write. */
  empty: string[]
  /** Files left by an earlier run of the same version, which this run did not rebuild. */
  stale: string[]
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
 *
 * Presence is not enough. A version is repackaged after a fix often enough that
 * the directory usually already holds this version's files from an earlier run,
 * so a platform this run did not build leaves last run's artifact sitting under
 * exactly the name that is expected. Anything older than the run that is
 * checking it was written by something else and is reported, not accepted.
 * @param expected - the names [[expectedArtifacts]] produced.
 * @param files - size and modification time per name, absent for a name the directory does not hold.
 * @param startedAt - epoch milliseconds at which this packaging run began.
 * @returns each expected name in exactly one of the four groups.
 */
export function auditArtifacts(expected: string[], files: ReadonlyMap<string, ArtifactFile>, startedAt: number): ArtifactAudit {
  const audit: ArtifactAudit = { verified: [], missing: [], empty: [], stale: [] }
  for (const name of expected) {
    const file = files.get(name)
    if (file === undefined) audit.missing.push(name)
    else if (file.bytes === 0) audit.empty.push(name)
    else if (file.mtimeMs < startedAt) audit.stale.push(name)
    else audit.verified.push({ name, bytes: file.bytes })
  }
  return audit
}
