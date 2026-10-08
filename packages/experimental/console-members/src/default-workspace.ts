/**
 * Each member's default workspace, `<member root>/workspace`, registered in
 * the workspace registry after the member is admitted.
 *
 * The admitter is synchronous and cannot wait for `workspace.create`, so
 * admission starts the registration step and returns. The step creates the
 * directory when it is missing, fails when the directory's real path is not
 * `<member root>/workspace` itself, so a symbolic link planted there cannot
 * register another directory as the member's workspace, and calls
 * `workspace.create`, which returns
 * the workspace already registered for the same canonical path, so running
 * it again for a member registered by an earlier process finds that
 * workspace. Within one process each member has at most one step in flight or
 * succeeded; a failed step is forgotten, logged without the principal key or
 * the failure's text, and the next admission or `workspace/initializeDefault`
 * starts another. Until a member's step has succeeded in this process,
 * {@link DefaultWorkspaces.defaultWorkspaceReady} is `false`, and calls that
 * depend on that member's roots are refused.
 * @module @deepseek-ai/dsh-experimental-console-members/src/default-workspace
 */

import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import type { PrincipalKey } from './types.ts'

/** The workspace registry operation the registration step calls. */
export interface WorkspaceCreator {
  /**
   * Create or reuse the workspace of one existing directory.
   * @param path - the directory, fully qualified.
   * @returns the existing or newly registered workspace.
   */
  create(path: string): Promise<Workspace>
}

/**
 * The rejection a registration step settles with when it fails. It carries
 * none of the failure's own text, so a caller that answers with it reveals no
 * path or backend message.
 */
export class DefaultWorkspaceUnregisteredError extends Error {
  constructor() {
    super('console-members: the member\'s default workspace is not registered')
    this.name = 'DefaultWorkspaceUnregisteredError'
  }
}

/** The default-workspace registration steps of one loaded row. */
export class DefaultWorkspaces {
  private readonly steps = new Map<PrincipalKey, Promise<Workspace>>()
  private readonly ready = new Set<PrincipalKey>()

  /**
   * @param memberRoot - the member's default root from the root registry.
   * @param workspaces - the workspace registry.
   * @param logger - where a failed step is reported.
   */
  constructor(
    private readonly memberRoot: (principal: PrincipalKey) => string,
    private readonly workspaces: WorkspaceCreator,
    private readonly logger: Logger,
  ) {}

  /**
   * Start the member's registration step unless one is in flight or has
   * succeeded in this process, and return that step. Admission calls it
   * without waiting; `workspace/initializeDefault` waits for it. The returned
   * promise never counts as an unhandled rejection.
   * @param principal - a member whose root is registered.
   * @returns the step: the member's default workspace, or a {@link DefaultWorkspaceUnregisteredError} rejection.
   */
  ensureDefaultWorkspace(principal: PrincipalKey): Promise<Workspace> {
    const current = this.steps.get(principal)
    if (current !== undefined) return current
    const step = this.register(principal).then(
      (workspace) => {
        this.ready.add(principal)
        return workspace
      },
      (_failure: unknown) => {
        this.steps.delete(principal)
        // Neither the principal key nor the failure's text: the text can carry the member's root path.
        this.logger.warn('registering a member\'s default workspace failed; calls that depend on that member\'s roots '
          + 'stay refused until the next admission or workspace/initializeDefault registers it')
        throw new DefaultWorkspaceUnregisteredError()
      },
    )
    // Admission does not wait for the step; this handler keeps an unawaited failure from being an unhandled rejection.
    step.catch((_reported: unknown) => undefined)
    this.steps.set(principal, step)
    return step
  }

  /**
   * Wait until no registration step started so far is in flight, so that an
   * unloading row touches neither the file system nor the workspace registry
   * afterwards.
   * @returns a promise that settles once every step has settled; it never rejects.
   */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.steps.values()])
  }

  /**
   * Whether the member's registration step has succeeded in this process.
   * @param principal - the member.
   * @returns `true` once the step has settled with the workspace; `false` while it is in flight, after it failed, or before it started.
   */
  defaultWorkspaceReady(principal: PrincipalKey): boolean {
    return this.ready.has(principal)
  }

  /**
   * Create `<member root>/workspace` when missing and register it. The member
   * root is a real path, so the directory's real path equals its own path
   * unless a symbolic link stands at it; the step refuses that directory, and
   * a workspace registered at any other path, before the member counts as ready.
   * @param principal - the member.
   * @returns the registered workspace.
   * @throws {Error} when the directory or the registered workspace is not at `<member root>/workspace`.
   */
  private async register(principal: PrincipalKey): Promise<Workspace> {
    const directory = join(this.memberRoot(principal), 'workspace')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (await realpath(directory) !== directory) throw new Error('the default workspace directory resolves to another directory')
    const workspace = await this.workspaces.create(directory)
    if (workspace.path !== directory) throw new Error('the registered default workspace is at another directory')
    return workspace
  }
}
