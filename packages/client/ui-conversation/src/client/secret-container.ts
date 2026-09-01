/**
 * Name/path heuristic for the add-time secret-container confirmation: files
 * that commonly hold passwords or keys, matched by filename and (desktop
 * only) source path — zero content reading, so nothing here may read or
 * report a file's bytes. The base list is a fixed security heuristic and is
 * never reachable for removal from outside this module; a deployment's
 * `secretContainerExtraPatterns` config can only ever ADD filename
 * substrings on top of it (see {@link matchSecretContainerFiles}).
 */

/** Filenames matched exactly (case-insensitive). */
const BASE_NAME_EXACT = ['.netrc', '.npmrc', '.pypirc']

/** Filename prefixes matched case-insensitively (e.g. `credentials.json`, `secrets.yaml`). */
const BASE_NAME_PREFIXES = ['credentials', 'secrets.']

/** Filename suffixes matched case-insensitively. */
const BASE_NAME_SUFFIXES = ['.pem', '.key', '.keychain', '.p12', '.pfx']

/** SSH private-key base names; the `.pub` counterpart is the public key and is excluded. */
const BASE_KEY_NAMES = ['id_rsa', 'id_ed25519', 'id_ecdsa']

/**
 * Path segments matched only when a source path is available (desktop; the
 * browser File API carries no path, so these never fire on web).
 */
const BASE_PATH_SEGMENTS = ['/.ssh/', '/.aws/', '/.gnupg/', '/.kube/', '/.docker/']

/** Whether a lowercased filename matches the fixed base heuristic. */
function matchesBaseName(lowerName: string): boolean {
  if (lowerName === '.env' || lowerName.startsWith('.env.')) return true
  if (BASE_NAME_EXACT.includes(lowerName)) return true
  if (BASE_NAME_PREFIXES.some(prefix => lowerName.startsWith(prefix))) return true
  if (BASE_NAME_SUFFIXES.some(suffix => lowerName.endsWith(suffix))) return true
  return BASE_KEY_NAMES.some(base => lowerName === base
    || (lowerName.startsWith(`${base}.`) && !lowerName.endsWith('.pub')))
}

/** Whether a source path (when one is available) crosses a fixed secret-container directory. */
function matchesBasePath(path: string | undefined): boolean {
  if (path === undefined || path === '') return false
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  return BASE_PATH_SEGMENTS.some(segment => normalized.includes(segment))
}

/** One file candidate: display name, plus the source path when the platform exposes one. */
export interface SecretContainerCandidate {
  readonly name: string
  readonly path?: string | undefined
}

/**
 * Read the desktop-only source path off a browser `File`, when the runtime
 * exposes one (an Electron renderer extension; standard web `File` objects
 * carry none). Never reads file content.
 * @param file - browser file object.
 * @returns the candidate name/path pair for {@link matchSecretContainerFiles}.
 */
export function secretContainerCandidate(file: File): SecretContainerCandidate {
  const path = (file as File & { readonly path?: unknown }).path
  return { name: file.name, ...(typeof path === 'string' && path !== '' ? { path } : {}) }
}

/**
 * Match candidate files against the fixed secret-container name/path
 * heuristic plus any deployment-appended filename substrings. Name/path
 * only: no file content is read, and no caller may present a match as
 * content having been read.
 * @param files - candidate name (and, on desktop, source path) pairs, in
 * their original order.
 * @param extraPatterns - deployment-appended lowercase substrings checked
 * against the filename only; always additive to the fixed base heuristic —
 * this function has no way to remove or override a base match.
 * @returns the subset of `files` (input order preserved) whose name or path
 * matches.
 */
export function matchSecretContainerFiles<T extends SecretContainerCandidate>(
  files: readonly T[],
  extraPatterns: readonly string[] = [],
): readonly T[] {
  return files.filter((file) => {
    const lowerName = file.name.toLowerCase()
    if (matchesBaseName(lowerName)) return true
    if (matchesBasePath(file.path)) return true
    return extraPatterns.some(pattern => pattern !== '' && lowerName.includes(pattern.toLowerCase()))
  })
}
