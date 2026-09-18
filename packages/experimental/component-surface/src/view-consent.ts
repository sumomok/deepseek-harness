/**
 * Who has already agreed to open which data page from the sidebar.
 *
 * A view that places `toy.crud` opens the deployment's own full page for a
 * table with the visitor's own credential, so a click on it is a question
 * before it is a draw — the same question, in the same words, a
 * `show_component` call asking for that page is put to. Asking it on every
 * click of the same row would be a question a person answers a dozen times an
 * afternoon and stops reading; never asking it again would be a grant nobody
 * ever gave.
 *
 * What is remembered is therefore one answer per signed-in person, per view,
 * per table, and only in this process. There is no grant store in the approval
 * service — `allowed-once` is the only outcome it has — so the memory is here,
 * it holds no token, and it is gone when the process is.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/view-consent
 */

/** How long one answer to the data-page question stands. */
export type CrudViewConsent =
  /** Until the visitor signs out, the token changes, or the process restarts. */
  | 'per-login'
  /** Not at all: every click is asked about again. */
  | 'every-time'

/** Every {@link CrudViewConsent}, for the config schema and its refusals. */
export const CRUD_VIEW_CONSENTS: readonly CrudViewConsent[] = ['per-login', 'every-time']

/**
 * One remembered answer's identity: which person answered, which view they
 * clicked, and which table that view opens.
 *
 * The table is part of it because a view the deployment edits to open a
 * different table is a different question — the card names the table, and an
 * answer to the old one is not an answer to the new one. The person is part of
 * it because the memory outlives a session and a process serves one visitor at
 * a time only by deployment convention.
 * @param login - the name of the login, from `ctx.loginIdentity`.
 * @param viewId - the view that was clicked.
 * @param meta - the table its data page opens, by its name in the backend.
 * @returns the key to remember the answer under.
 */
export function consentKey(login: string, viewId: string, meta: string): string {
  // A separator no part can contain: a view id is written in the entry-id
  // alphabet, a table name is a backend identifier, and the login is hexadecimal.
  return [login, viewId, meta].join('\u0000')
}

/**
 * The answers this process has been given, for as long as it runs.
 *
 * In memory and nowhere else. A restart asks again, which is the correct answer
 * for a grant nobody recorded, and a deployment that wants the question every
 * time sets `crudViewConsent: 'every-time'` rather than relying on how long a
 * process happens to live.
 */
export class ViewConsentMemory {
  private readonly granted = new Set<string>()

  /** How long an answer stands, as the deployment configured it. */
  private readonly mode: CrudViewConsent

  /**
   * Open an empty memory.
   * @param mode - how long an answer stands.
   */
  constructor(mode: CrudViewConsent) {
    this.mode = mode
  }

  /**
   * Whether this person has already agreed to this view's page.
   * @param key - the key {@link consentKey} builds.
   * @returns true only where the deployment remembers answers and this one was given.
   */
  holds(key: string): boolean {
    return this.mode === 'per-login' && this.granted.has(key)
  }

  /**
   * Remember one answer.
   * @param key - the key {@link consentKey} builds.
   */
  remember(key: string): void {
    if (this.mode === 'per-login') this.granted.add(key)
  }
}
