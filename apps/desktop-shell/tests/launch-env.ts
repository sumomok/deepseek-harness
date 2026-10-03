/**
 * The server environment `src/main.ts` composes at launch, as that file
 * writes it, for the suites that check what reaches the server child.
 * @module
 */

/** The `env` property of the launch's `startOnPort` spec, indented as in main.ts. */
export const LAUNCH_ENV = `env: {
            ...renderEnv, ...updateEnv, ...dataEnv, ...pnpmEnv, ...installEnv, ...appDirs, ...officeEngineEnv, [SERVER_LOG_ENV]: logFile,
          }`
