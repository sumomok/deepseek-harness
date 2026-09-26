/**
 * The embedded server's own log records, appended to the desktop log file.
 *
 * Every plugin logs through `ctx.logger` — the webserver's listen errors, a
 * plugin's named `ctx.logger('auto-compact')` — and the product composition
 * registers no exporter for it, so those records reach only the logger's
 * in-memory buffer and are gone with the process. This plugin registers one
 * exporter on the root logger service, which every context in the tree shares,
 * isolated preset realms included, and appends each record it accepts to
 * `file` as it arrives.
 *
 * The row mounts after the entries before it have started, so records logged
 * during boot predate the exporter. On mount it first appends what the
 * service's own buffer holds within the threshold — that buffer keeps the last
 * thousand records at the logger's default threshold, INFO, so a boot-time
 * warning is not in it — and then every record as it arrives. The buffer is
 * read in the same synchronous step that registers the exporter, so no record
 * is appended twice.
 *
 * It writes the file itself rather than printing: the desktop shell reads the
 * server's stdout and stderr for its readiness line and appends both streams
 * to the same log file, so a record printed there would be scanned by that
 * match and reach the file through the shell as well. Each record is one
 * `appendFileSync` call, so the file gets it once and whole beside the shell's
 * own lines.
 * @module @deepseek-ai/dsh-desktop-app/server-log
 */

import { appendFileSync } from 'node:fs'
import { type Context, type Exporter, Logger, type LoggerType, type Message } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Plugin name. */
export const name = 'desktop-server-log'

/** Configuration of the exporter. */
export interface Config {
  /** Absolute path of the file every accepted record is appended to. */
  file: string
  /**
   * The highest cordis level exported for every logger name: ERROR is 0,
   * INFO 1, WARN 2, DEBUG 3, so a threshold of 2 keeps errors, info and
   * warnings and drops debug.
   */
  level: number
}

/** Configuration schema; both fields are required, because the deployment row states them. */
export const Config: z<Config> = z.object({
  file: z.string().required(),
  level: z.natural().max(3).required(),
})

/** The prefix every record line starts with, which is what tells it apart from the shell's `[desktop]` lines. */
export const RECORD_PREFIX = '[server-log]'

/** One letter per level, the same letters `@deepseek-ai/cordis-plugin-logger-console` prints. */
const LEVEL_LETTERS: Record<LoggerType, string> = { error: 'E', info: 'I', warn: 'W', debug: 'D' }

/**
 * Render one record as the text appended for it: a header line with the
 * record's time, level letter, and logger name, then the message, whose
 * continuation lines — an error's stack above all — are indented under it.
 * @param exporter - the exporter the record was delivered to, whose formatting settings apply.
 * @param message - the record.
 * @returns the text to append, ending in a newline.
 */
export function renderRecord(exporter: Exporter, message: Message): string {
  const [first = '', ...rest] = Logger.format(exporter, message).split('\n')
  const header = `${RECORD_PREFIX} ${new Date(message.ts).toISOString()} ${LEVEL_LETTERS[message.type]} ${message.name}: ${first}`
  return [header, ...rest.map(line => `  ${line}`)].join('\n') + '\n'
}

/**
 * Register the exporter; it is removed with this plugin's fiber.
 * @param ctx - the plugin context.
 * @param config - the file and the level threshold.
 */
export function apply(ctx: Context, config: Config): void {
  const append = (text: string): void => {
    try {
      appendFileSync(config.file, text)
    } catch {
      // An unwritable log file costs this text and nothing else: the exporter
      // runs inside whichever plugin is logging, and a throw here would
      // surface as that plugin's failure.
    }
  }
  const exporter: Exporter = {
    colors: false,
    levels: { default: config.level },
    export: (message) => { append(renderRecord(exporter, message)) },
  }
  const backlog = ctx.logger.buffer.filter(message => message.level <= config.level)
  ctx.logger.exporter(exporter)
  if (backlog.length > 0) append(backlog.map(message => renderRecord(exporter, message)).join(''))
}
