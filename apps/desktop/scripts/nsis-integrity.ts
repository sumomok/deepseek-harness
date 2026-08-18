/**
 * The NSIS startup integrity check, recomputed outside NSIS. Both the build
 * (scripts/package.ts) and the release upload (scripts/publish-update.ts) run
 * it: the build catches an installer its own post-processing corrupted, and
 * the upload refuses to publish bytes that would fail on a user's machine.
 * @module @deepseek-ai/dsh-desktop/scripts/nsis-integrity
 */

import { readFile } from 'node:fs/promises'
import { crc32 } from 'node:zlib'

/** Marker that opens the NSIS firstHeader record. */
const FIRST_HEADER_SIGNATURE = Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex')

/** Offset of the archive-size field inside the firstHeader record. */
const ARCHIVE_SIZE_OFFSET = 20

/** Start of the checked window: the first 512 bytes are outside it. */
const CHECK_WINDOW_START = 0x200

/**
 * Verify one built installer against the CRC its own startup check computes:
 * CRC32 over `[0x200, archiveEnd - 4)` must equal the trailing dword the
 * firstHeader's archive-size field locates. The first 512 bytes and anything
 * appended after the archive stay outside the window, which is what keeps real
 * Authenticode signing legal. A mismatch is exactly the "Installer integrity
 * check has failed" dialog on Windows.
 * @param path - the NSIS installer to verify.
 * @throws when the file carries no firstHeader or its CRC does not match.
 */
export async function verifyNsisIntegrity(path: string): Promise<void> {
  const data = await readFile(path)
  const sigAt = data.indexOf(FIRST_HEADER_SIGNATURE)
  if (sigAt < 4) throw new Error(`nsis: ${path} has no NSIS firstHeader signature.`)
  const archiveEnd = sigAt - 4 + data.readUInt32LE(sigAt + ARCHIVE_SIZE_OFFSET)
  const stored = data.readUInt32LE(archiveEnd - 4)
  const computed = crc32(data.subarray(CHECK_WINDOW_START, archiveEnd - 4)) >>> 0
  if (stored !== computed) {
    throw new Error(`nsis: ${path} fails the NSIS integrity CRC (stored ${stored.toString(16)}, computed ${computed.toString(16)}) — it would show "Installer integrity check has failed" on Windows.`)
  }
  console.log(`nsis: integrity CRC verified for ${path}`)
}
