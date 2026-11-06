# Agent Note: The desktop names itself 北冥 and shows its release version only on the update page

Status: implemented

English | [中文](2026-09-27-desktop-brand-beiming.zh.md)

## Problem

The desktop client showed upstream's local-build identity. The sidebar brand row rendered ui-sidebar's fallback, `brand.localBuild` ("DSH 本地构建" / "DSH Local Build") with the build version under it, and the window title was `DSH_CLIENT_TITLE ?? t('brand.localBuild')`. Settings → General's last row read `当前版本：0.1.7-rc.2`, the repository version, while the update settings page that `@haoran/dsh-desktop-update` renders shows the application's own version (`0.1.0-rc.34`). The product is to be called 北冥 (Beiming in English). The version the client build embeds stays upstream's, and the sidebar shows no version, so the desktop release version appears only on the update page. The sidebar's fish logo and name are to read larger than ui-sidebar's 24px mark and the stacked name above a version badge. The application name, installer name `DSH Desktop`, and `appId` stay as they are, because userData and the update feed are keyed on them.

The work had to stay in the fork's own paths. Three upstream facts shaped it:

- `scripts/build.ts` keeps an inherited `DSH_CLIENT_TITLE` in the client environment it embeds and records. It replaces an inherited `DSH_CLIENT_VERSION` with the root `package.json` version.
- The window title is one build-time string. The `common` namespace's `brand.localBuild` cannot be overridden, because `LocaleRegistry.register` throws on a duplicate namespace and locale.
- The slot registry lets entries share a cell at distinct priorities and renders the lowest; a list slot's cell is its entry `id`. A client half gets no composition `config`, and the root client build's workspace is `vendor/*`, `packages/*/*`, `apps/cli`, so a vendored tarball cannot see this build's `DSH_CLIENT_*` substitution.

## Decision

The desktop's browser changes live in `@deepseek-ai/dsh-desktop-app`, the desktop's own composition layer. The package gains an empty Host apply (`src/index.ts`) and a browser half (`src/client/index.ts`), and the layer's `cordis.patch.yml` inserts the `desktop-brand` row naming the package. The browser half:

- registers the `desktop-brand` locale namespace (`name`: 北冥 / Beiming) and occupies `sidebar.brand.name` with the name alone at 18px on the row's 24px line, leaving the weight to ui-sidebar, which sets 600 and lowers it to 400 under a Windows titlebar. `ui-brand-official` stays mounted; it registers only under the `official` client profile, which this application never builds.
- occupies `sidebar.brand.mark` with `FishLogo` from `@deepseek-ai/dsh-client-ui-primitives`, a shell platform module, at 1.25 times the owner's `size`. ui-sidebar passes 24 in the expanded row and in the collapsed rail, so the logo is 30px wide and 22px tall: inside the row's 24px identity box, which clips a logo wider than 32px, and inside the rail's 36px toggle.
- registers an entry that renders `null` under `settings.general.item` id `current-version` at priority -1, which shadows ui-settings-general's row at the default priority 0. List entries render without a wrapper element, so the row leaves no empty element, and General Settings' last-child rule removes the separator under the row that is now last.

The package's `build.ts` bundles both halves with esbuild in the closure-factory form the module loader consumes, requesting `PLATFORM_MODULES` from the shell's table. The half reads no `process.env` value, so the bundle substitutes none. It follows the vendored plugins' build rather than `packages/client/tsdown.client.ts`, whose preset resolves manifests under `packages/*/*` only.

The desktop package runs `pnpm run build` with `DSH_CLIENT_TITLE=北冥` (`apps/desktop-shell/scripts/client-build.ts`). It then reads the client build record, which must match the artifacts and name the title, and requires `apps/web/dist/index.html` to carry `<title>北冥</title>` (`assertDesktopClientTitle`) before it bundles desktop-app. `--skip-repo-build` goes through the same check and bundle.

## Alternatives considered

- **The desktop release version as `DSH_CLIENT_VERSION`.** `scripts/build.ts` replaces an inherited version, so this needs the package script to rerun the build steps itself. It also changes the `x-client-version` that `ui-settings-account` sends on DeepSeek Platform account calls.
- **A vendored `@haoran/dsh-desktop-brand` tarball.** It is the fork's usual route for browser code, and the half reads no build-time value, so a prebuilt bundle would render the same. The half stays in this package beside the `desktop-brand` row that mounts it, so one change edits both.
- **Larger sizes in ui-sidebar's own brand row.** The fallback mark size and `.brandName` font size are in `SidebarRoot.tsx` and its stylesheet, which are core.
- **The `official` client profile.** It registers the DeepSeek Harness wordmark and sets `DSH_CLIENT_TITLE=DeepSeek Harness`, an identity this product must not show.
- **Overriding `brand.localBuild` in the `common` dictionary.** It would give a per-language title and sidebar label without a slot occupant, but the locale registry rejects a second registration for the same namespace and locale.

## Consequences

- The window title is 北冥 in both languages. A per-language title needs `AppFrame` or the `common` dictionary to change, which is core.
- The collapsed rail's logo is 30px as well, in its 36px toggle: the occupant receives the same `size` at both call sites and cannot tell them apart. A Windows titlebar renders no rail logo.
- Settings → General shows no version. The update settings page shows `当前版本 {version}` from the shell's `app.getVersion()`, and only in a packaged launch, where the shell serves update state.
- A `dsh web` launch of the desktop profile from source needs `pnpm --filter @deepseek-ai/dsh-desktop-app run bundle` first, because the profile mounts the `desktop-brand` row.
- No recorded-session snapshot changes: the brand row, title, and settings rows are client chrome with no session event or model-visible input.

## Related

- [The desktop composition layer](2026-09-06-desktop-composition-layer-content-search.md), the package this note extends.
- [ui-brand-official](../../../../packages/client/ui-brand-official/README.md), the upstream occupant of the same slots.
