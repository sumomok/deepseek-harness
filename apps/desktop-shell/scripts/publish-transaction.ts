/**
 * Server-side ownership and recovery for a static desktop feed. One atomic
 * directory lock covers both protocols and all platforms. A lost mutation
 * response retains the lock for operator reconciliation; locks never expire
 * automatically while an SSH command might still be running.
 * @module
 */
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'

/** Failures retain whether the remote operation's effect can be established. */
export class PublishTransactionError extends Error {
  /** Stable handling code. */
  readonly code: 'PUBLISH_LOCKED' | 'PUBLISH_UNKNOWN' | 'PUBLISH_REFUSED'
  /** Remote operation or path requiring attention. */
  readonly subject: string

  /**
   * @param code - The handling decision.
   * @param subject - The affected operation.
   * @param detail - The impact and safe next action.
   * @param cause - The original failure, when one occurred.
   */
  constructor(code: PublishTransactionError['code'], subject: string, detail: string, cause?: unknown) {
    super(`${subject}: ${detail}`, { cause })
    this.name = 'PublishTransactionError'
    this.code = code
    this.subject = subject
  }
}

/** A remote path is absent or has a verified digest; failed reads reject. */
export type RemoteFileState = { readonly kind: 'absent' } | {
  readonly kind: 'present'
  readonly sha512: string
  readonly size: number
}

/** SSH is the only command transport; callers must not retry mutations. */
export interface PublishTransport {
  /** Execute one command and await the transport's completion. */
  execute(script: string): Promise<string>
}

/**
 * Quote one argument for the remote POSIX shell.
 * @param value - Literal argument text.
 * @returns A single quoted shell argument.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Owns one attempt's lock, staging names, immutable writes and recovery copies. */
export class PublishTransaction {
  /** Unique staging and recovery namespace, never shared by another attempt. */
  readonly attempt = randomUUID()
  readonly root: string
  readonly lockPath: string
  readonly recoveryPath: string
  private readonly transport: PublishTransport
  private owned = false
  private uncertain = false
  private readonly snapshots = new Map<string, RemoteFileState>()

  /**
   * @param root - Absolute server document root shared by both protocols.
   * @param transport - One-command transport with no mutation retries.
   */
  constructor(root: string, transport: PublishTransport) {
    if (!posix.isAbsolute(root) || posix.normalize(root) !== root || root === '/') {
      throw new PublishTransactionError('PUBLISH_REFUSED', root, 'requires a normalized, non-root absolute feed directory')
    }
    this.root = root
    this.transport = transport
    this.lockPath = `${root}/.publish-lock`
    this.recoveryPath = `${root}/.recovery/${this.attempt}`
  }

  /** Whether an ambiguous mutation requires manual lock reconciliation. */
  get requiresReconciliation(): boolean { return this.uncertain }

  private checked(path: string): string {
    if (posix.normalize(path) !== path || !path.startsWith(`${this.root}/`)) {
      throw new PublishTransactionError('PUBLISH_REFUSED', path, `must stay inside ${this.root}`)
    }
    return shellQuote(path)
  }

  /** Verify existing ancestors physically resolve to the intended absolute path. */
  private pathGuard(path: string): string {
    if (path !== this.root) this.checked(path)
    return [
      `parent=${shellQuote(posix.dirname(path))};`,
      'while [ ! -e "$parent" ] && [ ! -L "$parent" ]; do parent=${parent%/*}; [ -n "$parent" ] || parent=/; done;',
      'test "$(cd "$parent" && pwd -P)" = "$parent" || exit 74;',
      `test ! -L ${shellQuote(path)} || exit 74;`,
    ].join('\n')
  }

  private ownerCheck(): string {
    if (!this.owned) throw new PublishTransactionError('PUBLISH_REFUSED', this.lockPath, 'this attempt does not own the publish lock')
    const owner = `${this.lockPath}/${this.attempt}`
    return `${this.pathGuard(owner)}\ntest -d ${this.checked(owner)} || exit 73;`
  }

  /**
   * Acquire exclusive ownership before reading any publication state. Busy or
   * unreadable locks stop the attempt; an abandoned lock requires manual review.
   * @returns Resolves only when this attempt acquired the lock.
   */
  async acquire(): Promise<void> {
    let answer: string
    try {
      answer = await this.transport.execute(
        `${this.pathGuard(this.root)}\nmkdir -p ${shellQuote(this.root)} && if mkdir ${this.checked(this.lockPath)} 2>/dev/null; then mkdir ${this.checked(`${this.lockPath}/${this.attempt}`)} && printf 'acquired\\n'; else printf 'busy\\n'; fi`,
      )
    } catch (cause) {
      this.uncertain = true
      throw new PublishTransactionError('PUBLISH_UNKNOWN', this.lockPath, `lock acquisition is unknown; inspect owner ${this.attempt} before retrying`, cause)
    }
    if (answer.trim() !== 'acquired') {
      throw new PublishTransactionError('PUBLISH_LOCKED', this.lockPath, 'another attempt owns the lock; wait for it to finish, or reconcile an abandoned attempt before removing its lock')
    }
    this.owned = true
  }

  /**
   * Read server state with a bounded retry budget. A dry run can read without
   * acquiring the lock and therefore observes an advisory, changing snapshot.
   * @param script - Read-only shell command.
   * @returns Captured output; unreadable state rejects.
   */
  async read(script: string): Promise<string> {
    let cause: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await this.transport.execute(script) } catch (error) { cause = error }
    }
    throw new PublishTransactionError('PUBLISH_UNKNOWN', 'remote read', 'cannot establish server state; stop and restore access before retrying', cause)
  }

  /**
   * Run one owned mutation exactly once. A failed response preserves the lock,
   * because command completion cannot be inferred from transport failure.
   * @param script - Mutation confined to this attempt's validated paths.
   * @returns Captured output.
   */
  async mutate(script: string): Promise<string> {
    try {
      return await this.transport.execute(`${this.ownerCheck()}\n${script}`)
    } catch (cause) {
      this.uncertain = true
      throw new PublishTransactionError('PUBLISH_UNKNOWN', this.lockPath, `remote mutation outcome is unknown; lock retained for attempt ${this.attempt}`, cause)
    }
  }

  /**
   * Create a directory only below verified physical parents.
   * @param path - Absolute directory beneath the feed root.
   * @returns Resolves when the directory exists.
   */
  async ensureDirectory(path: string): Promise<void> {
    await this.mutate(`${this.pathGuard(path)}\nmkdir -p ${this.checked(path)}`)
  }

  /**
   * Write one uniquely named text record without overwriting existing bytes.
   * @param path - Attempt-owned staging path.
   * @param text - Complete serialized record.
   * @returns Resolves after the write is acknowledged.
   */
  async stageText(path: string, text: string): Promise<void> {
    await this.ensureDirectory(posix.dirname(path))
    await this.mutate(`${this.pathGuard(path)}\nset -C; printf '%s' ${shellQuote(text)} > ${this.checked(path)}`)
  }

  /**
   * Upload a new attempt-owned path without retrying an unacknowledged stream.
   * @param staged - Unique staging path.
   * @param send - Transfer callback receiving the guarded remote command.
   * @returns Resolves once the upload transport completes.
   */
  async upload(staged: string, send: (script: string) => Promise<void>): Promise<void> {
    try {
      await send(`${this.ownerCheck()}\n${this.pathGuard(staged)}\nset -C; cat > ${this.checked(staged)}`)
    } catch (cause) {
      this.uncertain = true
      throw new PublishTransactionError('PUBLISH_UNKNOWN', staged, 'upload response was lost; preserve this attempt and reconcile the lock before retrying', cause)
    }
  }

  /**
   * Release only a conclusively completed attempt. Uncertain attempts retain
   * their lock, staging and recovery files for operator inspection.
   * @returns Resolves when released or deliberately retained.
   */
  async release(): Promise<void> {
    if (!this.owned || this.uncertain) return
    await this.mutate(`rmdir ${this.checked(`${this.lockPath}/${this.attempt}`)} && rmdir ${this.checked(this.lockPath)}`)
    this.owned = false
  }

  /**
   * Allocate this attempt's sibling upload name.
   * @param finalPath - Validated destination beneath the feed root.
   * @returns An attempt-specific staging path.
   */
  stagedPath(finalPath: string): string {
    this.checked(finalPath)
    return `${finalPath}.${this.attempt}.part`
  }

  /**
   * Read an exact path's size and SHA-512.
   * @param path - Absolute feed file path.
   * @returns Absence or its digest; malformed and failed reads reject.
   */
  async fileState(path: string): Promise<RemoteFileState> {
    const quoted = this.checked(path)
    const output = await this.read([
      this.pathGuard(path),
      `if [ -e ${quoted} ]; then`,
      `test -f ${quoted} && test ! -L ${quoted} || exit 74;`,
      `size=$(stat -c %s ${quoted} 2>/dev/null || stat -f %z ${quoted}) || exit 1;`,
      `digest=$(sha512sum ${quoted} 2>/dev/null || shasum -a 512 ${quoted}) || exit 1;`,
      'printf \'present %s %s\\n\' "$size" "${digest%% *}";',
      'else printf \'absent\\n\'; fi',
    ].join('\n'))
    const fields = output.trim().split(/\s+/u)
    if (fields.length === 1 && fields[0] === 'absent') return { kind: 'absent' }
    const size = Number(fields[1])
    const sha512 = fields[2]
    if (fields.length === 3 && fields[0] === 'present' && Number.isSafeInteger(size) && size >= 0 && sha512 !== undefined && /^[0-9a-f]{128}$/u.test(sha512)) {
      return { kind: 'present', sha512, size }
    }
    throw new PublishTransactionError('PUBLISH_UNKNOWN', path, 'invalid remote digest response; publication stopped')
  }

  /**
   * Commit a staged file without replacing an existing destination. Hard linking
   * in the same directory is atomic and fails if the destination already exists.
   * @param staged - Verified staged file.
   * @param finalPath - Immutable destination.
   * @param expected - Locally verified digest and size.
   * @returns Resolves only when the final bytes match.
   */
  async commitImmutable(staged: string, finalPath: string, expected: { sha512: string; size: number }): Promise<void> {
    let failure: unknown
    try {
      await this.mutate(`${this.pathGuard(staged)}\n${this.pathGuard(finalPath)}\nln ${this.checked(staged)} ${this.checked(finalPath)}`)
    } catch (error) { failure = error }
    const actual = await this.fileState(finalPath)
    if (actual.kind === 'present' && actual.sha512 === expected.sha512 && actual.size === expected.size) return
    throw new PublishTransactionError(failure === undefined ? 'PUBLISH_REFUSED' : 'PUBLISH_UNKNOWN', finalPath, 'immutable commit did not verify; preserve the lock and inspect the existing and staged bytes', failure)
  }

  /**
   * Preserve files and tag evidence before replacing a pointer or pruning.
   * Every copy is independently hashed; no destructive command may run until
   * all requested recovery files verify. Recovery copies are never pruned here.
   * @param paths - Exact files to preserve, all within the feed root.
   * @param tags - Tag and release-record evidence retained with the copies.
   * @returns The recovery directory for the operator's report.
   */
  async backup(paths: readonly string[], tags: string): Promise<string> {
    const inventory: { path: string; sha512: string; size: number }[] = []
    for (const path of paths) {
      const before = await this.fileState(path)
      if (before.kind === 'absent') throw new PublishTransactionError('PUBLISH_REFUSED', path, 'required recovery file is missing; nothing may be replaced or pruned')
      const destination = `${this.recoveryPath}/${path.slice(this.root.length + 1)}`
      const existing = await this.fileState(destination)
      if (existing.kind === 'absent') {
        await this.ensureDirectory(posix.dirname(destination))
        await this.mutate(`${this.pathGuard(path)}\n${this.pathGuard(destination)}\ncp -p ${this.checked(path)} ${this.checked(destination)}`)
      }
      const copy = await this.fileState(destination)
      if (copy.kind !== 'present' || copy.sha512 !== before.sha512 || copy.size !== before.size) {
        throw new PublishTransactionError('PUBLISH_REFUSED', destination, 'recovery copy digest differs; nothing may be replaced or pruned')
      }
      this.snapshots.set(path, before)
      inventory.push({ path, sha512: before.sha512, size: before.size })
    }
    const metadata = JSON.stringify({ attempt: this.attempt, inventory, tags })
    const metadataPath = `${this.recoveryPath}/inventory-${randomUUID()}.json`
    await this.stageText(metadataPath, metadata)
    const readback = await this.read(`cat ${this.checked(metadataPath)}`)
    if (readback.trim() !== metadata) throw new PublishTransactionError('PUBLISH_REFUSED', metadataPath, 'recovery inventory did not verify; destructive work stopped')
    return this.recoveryPath
  }

  private async requireBackup(path: string): Promise<void> {
    const current = await this.fileState(path)
    if (current.kind === 'absent') return
    const saved = this.snapshots.get(path)
    const copy = await this.fileState(`${this.recoveryPath}/${path.slice(this.root.length + 1)}`)
    if (saved?.kind !== 'present' || copy.kind !== 'present' || current.sha512 !== saved.sha512 || current.size !== saved.size || copy.sha512 !== saved.sha512 || copy.size !== saved.size) {
      throw new PublishTransactionError('PUBLISH_REFUSED', path, 'no verified recovery copy of the current bytes; destructive work stopped')
    }
  }

  /**
   * Replace one pointer, retaining its verified predecessor. A lost response
   * triggers readback: matching target bytes confirm commit, previous bytes
   * establish no observed commit, and unreadable or other bytes remain unknown.
   * @param staged - This attempt's verified manifest.
   * @param finalPath - Live manifest path.
   * @param expected - Expected target digest and size.
   * @returns Resolves only after the target is confirmed on disk.
   */
  async commitPointer(staged: string, finalPath: string, expected: { sha512: string; size: number }): Promise<void> {
    await this.requireBackup(finalPath)
    let failure: unknown
    try {
      await this.mutate(`${this.pathGuard(staged)}\n${this.pathGuard(finalPath)}\nmv -f ${this.checked(staged)} ${this.checked(finalPath)}`)
    } catch (error) { failure = error }
    let actual: RemoteFileState
    try { actual = await this.fileState(finalPath) } catch (cause) {
      this.uncertain = true
      throw new PublishTransactionError('PUBLISH_UNKNOWN', finalPath, 'pointer commit cannot be read back; it may already serve the target; preserve the lock and reconcile before retrying', cause)
    }
    if (actual.kind === 'present' && actual.sha512 === expected.sha512 && actual.size === expected.size) return
    this.uncertain = true
    throw new PublishTransactionError('PUBLISH_UNKNOWN', finalPath, 'target is not confirmed after the pointer command; an unacknowledged command may still complete; preserve the lock and reconcile before retrying', failure)
  }

  /**
   * Remove only exact paths whose current bytes still match verified recovery.
   * @param paths - Reviewed prune targets.
   * @returns Resolves after deletion; transport failure retains unknown outcome.
   */
  async prune(paths: readonly string[]): Promise<void> {
    for (const path of paths) await this.requireBackup(path)
    if (paths.length > 0) {
      await this.mutate(`${paths.map(path => this.pathGuard(path)).join('\n')}\nrm -f -- ${paths.map(path => this.checked(path)).join(' ')}`)
    }
  }
}
