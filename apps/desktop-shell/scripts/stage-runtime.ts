/** Stage the Node runtime one packaged platform boots the server with. */

import { createWriteStream, existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import {
  WINDOWS_HOST_NODE_SHA256, WINDOWS_HOST_NODE_VERSION,
  assertRuntimeProbe, formatRuntimeProbe, probeRuntimeExecutable, verifyFileSha256,
} from '../../../scripts/runtime-version-gate.mjs'

/** Windows Host runtime release whose bundled Undici passes the packaging gate. */
const NODE_VERSION = `v${WINDOWS_HOST_NODE_VERSION}`

/** Official Windows x64 executable for [[NODE_VERSION]]. */
const NODE_WIN_X64_URL = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`

/** Where one platform's staged runtime and the shared download cache live. */
export interface StageRuntimeOptions {
  /** Platform whose runtime is staged. */
  readonly platform: 'darwin' | 'win'
  /** Directory receiving `node` or `node.exe`. */
  readonly runtimeDirectory: string
  /** Download cache for the Windows executable. */
  readonly cacheDirectory: string
  /** Fetcher for the Windows executable; tests replace the network. */
  readonly fetchRuntime?: typeof fetch
}

/**
 * Stage the bundled Node runtime for one platform.
 *
 * The macOS runtime is the build machine's own Node, probed after copying so
 * the shipped bytes rather than the build host manifest prove the version. The
 * Windows runtime is pinned to [[WINDOWS_HOST_NODE_VERSION]]: every cache hit
 * is verified against its official digest, a rejected cache entry is discarded
 * and downloaded again, and the staged executable is probed only on a native
 * Windows host because a cross-built package cannot execute it.
 * @param options - Target platform and the directories receiving the runtime and cached download.
 * @returns Resolves after the runtime executable is staged and accepted.
 */
export async function stageRuntime(options: StageRuntimeOptions): Promise<void> {
  const { platform, runtimeDirectory, cacheDirectory, fetchRuntime = fetch } = options
  await rm(runtimeDirectory, { recursive: true, force: true })
  await mkdir(runtimeDirectory, { recursive: true })
  if (platform === 'darwin') {
    // The build machine's own Node is the tested engines match.
    if (!process.version.startsWith('v24.')) {
      throw new Error(`package: build Node is ${process.version}; the bundled runtime must be the tested v24 line.`)
    }
    await copyFile(process.execPath, join(runtimeDirectory, 'node'))
    await chmod(join(runtimeDirectory, 'node'), 0o755)
    // The copied binary, not the build host's manifest, is what ships and boots the server.
    const probe = probeRuntimeExecutable(join(runtimeDirectory, 'node'))
    assertRuntimeProbe(probe, { platform: 'darwin', arch: process.arch, node: process.versions.node })
    console.log(`package: staged macOS Node runtime ${formatRuntimeProbe(probe)}`)
    return
  }
  const cached = join(cacheDirectory, `node-${NODE_VERSION}-win-x64.exe`)
  if (existsSync(cached)) {
    try {
      verifyFileSha256(cached, WINDOWS_HOST_NODE_SHA256)
    } catch (error) {
      console.log(`package: discarding cached Node runtime: ${(error as Error).message}`)
      await rm(cached, { force: true })
    }
  }
  if (!existsSync(cached)) {
    console.log(`package: downloading ${NODE_WIN_X64_URL}`)
    await mkdir(cacheDirectory, { recursive: true })
    const response = await fetchRuntime(NODE_WIN_X64_URL)
    if (!response.ok || response.body === null) {
      throw new Error(`package: Node runtime download failed: ${String(response.status)} ${response.statusText}`)
    }
    // `fetch` types its body with the DOM lib's ReadableStream and
    // `Readable.fromWeb` takes node:stream/web's; the two declare the same
    // runtime object and neither is assignable to the other, so no narrowing
    // reaches this.
    const body = response.body as NodeReadableStream<Uint8Array>
    await pipeline(Readable.fromWeb(body), createWriteStream(`${cached}.part`))
    verifyFileSha256(`${cached}.part`, WINDOWS_HOST_NODE_SHA256)
    await copyFile(`${cached}.part`, cached)
    await rm(`${cached}.part`)
  }
  await copyFile(cached, join(runtimeDirectory, 'node.exe'))
  // A cross-built Windows package carries an executable this host cannot run;
  // the official digest still proves which bytes it ships.
  if (process.platform !== 'win32') {
    console.log(`package: Windows Node ${WINDOWS_HOST_NODE_VERSION} probe deferred to a native Windows host; official SHA-256 verified.`)
    return
  }
  const probe = probeRuntimeExecutable(join(runtimeDirectory, 'node.exe'))
  assertRuntimeProbe(probe, { platform: 'win32', arch: 'x64', node: WINDOWS_HOST_NODE_VERSION })
  console.log(`package: staged Windows Node runtime ${formatRuntimeProbe(probe)}`)
}
