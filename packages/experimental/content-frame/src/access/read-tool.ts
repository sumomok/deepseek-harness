/**
 * `content_read` — the agent reads the page the user is looking at.
 *
 * The body writes nothing and computes nothing: it registers a wait, and a
 * browser seat showing this session claims the call, walks the frame's
 * document, and posts the listing back. Everything the model can be told about
 * a page therefore comes from a real browser looking at a real document, and a
 * session with no console open is told exactly that rather than given a stale
 * or invented answer.
 *
 * Every ending is a sentence naming what to do next — call `content_show`, drop
 * `scope`, ask the user, retry once — because a failure is the only tool text
 * the model reads while deciding its next step. A page asking for a sign-in is
 * a failure too: its listing is withheld rather than described, so a password
 * form never becomes something the model narrates around.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/read-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CallTimeouts, PendingCalls } from './pending.ts'
import {
  AFTER_DESCRIPTION, AFTER_REFUSAL, CANCELLED_REFUSAL, CONTENT_READ_DESCRIPTION, failureRefusal,
  FIND_DESCRIPTION, FIND_REFUSAL, MISREPORTED_REFUSAL, MODE_DESCRIPTION, NO_AGENT_REFUSAL, READ_VOICE,
  readHeaderText, SCOPE_DESCRIPTION, SCOPE_REFUSAL, SIGN_IN_REFUSAL, unansweredRefusal, unclaimedRefusal,
  type FrontEntry,
} from './text.ts'
import { CONTENT_READ_TOOL_NAME, isActOutcome, type ReadArgs, type ReadOutcome } from './wire.ts'

/** The form every ref takes, which is also the form the refusals quote. */
const REF_PATTERN = /^e\d+$/

/** Longest accepted `find`, stated in its own refusal. */
const MAX_FIND_CHARS = 200

/** Title of the call card, in the pending and the settled state alike. */
const CALL_TITLE = 'Read the page in the content column'

/** The canonical outcome declared by the `content_read` output schema. */
export interface ContentReadValue {
  /** Discriminant; a read that found no page throws instead of answering. */
  status: 'ok'
  /** The page the column had in front, as the deployment names it. */
  page: { id: string; title: string }
  /** The document's own title. */
  title: string
  /** The path the frame is at, origin dropped. */
  url: string
  /** Which listing came back. */
  kind: 'outline' | 'map'
  /** The name of the dialog the page has open. */
  modal?: string
  /** The listing itself. */
  text: string
  /** True when the listing stops short of everything the read would have shown. */
  truncated: boolean
  /** How many rows the listing renders. */
  shown: number
  /** How many rows the listing has in full. */
  total: number
  /** The ref to pass back as `after`; present only on a listing cut short. */
  cursor?: string
  /** False when the page was still changing when the read ran. */
  settled: boolean
  /** What the page marks as still loading; absent when it marks nothing. */
  busy?: string[]
}

/**
 * Refuse arguments the reader could not act on, naming the parameter to fix.
 * @param args - the validated arguments.
 * @returns the refusal, or `undefined` when every argument is usable.
 */
function refuseArgs(args: ReadArgs): string | undefined {
  if (args.scope !== undefined && !REF_PATTERN.test(args.scope)) return SCOPE_REFUSAL
  if (args.after !== undefined && !REF_PATTERN.test(args.after)) return AFTER_REFUSAL
  if (args.find !== undefined && (args.find.length === 0 || args.find.length > MAX_FIND_CHARS)) return FIND_REFUSAL
  return undefined
}

/**
 * The part of a frame's URL worth spending tokens on.
 *
 * The origin carries no information — every page the column can show is a path
 * on the dsh origin — so the model is told where in the application it is
 * looking, not which host it is talking to.
 * @param url - the document's own URL as the browser reported it.
 * @returns the path, query, and fragment, or the whole value when it is not a URL.
 */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch (_reportedUrlIsNotAbsolute) {
    // A wire value: the browser sends `document.URL`, which is absolute, but
    // this route takes JSON from anything that can reach the origin.
    return url
  }
}

/**
 * Turn one posted outcome into the call's answer.
 * @param outcome - what the claiming seat reported.
 * @returns the canonical value for a page that was read.
 * @throws {Error} for every outcome that is not a listing, including a page
 * asking the user to sign in.
 */
function valueOf(outcome: ReadOutcome): ContentReadValue {
  if (outcome.status === 'error') throw new Error(failureRefusal(outcome, READ_VOICE))
  const { snapshot } = outcome
  // Withheld rather than described: the page is asking for a password, and the
  // model's next step is to hand the keyboard back, not to narrate the form.
  if (snapshot.signIn) throw new Error(SIGN_IN_REFUSAL)
  return {
    status: 'ok',
    page: outcome.page,
    title: snapshot.title,
    url: pathOf(snapshot.url),
    kind: snapshot.kind,
    ...snapshot.modal === undefined ? {} : { modal: snapshot.modal },
    text: snapshot.text,
    truncated: snapshot.truncated,
    shown: snapshot.shown,
    total: snapshot.total,
    ...snapshot.cursor === undefined ? {} : { cursor: snapshot.cursor },
    settled: snapshot.settled,
    ...snapshot.busy === undefined ? {} : { busy: snapshot.busy },
  }
}

/**
 * The salient input for the call card: what this read asked for, if anything.
 * @param args - the validated arguments.
 * @returns the compact summary, empty for a plain read of the whole page.
 */
function callSummary(args: ReadArgs): string {
  return [
    ...args.mode === undefined ? [] : [`mode ${args.mode}`],
    ...args.scope === undefined ? [] : [`scope ${args.scope}`],
    ...args.after === undefined ? [] : [`after ${args.after}`],
    ...args.find === undefined ? [] : [`find "${args.find}"`],
  ].join(', ')
}

/**
 * Read the entry one session's column has in front.
 *
 * Only the unclaimed refusal reads it, and only to say what the model should
 * do instead. A composition with no projection registry supplies a lookup that
 * answers `undefined`, which is the same answer an empty column gives and the
 * same advice it earns.
 */
export type FrontEntryLookup = (session: Session) => FrontEntry | undefined

/**
 * Build the `content_read` tool for one deployment.
 * @param pending - the table calls wait on for a browser to answer them.
 * @param timeouts - the deployment's deadlines, also quoted in the two timeout refusals.
 * @param front - reads the entry the calling session's column has in front, for the unclaimed refusal.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function contentReadTool(
  pending: PendingCalls,
  timeouts: CallTimeouts,
  front: FrontEntryLookup,
): ToolDefinition {
  return defineTool({
    name: CONTENT_READ_TOOL_NAME,
    description: CONTENT_READ_DESCRIPTION,
    parameters: {
      mode: { type: 'string', enum: ['outline', 'map'], description: MODE_DESCRIPTION },
      scope: { type: 'string', description: SCOPE_DESCRIPTION },
      after: { type: 'string', description: AFTER_DESCRIPTION },
      find: { type: 'string', description: FIND_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok'], required: true, description: 'Always "ok"; every other ending is an error.' },
          page: {
            type: 'object',
            additionalProperties: false,
            required: true,
            description: 'The page the column had in front.',
            properties: {
              id: { type: 'string', required: true, description: 'The id content_show names this page by.' },
              title: { type: 'string', required: true, description: 'The page\'s configured title.' },
            },
          },
          title: { type: 'string', required: true, description: 'The document\'s own title.' },
          url: { type: 'string', required: true, description: 'Where in the application the frame is, origin dropped.' },
          kind: { type: 'string', enum: ['outline', 'map'], required: true, description: 'Which listing came back.' },
          modal: { type: 'string', description: 'The name of the dialog the page has open.' },
          text: { type: 'string', required: true, description: 'The numbered listing.' },
          truncated: { type: 'boolean', required: true, description: 'Whether the listing stops short of the whole answer.' },
          shown: { type: 'integer', required: true, description: 'How many rows the listing renders.' },
          total: { type: 'integer', required: true, description: 'How many rows the listing has in full.' },
          cursor: { type: 'string', description: 'Pass as `after` to continue a listing that was cut.' },
          settled: {
            type: 'boolean',
            required: true,
            description: 'Whether the page had stopped changing when it was read; false means reading again may show more.',
          },
          busy: {
            type: 'array',
            items: { type: 'string' },
            description: 'What the page itself marks as still loading, when it marks anything.',
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${readHeaderText({
          page: value.page.title,
          url: value.url,
          title: value.title,
          ...value.modal === undefined ? {} : { modal: value.modal },
          kind: value.kind,
          truncated: value.truncated,
          total: value.total,
          settled: value.settled,
          busy: value.busy ?? [],
        })}\n${value.text}`,
      }],
      // The transcript row names the page it looked at, and the listing is
      // written for the model rather than for a reader, so the page's title is
      // the whole of what the UI needs persisted beside the result.
      presentationMeta: (_args, value) => ({ page: value.page.title }),
    },
    // The read writes nothing and only waits on a browser, so two reads in one
    // step are answered by the same seat one after the other rather than
    // queueing two claim deadlines.
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<ContentReadValue> {
      const refusal = refuseArgs(args)
      if (refusal !== undefined) throw new Error(refusal)
      // The column is per-session state, and the pending list a browser reads
      // is that session's projection; a caller with no owning session has no
      // column to be shown one.
      if (!exec.agent) throw new Error(NO_AGENT_REFUSAL)
      const settlement = await pending.open(exec.callId, exec.agent.session.header.id, exec.signal, timeouts)
      switch (settlement.kind) {
        case 'reported': {
          // The table holds both tools' calls and hands over whatever was
          // posted; a document reporting steps answers a different call than
          // this one asked.
          const outcome = settlement.outcome
          if (isActOutcome(outcome)) throw new Error(MISREPORTED_REFUSAL)
          return valueOf(outcome)
        }
        case 'unclaimed': throw new Error(unclaimedRefusal(timeouts.claimTimeoutMs, front(exec.agent.session)))
        case 'unanswered': throw new Error(unansweredRefusal(timeouts.answerTimeoutMs))
        // Whatever this returns is replaced by the registry's aborted result;
        // the message exists for a caller reading the rejection directly.
        case 'aborted': throw new Error(CANCELLED_REFUSAL)
        /* v8 ignore next 2 -- the settlement union is closed and typed; the arm keeps a new member loud. */
        default: throw new Error(`content_read: unknown settlement ${JSON.stringify(settlement)}`)
      }
    },
    presentCall: (args): GenericCallView => {
      const summary = callSummary(args)
      return {
        card: 'generic',
        title: CALL_TITLE,
        kind: 'other',
        ...summary === '' ? {} : { rawInput: summary },
      }
    },
    presentResult: (_args, result): GenericResultView => ({
      card: 'generic',
      title: result.content.find(block => block.type === 'text')?.text.split('\n')[0] ?? CALL_TITLE,
    }),
  })
}
