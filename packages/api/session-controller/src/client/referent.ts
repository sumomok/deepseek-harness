/**
 * The `referent/open` seam: one ROOT-scope cordis waterfall event every
 * "open this reference" click in the browser conversation UI dispatches
 * through, so a listener anywhere in the tree can intercept a click on a
 * produced-file chip, a tool-row path, or a mention before the pre-existing
 * open action runs — without every affordance importing a bespoke
 * intercept point of its own.
 *
 * @module @deepseek-ai/dsh-api-session-controller/client/referent
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Open-target kinds a `referent/open` payload may carry. Declaration-merge a
 * new key here (mirroring `ContentBlockMap`'s vocabulary-growth pattern) to
 * add a kind without widening this file; a listener switches on `kind` with
 * a documented default for a member it does not recognize, never
 * `assertNever` (the union grows across package boundaries).
 */
export interface ReferentKindMap {
  file: true
  dir: true
  url: true
}

/** The open target's kind: closed here, open across packages via {@link ReferentKindMap}. */
export type ReferentKind = keyof ReferentKindMap

/**
 * One reference a user clicked to open. Carries identity only, never
 * content: a listener that needs bytes reads them itself (e.g. through the
 * durable attachment seam via `attachment`/`file`), the same way the
 * pre-existing open action does.
 */
export interface ReferentRef {
  /** What kind of target this is; see {@link ReferentKindMap}. */
  kind: ReferentKind
  /** Resolved target the default open action acts on (an absolute path for `file`/`dir`, a URL string for `url`). */
  target: string
  /** The raw text as it appeared at the reference's source, before any resolution. */
  raw: string
  /** Durable attachment reference, when the target is backed by one (e.g. a sent file's card). */
  attachment?: FileAttachmentRef
  /** Owning session, when the reference is session-scoped. */
  sessionId?: SessionId
  /** Free-form label naming the dispatch site (e.g. `'chat-view.openFile'`), for listener filtering and diagnostics. */
  source: string
  /** How this reference entered the transcript. */
  provenance: 'structured' | 'model-text' | 'tool-output' | 'user-text'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A user-gesture click on a reference to a file, directory, URL, or
     * other addressable target (declaration-merge {@link ReferentKindMap}
     * for a new kind). A listener claims the open by returning without
     * calling `next()`; calling `next()` delegates to the next listener,
     * finally the dispatch site's own pre-existing open action. A listener
     * that throws, or whose returned promise rejects, is caught, logged,
     * and treated as a fall-through to that same default — a click must
     * always resolve predictably regardless of what a listener does.
     *
     * Security invariant: dispatch this only from a direct user-gesture
     * handler (a click/keydown callback), never from a programmatic or
     * background code path — a claiming listener may perform a
     * user-authorized action a script must not be able to trigger silently.
     * @param ref - the reference being opened.
     * @param next - delegate to the next listener or the dispatch site's default open action.
     * @mode waterfall
     */
    'referent/open'(ref: ReferentRef, next: () => Promise<void>): Promise<void>
  }
}

/**
 * Dispatch `referent/open` for one user-gesture click, falling through to
 * `onDefault` when the chain reaches the terminus, a listener throws, or a
 * listener's promise rejects. `onDefault` runs at most once (memoized): once
 * it has run, its own outcome — success or failure — is the call's real
 * outcome regardless of what any listener does afterward, so a genuine
 * failure of the pre-existing open action this seam wraps still reaches the
 * caller exactly as it did before this seam existed. Only a listener that
 * throws or rejects *before* ever delegating counts as the "listener
 * failure" case this recovers from by running the default for the first
 * time.
 * @param ctx - dispatching context (the security invariant on `referent/open` applies to this call, not to `ctx`).
 * @param ref - the reference being opened.
 * @param onDefault - the pre-existing open action this seam wraps (the waterfall's terminus).
 * @returns settles once the claiming listener, or the default action, settles; rejects only with the default action's own failure.
 */
export async function dispatchReferentOpen(
  ctx: Context,
  ref: ReferentRef,
  onDefault: () => Promise<void> | void,
): Promise<void> {
  let settled: Promise<void> | undefined
  const guardedDefault = (): Promise<void> => {
    settled ??= Promise.resolve().then(onDefault)
    return settled
  }
  try {
    await ctx.waterfall('referent/open', ref, guardedDefault)
  } catch (error) {
    if (settled !== undefined) {
      // The default already ran (a listener delegated to it via next()):
      // its own outcome is the real one. Re-await it so a genuine failure
      // still propagates, unaffected by what a listener did afterward.
      await settled
      return
    }
    // Nothing ever delegated: a listener threw or rejected before reaching
    // the default. The specific listener at fault is unknowable here (the
    // waterfall gives no per-listener identity on error) — log and recover
    // by running the default for the first time.
    console.error('referent/open: a listener threw or rejected before delegating; falling back to the default open action', error)
    await guardedDefault()
  }
}

/**
 * `ctx.referent`'s injected-service face: a client feature package under
 * `packages/client/*` may import only types across a plugin boundary, never
 * call another plugin's runtime export directly (`dsh-client-bundle-purity`,
 * `packages/client/tsdown.client.ts`), so {@link dispatchReferentOpen} — a
 * genuine cross-plugin runtime call, not an erased type — reaches those
 * packages through this service instead of a bare function import.
 * `dispatchReferentOpen`'s own free-function export is unchanged and still
 * the only entry point available to a consumer outside `packages/client/*`
 * (e.g. an out-of-repo plugin without a `dsh.client` manifest of its own).
 */
export interface IReferent {
  /**
   * Dispatch `referent/open` for one user-gesture click; see
   * {@link dispatchReferentOpen} for the full contract. A thin wrapper: the
   * behavior is identical, only the call surface differs.
   * @param ref - the reference being opened.
   * @param onDefault - the pre-existing open action this seam wraps.
   */
  open(ref: ReferentRef, onDefault: () => Promise<void> | void): Promise<void>
}

/**
 * `ctx.referent`'s implementation. Cordis rebinds `this.ctx` to whichever
 * context a caller reaches the service through (the same mechanism
 * `ctx.conversation`/`ctx.workspaces` rely on), so `open()` dispatches on
 * the caller's own context — never the context this service happened to be
 * constructed with — matching {@link dispatchReferentOpen}'s own contract
 * exactly for a caller that used to invoke it directly.
 */
export class ClientReferent extends Service implements IReferent {
  /** @param ctx - registering context; see the class doc for why call-time `this.ctx` differs. */
  constructor(ctx: Context) {
    super(ctx, 'referent')
  }

  async open(ref: ReferentRef, onDefault: () => Promise<void> | void): Promise<void> {
    await dispatchReferentOpen(this.ctx, ref, onDefault)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client-side `referent/open` dispatch; see {@link IReferent}. */
    referent: IReferent
  }
}
