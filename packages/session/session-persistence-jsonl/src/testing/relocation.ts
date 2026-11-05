import {
  createJsonlRelocationRuntime,
  type JsonlRelocationRuntime,
  type JsonlRelocationRuntimeOverrides,
} from '../relocation.ts'

/**
 * Create relocation operations with deterministic I/O, verifier, and crash seams for tests.
 * @param overrides - deterministic filesystem, platform, verifier, and barrier dependencies.
 * @returns bound relocation operations.
 */
export function createJsonlRelocationTestRuntime(
  overrides: JsonlRelocationRuntimeOverrides = {},
): JsonlRelocationRuntime {
  return createJsonlRelocationRuntime(overrides)
}
