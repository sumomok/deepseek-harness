# Agent Note: macOS updates itself, signed by a certificate nobody trusts

Status: implemented

English | [中文](2026-08-19-macos-in-app-update-self-signed.zh.md)

## Problem

[The desktop update channel](2026-08-18-desktop-update-channel.md) installs on Windows and hands off on macOS: the macOS client detects a new version and opens the download in a browser, leaving the user to unzip an app and drag it over the old one. The reason recorded there was that Squirrel.Mac stages an update only for a signed app.

That reason is exact, and the mechanism underneath it is worth stating precisely, because it decides what a fix must produce. Squirrel accepts a replacement bundle only when the bundle satisfies the **running** app's designated requirement. An unsigned Electron build carries the ad-hoc signature the toolchain's linker leaves behind — `flags=0x20002(adhoc,linker-signed)`, `Sealed Resources=none` — whose designated requirement degrades to `cdhash H"…"`, naming one exact binary. No later build can ever satisfy it. A real signature makes the requirement `identifier "dev.dsh.desktop" and certificate root = H"<fingerprint>"`, which every build signed by the same certificate satisfies.

What blocked that was believed to be Apple's $99 Developer ID programme. It is not. The certificate travels inside the signature's CMS blob and is never looked up in a keychain on the machine being updated, so a **self-signed certificate that nobody has marked as trusted** produces a requirement Squirrel accepts. This was verified end to end with the certificate's keychain deleted and `trustd`'s cache killed.

## Decision

macOS installs updates in place, through `MacUpdater` against the same generic feed Windows uses, from builds signed by this product's own self-signed certificate.

### Signing runs from the afterPack hook, not from electron-builder

electron-builder cannot use this certificate. Its signing pass resolves an identity through `security find-identity -v -p codesigning`, and `-v` keeps only identities that pass trust evaluation — an untrusted self-signed certificate is reported `CSSMERR_TP_NOT_TRUSTED` and filtered out, so the builder finds nothing and skips signing.

`codesign` has no such rule. It signs with an untrusted identity and exits 0, and `codesign --verify --deep --strict` passes on the result. What it does require is that the keychain holding the identity be in the **user's keychain search list**: `--keychain` narrows that list rather than adding to it, so an identity in a keychain outside the list is `no identity found` however the signature is requested. That distinction is the whole of it, and it was previously misdiagnosed as a trust requirement.

`scripts/sign-mac.cjs` therefore creates a keychain per build, imports the PKCS#12, prepends the keychain to the user search list, signs, and restores the search list and deletes the keychain in a `finally`. `mac.identity: null` stays in `electron-builder.yml` so the builder's own pass never runs. The hook is `afterPack` rather than `afterSign`, for a mechanical reason: `doSignAfterPack` emits `afterSign` only when signing actually happened, so with a null identity that hook never fires. Nothing modifies the bundle between `afterPack` and the zip/dmg targets — `doAddElectronFuses` returns immediately without an `electronFuses` config, and there is none.

The identity is read from `~/Library/Application Support/dsh-desktop-signing/` by default, overridable with `DSH_MAC_SIGNING_P12` and `DSH_MAC_SIGNING_P12_PASSWORD`. A missing identity **fails the build**; `DSH_MAC_SIGN=0` is the explicit way to ask for an unsigned one. Silence there would be the expensive failure: an unsigned build published to the feed cannot replace the signed one already installed, and nothing would say so until an update stopped working.

The certificate is valid for 20 years. The designated requirement pins its fingerprint, so rotating it breaks the update chain for every installed client — the shipped certificate has to outlive the product rather than be renewed.

### Three tiers, chosen by one `existsSync`

`src/updater.ts` picks a path per check, and the first that holds is the one that runs:

1. **In place** — Windows always; macOS when the bundle is signed.
2. **Download page** — an unsigned macOS build keeps exactly the behavior it had, through the unchanged `checkGeneric`.
3. **Fallback** — an in-place path that fails while running drops to tier 2 for the rest of the run and re-runs the same check there, so one check still ends in one answer, rather than in an error box.

The signed/unsigned question is answered by `existsSync` on `Contents/_CodeSignature/CodeResources`: signing seals a bundle's resources and writes that file, and the ad-hoc linker signature writes nothing. A `codesign` subprocess would answer the same question, and this runs on every launch's first check.

The tier-3 demotion is deliberately blunt — a Squirrel refusal and a dropped connection demote alike, because telling them apart means matching on message text — and lasts only for the run.

### The dialogs stop being sheets on macOS

A parented `dialog.showMessageBox` is an NSAlert **sheet** on macOS, and a sheet ends when anything raises its parent window. `BrowserWindow.focus()` is enough, and Electron then reports button index 0 as if it had been clicked.

Every route back into the app calls `revealMainWindow()` — the Dock icon, a clicked notification, a second launch, the tray. Before this change that only mis-answered a hand-off dialog. With an in-place installer behind index 0 it means **clicking the Dock icon installs an update nobody agreed to**, which is the one thing [the update channel](2026-08-18-desktop-update-channel.md) promises cannot happen. Verified by hand: with the offer dialog open, `open -a` alone started the download.

`ask()` now passes no parent on macOS, where a parentless dialog is an app-modal alert panel that comes forward with the app and ends only on a button. Windows keeps the parented dialog and the reasoning that put it there — a parentless top-level window is one the shell may place behind whatever the user is working in.

### What the click costs, and where it goes

`update-downloaded` fires on macOS when electron-updater's own download finishes, not when the update is staged. Squirrel is handed the file at `quitAndInstall`, and with `autoInstallOnAppQuit` off — which this product keeps off, so nothing is staged before the user decides — everything after the click is on the click's clock:

| Segment | Measured |
|---|---|
| Click → server stopped (`prepareQuit`) | 0.06–0.54 s idle; bounded at 10 s by `STOP_TIMEOUT_MS` |
| Squirrel fetches the zip back from electron-updater's local proxy, unpacks it, validates the signature | 4.8–6.0 s idle, 28.8 s with the disk saturated |
| ShipIt swaps the bundles and relaunches | 8.7–12.5 s |
| **Click → new window** | **14.1, 16.0, 18.1 s idle; 42.2 s loaded** |

The middle segment is not the HTTP re-feed it looks like. Measured directly on the same artifact, `ditto -xk` of the 183 MB zip takes 3.0 s and `codesign --verify --deep --strict` of the 489 MB bundle takes 1.0 s; the transfer over loopback is a fraction of either. It is disk, and it scales with contention.

Most of that time the screen is bare, because ShipIt waits for every process of this bundle id to exit before it starts — so nothing of this app can be on screen to explain the wait. The install notice (`showInstalling`, in `progress-window.ts`) is put up **before** the teardown and says how long to expect and not to force-quit; the main window is hidden with it, since its server is about to go away. Windows gets neither, because the NSIS installer paints its own progress within a second of the same click.

### The rest

`blockOnMac` is gone. A mandatory update on macOS now does what Windows does — download without asking, then offer only 「重启安装」 — and the download-page block survives only for builds that cannot install in place.

`FEED_BASE` reads `DSH_UPDATE_FEED`, defaulting to the published feed. The point is not configurability: it is that the production URL is the module's only URL literal, so a local test endpoint cannot be committed by forgetting to undo an edit. A build shipped pointing at a machine-local address reports nothing and simply never finds an update again.

`publish-update.ts` uploads the blockmap for both channels, not just Windows. A differential download needs **two** blockmaps — the new build's, and the one belonging to the version the client is running — but fetches only the new one from the feed unconditionally: the old one is read from the client's own cache first and downloaded, at the URL electron-updater builds by substituting versions into the new artifact's name, only when that cached copy is gone. The feed's copy is therefore what a fresh install or a cleared cache falls back to; the script reports whether the version it replaces still has its blockmap, and keeps blockmaps far deeper than artifacts when it prunes ([feed retention](../process/2026-08-22-desktop-feed-retention.md)).

## Alternatives considered

**Apple Developer ID and notarization.** The correct answer for software given to other people: it satisfies Gatekeeper on first launch, which self-signing does not. It costs $99/year and an Apple account, and buys nothing this product needs — the update path validates against the certificate in the signature, not against Apple. The self-signed certificate can be replaced by a Developer ID one later, at the cost of one forced manual update, because the designated requirement pins the certificate root.

**Trusting the certificate on the build machine.** The obvious reading of `find-identity -v` failing, and the one an earlier investigation reached. It is wrong twice over: it requires a GUI authorization the build cannot perform, and it is unnecessary — the search-list experiment above shows `codesign` never consults trust settings.

**`--keychain` instead of mutating the search list.** Preferred, and it does not work: `codesign --keychain <path>` on a keychain outside the search list is `no identity found`, with the keychain unlocked. The search-list mutation is scoped to the signing step and restored in a `finally`; a hard kill can leave a stale entry pointing at a deleted file, which is untidy and inert.

**Signing inside-out, per Apple's guidance, instead of one `--deep` pass.** `--deep` is discouraged mainly because it applies one entitlement set to all nested code. Here that is what is wanted: every binary in this bundle takes the same three entitlements. One pass takes 3 s over 15,778 files and yields a bundle that passes the flags Squirrel validates with.

**Keeping `autoInstallOnAppQuit` off** costs the ~5 s of staging on the click's clock; turning it on would move that work to right after the download. It stays off because it is also what would let Squirrel pre-fetch, and a build that has staged an update is one step closer to installing one the user did not ask for. Revisit only with the invariant restated.

**Guarding `reveal()` instead of unparenting the dialogs.** Would leave the sheet in place and suppress the thing that dismisses it — but `reveal()` is the user asking to see the app, and every future caller would have to remember the rule. Unparenting removes the mechanism.

**A separate overlay process to cover the blackout.** Rejected on measurement, before this change: ShipIt waits for every process of the bundle id to exit, and an overlay carrying that id is on the list it waits for. It stretched the blackout from 12 s to 26 s.

## Consequences

An installed macOS client now updates itself, and the two platforms differ only in what the install looks like. The certificate is a 20-year commitment: its private key is the update chain, and losing it means every installed client needs a manual replacement, while leaking it means whoever holds it can produce a bundle those clients accept. It lives outside the checkout, and `apps/desktop/.gitignore` refuses the file types as a backstop.

Gatekeeper is unchanged: a self-signed, un-notarized app still needs a right-click open when a **browser** downloaded it. An update installed by Squirrel is not quarantined and needs nothing.

The hardened runtime is on, with electron-builder's own three entitlements (`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`). The bundled Node binary and the N-API addons under `Contents/Resources/` keep their own signatures — `--deep` treats them as resources and seals them by hash rather than re-signing them — which is why library validation has to be off.

## Testing

Verified against a local feed on `127.0.0.1`, with rc.13 installed from its published zip and rc.14 served as the update; the certificate was never trusted at any point.

Four full rc.13 → rc.14 runs completed: offer → progress window → install offer → install notice → automatic relaunch, with the installed bundle afterwards reporting `0.1.0-rc.14`, `satisfies its Designated Requirement`, and the same certificate root. The mandatory path was exercised with `minimumVersion` in the feed: the launch gate blocked, the download started without being asked for, and the install dialog offered one button. The unsigned tier was exercised on a real `DSH_MAC_SIGN=0` build, which took the download-page path. The failure tier was exercised by stopping the feed server: the check demoted with one log line, the launch gate opened, and no error dialog appeared.

The Dock-activation defect and its fix were verified the same way — `open -a` with the offer dialog open started the download before the fix and did nothing after it.

Not covered here: the manual 「检查更新」 menu item's 「无法检查更新」 dialog, whose code path this change does not touch; anything on Windows, which is unchanged apart from the shared updater construction; and any run against the published feed, which was deliberately left alone.
