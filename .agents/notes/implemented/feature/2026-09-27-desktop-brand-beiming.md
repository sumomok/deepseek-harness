# Agent Note: The desktop names itself 北冥 and shows its own release version

Status: implemented

English | [中文](2026-09-27-desktop-brand-beiming.zh.md)

## Problem

The desktop client showed upstream's local-build identity. The sidebar brand row rendered ui-sidebar's fallback, `brand.localBuild` ("DSH 本地构建" / "DSH Local Build") with the build version under it; the window title was `DSH_CLIENT_TITLE ?? t('brand.localBuild')`; and Settings → General's last row read `当前版本：0.1.7-rc.2`, the repository version, while the application a user installs is `0.1.0-rc.34`. The product is to be called 北冥 (Beiming in English) and show its own release version. The application name, installer name `DSH Desktop`, and `appId` stay as they are, because userData and the update feed are keyed on them.

The work had to stay in the fork's own paths. Three upstream facts shaped it:

- `scripts/build.ts` resolves the client environment through `repositoryClientBuildEnvironment`, which deletes an inherited `DSH_CLIENT_VERSION` and writes the root `package.json` version. Setting the variable around `pnpm run build` changes nothing.
- The window title is one build-time string. The `common` namespace's `brand.localBuild` cannot be shadowed, because `LocaleRegistry.register` throws on a duplicate namespace and locale, and the slot registry has no replace or suppress for another package's registration, so Settings → General's `current-version` row can only show whatever `DSH_CLIENT_VERSION` holds.
- A client half gets no composition `config` (the boot manifest carries id, url, rev, inject, external, immediately), and the root client build's workspace is `vendor/*`, `packages/*/*`, `apps/cli`. A vendored tarball is built elsewhere and cannot see this build's `DSH_CLIENT_VERSION` substitution.

## Decision

The sidebar name is a slot occupant in `@deepseek-ai/dsh-desktop-app`, the desktop's own composition layer. The package gains an empty Host apply (`src/index.ts`) and a browser half (`src/client/index.ts`) that registers the `desktop-brand` locale namespace (`name`: 北冥 / Beiming) and occupies `sidebar.brand.name` with the name and, under it, `DSH_CLIENT_VERSION`. The layer's `cordis.patch.yml` inserts the `desktop-brand` row naming the package. `ui-brand-official` stays mounted; it registers only under the `official` client profile, which this application never builds, so the single slot has one occupant. `sidebar.brand.mark` stays on the fish fallback.

The package's `build.ts` bundles both halves with esbuild in the closure-factory form the module loader consumes, requesting `PLATFORM_MODULES` from the shell's table and substituting `DSH_CLIENT_*` through `clientBuildEnvironmentDefines`, the same helper the repository's bundles use. It follows the vendored plugins' build rather than `packages/client/tsdown.client.ts`, whose preset resolves manifests under `packages/*/*` only.

The desktop package no longer runs `pnpm run build`. `apps/desktop-shell/scripts/client-build.ts` runs the same three scripts (`build:native-system`, `build:lib`, `build:web`), then the desktop-app bundle, with `clientBuildProcessEnvironment` over the repository values plus `DSH_CLIENT_TITLE=北冥` and `DSH_CLIENT_VERSION=<apps/desktop-shell version>`, and writes the client build record from that environment. `verifyDesktopClientBuild` then requires the record to match the artifacts and name both values, `apps/web/dist/index.html` to carry `<title>北冥</title>`, and the Settings → General and desktop-app bundles to embed the version; `--skip-repo-build` goes through the same check. A test reads `scripts/build.ts` and requires its `runScript` sequence to equal the list here, so an upstream step change fails in the fork.

## Alternatives considered

- **`DSH_CLIENT_TITLE` and `DSH_CLIENT_VERSION` around `pnpm run build`.** The title passes through, but `scripts/build.ts` replaces the version with the repository's, so Settings → General would still read `0.1.7-rc.2`. Making it honor an inherited version is a core change.
- **A vendored `@haoran/dsh-desktop-brand` tarball.** It is the fork's usual route for browser code, but a prebuilt bundle cannot see this build's `DSH_CLIENT_VERSION`, and its composition `config` never reaches the browser, so the version line would need a Host half and a Remote method of its own.
- **The `official` client profile.** It registers the DeepSeek Harness wordmark and sets `DSH_CLIENT_TITLE=DeepSeek Harness`, an identity this product must not show.
- **Overriding `brand.localBuild` in the `common` dictionary.** It would give a per-language title and sidebar label without a slot occupant, but the locale registry rejects a second registration for the same namespace and locale.

## Consequences

- The window title is 北冥 in both languages. A per-language title needs `AppFrame` or the `common` dictionary to change, which is core.
- Settings → General reads `当前版本：0.1.0-rc.34`. The form `0.1.0-rc.34（基于 DSH 0.1.7-rc.2）` needs the row's core copy to change, so it is not shown.
- `DSH_CLIENT_VERSION` is also what `ui-settings-account` sends as `x-client-version` on DeepSeek Platform account calls; those calls now report the desktop version.
- A development `dsh web` launch from source has no desktop-app `lib/` until `pnpm --filter @deepseek-ai/dsh-desktop-app run bundle` runs, and a desktop profile needs it.
- No recorded-session snapshot changes: the brand row, title, and version row are client chrome with no session event or model-visible input.

## Related

- [The desktop composition layer](2026-09-06-desktop-composition-layer-content-search.md), the package this note extends.
- [ui-brand-official](../../../../packages/client/ui-brand-official/README.md), the upstream occupant of the same slots.
