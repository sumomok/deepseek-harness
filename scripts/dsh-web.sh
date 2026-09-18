#!/usr/bin/env bash
# Start the server-console web console from this checkout with its own harness
# home.
#
# Contract: `DSH_HOME` is exported as `~/.dsh-web` unless the caller already
# supplied a non-empty value (an empty or whitespace-only value counts as
# unset, matching `resolveDshHome`), the working directory becomes the
# repository root so `pnpm dsh` resolves the root script and the console's
# default workspace root is the checkout, and the process is replaced by
# `pnpm dsh web` carrying every argument verbatim. The script creates no
# directory: `dsh` owns the harness home and initializes the `web` profile
# inside it on first use.
#
# The separate home keeps this line's sessions, `web` profile, and settings
# apart from the desktop build's `~/.dsh`.
#
# Built artifacts are a precondition: run `pnpm run build` after a fresh
# checkout, exactly as the source launch documented in apps/cli/README.md
# requires.

set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

export DSH_HOME="${DSH_HOME:-$HOME/.dsh-web}"

cd -- "$root"
exec pnpm dsh web "$@"
