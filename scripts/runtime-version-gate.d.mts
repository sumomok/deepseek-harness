/** Runtime executable probe and bundled Undici packaging gate. */

/** Lowest patched Undici release for each bundled major. */
export const UNDICI_MINIMUM_VERSIONS: Readonly<Record<6 | 7 | 8, string>>

/** Electron release the desktop shell pins and executes. */
export const SHELL_ELECTRON_VERSION: '43.8.6'

/** Electron release the other desktop requires at minimum. */
export const DESKTOP_ELECTRON_MINIMUM: '44.10.0'

/** Electron major the other desktop may use. */
export const DESKTOP_ELECTRON_MAJOR: 44

/** Node release the desktop shell stages for Windows. */
export const WINDOWS_HOST_NODE_VERSION: '24.22.1'

/** Official SHA-256 of win-x64/node.exe in the Node 24.22.1 distribution. */
export const WINDOWS_HOST_NODE_SHA256: string

/** Values read from one executed runtime. */
export interface RuntimeProbe {
  /** Executed path. */
  readonly executable: string
  /** Runtime's `process.platform`. */
  readonly platform: string
  /** Runtime's `process.arch`. */
  readonly arch: string
  /** Electron version, absent under plain Node. */
  readonly electron: string | undefined
  /** Node version. */
  readonly node: string
  /** Bundled Undici version, absent when the runtime exposes none. */
  readonly undici: string | undefined
  /** Process exit code; zero for a successful probe. */
  readonly exitCode: number
}

/** Requirements asserted against one runtime probe. */
export interface RuntimeProbeExpectations {
  /** Required `process.platform`. */
  readonly platform?: string
  /** Required `process.arch`. */
  readonly arch?: string
  /** Exact Electron version, or a minimum and optional major. */
  readonly electron?: string | { readonly minimum: string; readonly major?: number }
  /** Exact Node version. */
  readonly node?: string
}

/**
 * Explain why a runtime's Undici version cannot pass the packaging gate.
 * @param version - Value of `process.versions.undici`.
 * @returns Stable reason, or undefined when the version is patched.
 */
export function undiciVersionProblem(version: unknown): string | undefined

/**
 * Hash a file with SHA-256.
 * @param path - File to read.
 * @returns Lowercase hexadecimal digest.
 */
export function sha256File(path: string): string

/**
 * Require a file to match a pinned SHA-256 digest.
 * @param path - File to verify.
 * @param expected - Lowercase hexadecimal digest.
 * @throws When the digest differs.
 */
export function verifyFileSha256(path: string, expected: string): void

/**
 * Run an executable in Node mode and read its real `process.versions`.
 * @param executable - Node or Electron executable to execute.
 * @param options - Electron mode, child environment and timeout.
 * @returns Probe result.
 * @throws When the executable cannot run, exits non-zero, or does not print one probe record.
 */
export function probeRuntimeExecutable(
  executable: string,
  options?: { readonly electron?: boolean; readonly env?: NodeJS.ProcessEnv; readonly timeout?: number },
): RuntimeProbe

/**
 * Assert one probe's platform, Electron release and Undici version.
 * @param probe - Executed binary record.
 * @param expectations - Required values.
 * @returns The accepted probe.
 * @throws When a required value differs or the Undici version is below its patched line.
 */
export function assertRuntimeProbe(
  probe: RuntimeProbe,
  expectations?: RuntimeProbeExpectations,
): RuntimeProbe

/**
 * Render one accepted probe for a packaging log.
 * @param probe - Executed binary record.
 * @returns Path, platform, versions and exit code on one line.
 */
export function formatRuntimeProbe(probe: RuntimeProbe): string
