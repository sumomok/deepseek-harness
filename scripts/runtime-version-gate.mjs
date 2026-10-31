/** Execute a runtime executable and reject bundled Undici versions below the patched lines. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gte, valid } from 'semver'

/** Lowest patched Undici release for each bundled major. */
export const UNDICI_MINIMUM_VERSIONS = Object.freeze({
  6: '6.29.1',
  7: '7.30.1',
  8: '8.12.2',
})

/** Electron release the desktop shell pins and executes. */
export const SHELL_ELECTRON_VERSION = '43.8.6'

/** Electron release the other desktop requires at minimum. */
export const DESKTOP_ELECTRON_MINIMUM = '44.10.0'

/** Electron major the other desktop may use. */
export const DESKTOP_ELECTRON_MAJOR = 44

/** Node release the desktop shell stages for Windows. */
export const WINDOWS_HOST_NODE_VERSION = '24.22.1'

/** Official SHA-256 of win-x64/node.exe in the Node 24.22.1 distribution. */
export const WINDOWS_HOST_NODE_SHA256 = 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5'

const PROBE_EXPRESSION = 'JSON.stringify({platform:process.platform,arch:process.arch,'
  + 'electron:process.versions.electron??null,node:process.versions.node,'
  + 'undici:process.versions.undici??null})'

/**
 * Explain why a runtime's Undici version cannot pass the packaging gate.
 * @param {unknown} version - Value of `process.versions.undici`.
 * @returns {string | undefined} Stable reason, or undefined when the version is patched.
 */
export function undiciVersionProblem(version) {
  if (typeof version !== 'string' || version.trim() === '') return 'process.versions.undici is missing'
  const normalized = valid(version.trim())
  if (normalized === null) return `process.versions.undici ${JSON.stringify(version)} is not a semantic version`
  const major = Number(normalized.split('.')[0])
  const minimum = UNDICI_MINIMUM_VERSIONS[major]
  if (minimum === undefined) return `process.versions.undici ${normalized} has an unverified major ${String(major)}`
  if (!gte(normalized, minimum)) return `process.versions.undici ${normalized} is below the patched ${minimum} for major ${String(major)}`
  return undefined
}

/**
 * Hash a file with SHA-256.
 * @param {string} path - File to read.
 * @returns {string} Lowercase hexadecimal digest.
 */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Require a file to match a pinned SHA-256 digest.
 * @param {string} path - File to verify.
 * @param {string} expected - Lowercase hexadecimal digest.
 * @returns {void}
 * @throws When the digest differs.
 */
export function verifyFileSha256(path, expected) {
  const actual = sha256File(path)
  if (actual !== expected) throw new Error(`runtime gate: ${path} has SHA-256 ${actual}, expected ${expected}`)
}

/**
 * Run an executable in Node mode and read its real `process.versions`.
 * @param {string} executable - Node or Electron executable to execute.
 * @param {{ electron?: boolean, env?: NodeJS.ProcessEnv, timeout?: number }} [options] - Electron mode, child environment and timeout.
 * @returns {{ executable: string, platform: string, arch: string, electron: string | undefined, node: string, undici: string | undefined, exitCode: number }} Probe result.
 * @throws When the executable cannot run, exits non-zero, or does not print one probe record.
 */
export function probeRuntimeExecutable(executable, options = {}) {
  const environment = { ...(options.env ?? process.env) }
  if (options.electron === true) environment.ELECTRON_RUN_AS_NODE = '1'
  let stdout
  try {
    stdout = execFileSync(executable, ['-p', PROBE_EXPRESSION], {
      encoding: 'utf8', env: environment, timeout: options.timeout ?? 60_000, windowsHide: true,
    }).trim()
  } catch (error) {
    const status = error !== null && typeof error === 'object' && 'status' in error ? String(error.status) : 'unknown'
    const stderr = error !== null && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim() : ''
    throw new Error(`runtime probe: ${executable} exited ${status}${stderr === '' ? '' : `: ${stderr}`}`, { cause: error })
  }
  let record
  try {
    record = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`runtime probe: ${executable} printed no JSON record: ${stdout.slice(0, 200)}`, { cause: error })
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)
    || typeof record.platform !== 'string' || typeof record.arch !== 'string'
    || typeof record.node !== 'string' || (record.electron !== null && typeof record.electron !== 'string')
    || (record.undici !== null && typeof record.undici !== 'string')) {
    throw new Error(`runtime probe: ${executable} printed an invalid record: ${stdout.slice(0, 200)}`)
  }
  return {
    executable, platform: record.platform, arch: record.arch,
    electron: record.electron ?? undefined, node: record.node, undici: record.undici ?? undefined, exitCode: 0,
  }
}

/**
 * Assert one probe's platform, Electron release and Undici version.
 * @param {ReturnType<typeof probeRuntimeExecutable>} probe - Executed binary record.
 * @param {{ platform?: string, arch?: string, electron?: string | { minimum: string, major?: number }, node?: string }} [expectations] - Required values.
 * @returns {ReturnType<typeof probeRuntimeExecutable>} The accepted probe.
 * @throws When a required value differs or the Undici version is below its patched line.
 */
export function assertRuntimeProbe(probe, expectations = {}) {
  if (expectations.platform !== undefined && probe.platform !== expectations.platform) {
    throw new Error(`runtime gate: ${probe.executable} runs on ${probe.platform}, expected ${expectations.platform}`)
  }
  if (expectations.arch !== undefined && probe.arch !== expectations.arch) {
    throw new Error(`runtime gate: ${probe.executable} runs on ${probe.arch}, expected ${expectations.arch}`)
  }
  if (expectations.node !== undefined && probe.node !== expectations.node) {
    throw new Error(`runtime gate: ${probe.executable} carries Node ${probe.node}, expected ${expectations.node}`)
  }
  if (expectations.electron !== undefined) {
    if (probe.electron === undefined) throw new Error(`runtime gate: ${probe.executable} is not an Electron runtime`)
    if (typeof expectations.electron === 'string') {
      if (probe.electron !== expectations.electron) {
        throw new Error(`runtime gate: ${probe.executable} carries Electron ${probe.electron}, expected ${expectations.electron}`)
      }
    } else {
      const electron = valid(probe.electron)
      if (electron === null) throw new Error(`runtime gate: ${probe.executable} reports invalid Electron ${probe.electron}`)
      if (expectations.electron.major !== undefined && Number(electron.split('.')[0]) !== expectations.electron.major) {
        throw new Error(`runtime gate: ${probe.executable} carries Electron ${electron}, expected major ${String(expectations.electron.major)}`)
      }
      if (!gte(electron, expectations.electron.minimum)) {
        throw new Error(`runtime gate: ${probe.executable} carries Electron ${electron}, below ${expectations.electron.minimum}`)
      }
    }
  }
  const problem = undiciVersionProblem(probe.undici)
  if (problem !== undefined) {
    throw new Error(`runtime gate: ${probe.executable} (${probe.platform}/${probe.arch}, `
      + `Electron ${probe.electron ?? 'none'}, Node ${probe.node}) rejected: ${problem}`)
  }
  return probe
}

/**
 * Render one accepted probe for a packaging log.
 * @param {ReturnType<typeof probeRuntimeExecutable>} probe - Executed binary record.
 * @returns {string} Path, platform, versions and exit code on one line.
 */
export function formatRuntimeProbe(probe) {
  return `executable=${probe.executable} platform=${probe.platform} arch=${probe.arch} `
    + `electron=${probe.electron ?? 'none'} node=${probe.node} undici=${probe.undici ?? 'missing'} exitCode=${String(probe.exitCode)}`
}
