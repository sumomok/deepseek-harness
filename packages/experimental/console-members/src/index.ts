/**
 * The console member directory package root. It re-exports every type of
 * `./types`, so importing it also loads the `Context.consoleMembers`
 * declaration.
 *
 * This package currently provides only the types that define the service. It
 * registers no plugin and has no runtime exports; a consumer's
 * `inject: ['consoleMembers']` stays pending until a plugin that provides the
 * service is loaded. Consumers import the types from
 * `@deepseek-ai/dsh-experimental-console-members/types`.
 *
 * @module @deepseek-ai/dsh-experimental-console-members
 */

export type * from './types.ts'
