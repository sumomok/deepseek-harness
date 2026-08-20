/**
 * How much of a new installer an existing client would actually download.
 *
 * electron-updater's differential downloader compares the two blockmaps and
 * fetches only the blocks whose checksum it does not already hold. This does
 * the same arithmetic, so a packaging change that quietly destroys the saving
 * shows up as a number rather than as a surprise on someone's connection.
 *
 * The saving is not incidental: app-builder-lib builds the payload archive
 * non-solid with a 1 MB dictionary precisely so that one changed file
 * invalidates about a dictionary's worth of blocks. Anything that makes bytes
 * shift — sealing a frequently-changing tree into one archive, for instance —
 * shifts every block after the change and turns a 1% update into a full one.
 *
 * Usage: node diff-download.mjs <old.exe.blockmap> <new.exe.blockmap>
 */

import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const read = (path) => JSON.parse(gunzipSync(readFileSync(path)).toString())

const [oldPath, newPath] = process.argv.slice(2)
if (!oldPath || !newPath) {
  console.error('usage: diff-download.mjs <old.exe.blockmap> <new.exe.blockmap>')
  process.exit(2)
}

const before = read(oldPath)
const after = read(newPath)

// A block is identified by its checksum alone, which is what lets the
// downloader reuse a block that moved to a different offset.
const held = new Set()
for (const file of before.files) for (const checksum of file.checksums) held.add(checksum)

let total = 0
let missing = 0
let missingBlocks = 0
let reusedBlocks = 0
for (const file of after.files) {
  for (let i = 0; i < file.checksums.length; i++) {
    const size = file.sizes[i]
    total += size
    if (held.has(file.checksums[i])) reusedBlocks += 1
    else { missing += size; missingBlocks += 1 }
  }
}

const kb = (n) => `${(n / 1024).toFixed(2)} KB`
console.log(`old blockmap: ${before.files.reduce((n, f) => n + f.checksums.length, 0)} blocks`)
console.log(`new blockmap: ${reusedBlocks + missingBlocks} blocks, ${missingBlocks} changed`)
console.log(`Full: ${kb(total)}, To download: ${kb(missing)} (${Math.round((missing / total) * 100)}%)`)
