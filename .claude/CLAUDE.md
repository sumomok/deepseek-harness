# Fork standing orders

Root `CLAUDE.md` is upstream's `AGENTS.md` (budgeted, never edited here); this file carries the fork's own rules. Claude Code loads both every session.

## Branches and worktrees

- `master` mirrors `upstream/master`; never push to `upstream`. `develop` is the fork line (desktop, PWA, server apps, built-in plugins): every change branches from `develop` and merges back there. `core-patches` holds the upstream patches re-applied on every sync. `product/server-console` is a separate long-lived line that never merges into `develop`.
- One `git worktree` per task, created from `origin/develop` after `git fetch`; build, pack, and commit only in a worktree that has `node_modules` (lefthook runs from it). Never `--no-verify`.

## Desktop release (`apps/desktop`)

- Package both platforms explicitly — `pnpm --filter @deepseek-ai/dsh-desktop run package --mac --win` — in the background with logs redirected and no pipes (about fifteen minutes per platform; a pipe hides the exit code). The run ends by verifying the six artifacts of the version.
- `pnpm run doc-sync` must be green before `publish-update.ts --notes …`, which uploads, reads both manifests back, prunes the feed (current + previous artifacts, ten blockmaps), and tags `desktop-v<version>` on `origin`.
- Any content change bumps the version; `--republish` only repairs a cut-off upload and never triggers client updates.

## Tools and plugins

- A new tool parameter ships with four things together: the parameter, a rewritten description, failure text that names the remedy, and — only when an Agent Note justifies the context cost — a system-prompt line ([cookbook](../docs/cookbook/adding-a-tool.md#how-your-tool-reaches-the-model)).
- Out-of-repo plugins (`dsh-plugins` workspace) reach the desktop only as `pnpm pack` tarballs vendored in `apps/desktop-server/vendor/`; never `link:` — a second cordis breaks service identity. Third-party plugins declare no approval gates by default: audit egress, raw `node:fs`/`child_process`, routes, and custom session events (`ignorable: true` or they brick session logs on uninstall) before vendoring.
