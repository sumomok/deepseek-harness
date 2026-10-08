/**
 * Host-face Typert manifest of the organization fixture, discovered by
 * `@deepseek-ai/dsh-typert-loader` through `exports["./typert"]`. Hand-written
 * the way an out-of-repo plugin writes one: three direct methods on the
 * `sumomokOrgNotice` service, each argument checked by its codec's `parse`.
 */

/**
 * A strict codec.
 * @param {string} typeSymbol - the codec's type name.
 * @param {(value: unknown) => unknown} parse - the check an argument passes through.
 * @returns the codec.
 */
function strict(typeSymbol, parse = value => value) {
  return { mode: 'strict', typeSymbol, create: () => ({ parse }) }
}

const version = {
  name: 'version',
  wire: 'version',
  source: 'json',
  codec: strict('@fixture/org#DisclosureVersion', (value) => {
    if (!Number.isInteger(value) || value < 1) throw new TypeError('version must be a positive whole number')
    return value
  }),
}

/**
 * One method's invocation descriptor.
 * @param {string} method - the method.
 * @param {object[]} parameters - its parameters.
 * @returns the descriptor.
 */
function invocation(method, parameters) {
  return {
    id: `@fixture/org#sumomokOrgNotice/${method}`,
    service: 'sumomokOrgNotice',
    namespace: 'sumomokOrgNotice',
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: strict(`@fixture/org#${method}Answer`),
  }
}

/** The contribution `dsh-typert-loader` registers for this package. */
export const TYPERT = {
  package: '@fixture/org',
  face: 'host',
  schemas: [],
  invocations: [invocation('due', []), invocation('markSeen', [version]), invocation('confirm', [version])],
  model: {
    services: [{
      description: 'The organization notice, answered for one member from in-memory state.',
      summary: 'Organization notice fixture.',
      tags: [],
      key: 'sumomokOrgNotice',
      exportName: 'OrgNoticeFixture',
      members: [
        { kind: 'method', name: 'due', signature: 'due(): Promise<OrgNoticeDue>' },
        { kind: 'method', name: 'markSeen', signature: 'markSeen(version: number): Promise<MarkSeenAnswer>' },
        { kind: 'method', name: 'confirm', signature: 'confirm(version: number): Promise<ConfirmAnswer>' },
      ],
      types: [],
    }],
    events: [],
    objects: [],
  },
}

export default TYPERT
