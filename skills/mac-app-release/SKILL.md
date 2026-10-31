---
name: mac-app-release
description: Set up or fix releases for a Mac app — auto-updates (Sparkle or electron-updater), Developer ID signing, notarization, DMGs, update feeds, download pages, release workflows on GitHub Actions. Use whenever a Mac app needs to ship, update itself, be notarized, get a download link, or when a release/notarization/update feed is broken. Covers native Swift/AppKit apps (Xcode, xcodegen or SwiftPM + script) and Electron apps.
---

# Mac app releases

Every Mac app ships the same way. Don't hand-roll a release workflow, signing
script, update server or feed. Use the `apps` CLI, `apps.json` and the
reusable workflow in `Moulik-Budhiraja/app-hosting` (local checkout:
`~/Documents/programming/app-hosting`). `DESIGN.md` there is the full contract.

How a release works: you push a tag `v1.2.3` on main. The app's
`.github/workflows/release.yml` then calls `release-mac.yml`, which runs on the
`macos-ephemeral` runner. It builds the app, signs it with the Developer ID,
notarizes the app and the DMG, and runs `apps publish`. The remote serves:
- `<remote>/<app>/`: the download page, with the app's icon. The workflow takes the
  icon from the built app (`CFBundleIconFile` or `CFBundleIconName`), so give the app a
  real icon; without one the page shows its initial.
- `/download`: the latest DMG
- `/appcast.xml` (Sparkle) or `/latest-mac.yml` (electron-updater)

## Remotes

| Remote | URL | For |
| --- | --- | --- |
| `moulik` | `https://apps.moulik.dev` | personal apps |
| `proletic` | `https://apps.proletic.co` | Proletic products |

Each app lives on exactly one remote. Ask if it's unclear which one.

## Onboarding an app

1. **Remote and login (once per machine).** Run `apps remote list`. If the remote is
   missing, run `apps remote add <name> <url>`, then `apps login <name>`. The user
   types the admin token. Never ask for it in chat or echo it.
2. **Create.** In the app repo, run
   `apps create <app> --remote <name> --updater sparkle --kind native --title "Name"`.
   Use `--updater electron --kind electron` for an Electron app. This registers the
   app, keeps a new Sparkle key in the keychain, and writes `apps.json`.
3. **Fill in the `build` section of `apps.json`** (see "Build section" below).
4. **Wire the updater into the app** (see the Sparkle and Electron sections). The feed
   URL is `<remote url>/<app>/appcast.xml` for Sparkle, or the generic publish URL
   `<remote url>/<app>/` for Electron.
5. **Set up GitHub.** Run `apps init --repo owner/name`. It creates the `production`
   environment (release tags only), sets every secret, and writes
   `.github/workflows/release.yml`. The repo needs a remote on GitHub first.
   **Public repos:** `apps init` makes fork pull requests need approval before their
   workflows run. The runner on ralph also has to allowlist the repo, or the release job
   queues forever. Ask the user first, then add `"owner/name"` to `publicRepositories` in
   the `personal` source of `~/Library/Application Support/gh-actions-host-controller/app/config/config.json`
   on `ssh ralph`, and restart the controller with `pkill -f 'dist/cli.js serve'`
   (launchd starts it again).
6. **Dry run.** Run `DRY_RUN=1 ~/Documents/programming/app-hosting/scripts/mac/release-local.sh 0.0.1`
   from the repo on a clean commit. It builds and signs with the real Developer ID
   without notarizing or publishing. Fix what it reports.
7. **Release.** Commit, then run `git tag -a v1.2.3 -m "What changed"` on main and
   `git push origin v1.2.3`. The tag message becomes the release notes. Watch the run
   with `gh run watch`, then check with `apps status`.

Before tagging the first release, ask the user. Shipping is their call. After
that, follow whatever the repo or user has said about releasing.

## Build section

Native apps (Sparkle):
```json
"build": { "kind": "native", "command": "./scripts/build.sh", "app": "build/MyApp.app",
           "entitlements": "MyApp/MyApp.entitlements", "dmgName": "MyApp" }
```
- The command gets `VERSION` (1.2.3) and `BUILD` (100200300). It must write them into
  `CFBundleShortVersionString` and `CFBundleVersion`. The workflow checks both.
- It must leave an **unsigned or ad-hoc signed** `.app` at `app`. The workflow does all
  the real signing, nested code included. Don't sign with the Developer ID in the
  build script.
- `entitlements` is the outer app's entitlements, or `null`. Never use Debug builds:
  `get-task-allow` is refused.

Electron apps (electron-updater):
```json
"build": { "kind": "electron", "command": "npm ci && npx electron-builder --mac --publish never -c.extraMetadata.version=$VERSION",
           "dmg": "dist/MyApp-{version}.dmg", "zip": "dist/MyApp-{version}-mac.zip",
           "blockmap": "dist/MyApp-{version}-mac.zip.blockmap" }
```
- electron-builder signs and notarizes the app itself, using `CSC_KEYCHAIN`,
  `CSC_NAME` and `APPLE_API_KEY*`, which the workflow sets.
- The electron-builder config needs: `mac.target: [dmg, zip]`,
  `mac.hardenedRuntime: true`, `mac.notarize: true`, `artifactName` patterns that
  match the paths above, and
  `publish: { provider: generic, url: "<remote url>/<app>/" }`.
- The workflow notarizes and staples the DMG if electron-builder didn't.

Monorepo: set `"tagPrefix": "app/v"` and tag `app/v1.2.3`. If `apps.json` isn't at the
repo root, pass `with: { directory: path }` in `release.yml`.

## Adding Sparkle

The Info.plist needs:
- `SUFeedURL`: `<remote url>/<app>/appcast.xml`
- `SUPublicEDKey`: `apps create` and `apps init` print it
- `SUEnableAutomaticChecks`: true

Optionally add `SUAutomaticallyUpdate` set to true for silent updates. In code, keep a
strong reference to
`SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)`.
Menu-bar or LSUIElement apps should offer "Check for Updates…" somewhere, wired to
`checkForUpdates(_:)`.

- **Xcode or xcodegen projects.** Add the package
  `https://github.com/sparkle-project/Sparkle` (2.x). With xcodegen, add it under
  `packages:` and add `- package: Sparkle` to the target, which embeds by default.
  Build with
  `xcodebuild archive … CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=`
  and copy the `.app` out of the archive to the `app` path.
- **SwiftPM apps bundled by a script** (`swift build`, then assembling the `.app` by
  hand):
  - Add `.package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0")`
    and `.product(name: "Sparkle", package: "Sparkle")` to the target.
  - In the build script, copy the framework with symlinks intact:
    `ditto "$(swift build -c release <archs> --show-bin-path)/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"`
  - Add the rpath to the copied executable:
    `install_name_tool -add_rpath @executable_path/../Frameworks "$APP/Contents/MacOS/<exe>"`
  - Leave the final signing to the workflow. An ad-hoc `codesign --sign -` is fine for
    local runs.
  - Check with `otool -L` and by launching the built app before releasing.
- **Local and release builds must use the same build numbers.** Sparkle compares
  `CFBundleVersion`. If local builds use a timestamp or a counter, a local install
  outranks every release and never updates. Default `BUILD` to the release scheme
  (`apps build-number`) when it isn't set.
- **Apps that hold privacy permissions** (Accessibility, Screen Recording, and so on):
  macOS ties the grants to the designated requirement, which for a Developer ID app is
  the bundle ID plus the team ID. Keep both the same as the installed copy and the grants
  survive the switch to release builds and every update. Compare
  `codesign -d -r- <installed app>` with the release build's before shipping. An ad hoc
  build loses them.
- **Updates and long-running work.** `SUAutomaticallyUpdate` downloads silently and
  installs on quit. An app that mustn't restart mid-task (agents, recordings, servers)
  can return `true` from `updater(_:willInstallUpdateOnQuit:immediateInstallationBlock:)`
  and call the block once it's idle, and postpone "Install and Relaunch" with
  `updater(_:shouldPostponeRelaunchForUpdate:untilInvokingBlock:)`.

## Day-to-day commands

- `apps status`: the remote, the latest release, and whether the live feed matches.
- `apps releases`: list the app's releases.
- `apps withdraw 1.2.3`: pull a bad release from the feed and the download page.
  Installed copies keep it. To roll back, ship the fix (or reverted code) as a new,
  higher version. Feeds never go backwards.
- `apps restore 1.2.3`: undo a withdraw.
- `apps token create|list|revoke`: CI publish tokens. Re-run `apps init` to rotate the
  token in GitHub.
- `apps icon icon.png`: set the download page's icon without a release. Make the PNG
  from an app with `scripts/mac/app-icon.sh <App.app> icon.png`.

## When something breaks

- **"A timestamp was expected but was not found", or notarytool network errors.** The
  scripts already retry 3 times. If the run still fails, run `gh run rerun --failed`.
- **Notarization ends as "Invalid".** The workflow prints Apple's log. The usual causes
  are an unsigned nested binary, a missing hardened runtime, `get-task-allow`, or a
  binary added after signing. Fix the build rather than the signing scripts, unless the
  scripts are wrong for every app.
- **"The build command didn't produce …" or a version mismatch.** Check the build paths
  in `apps.json` and that the build uses `$VERSION` and `$BUILD`.
- **Publish fails with 422 on the Sparkle signature.** The `SPARKLE_PRIVATE_KEY` secret
  doesn't match the app's public key. Re-run `apps init`.
- **"Already published" notice.** That version is live (maybe from a local release),
  so the run did nothing. Bump the version.
- **Stuck queued on a public repo.** `ssh ralph 'tail ~/Library/Logs/dev.moulik.gh-actions-controller.out.log'`
  shows `reason: repo-not-private`. Allowlist the repo (step 5), then
  `gh run cancel <id>` and `gh run rerun <id>`, because the controller doesn't pick up
  jobs that were queued before.
- **Runner down or stuck queued.** Release from a Mac with the same steps: run
  `~/Documents/programming/app-hosting/scripts/mac/release-local.sh 1.2.3` from the app repo
  on a clean commit on main. It needs `~/.config/predictor-release`, `APPLE_ISSUER_ID`
  (or `appleIssuerId` in `~/.config/apps/config.json`) and `apps login` for the remote.
  Then push the tag. The workflow sees the version is out and stops.
- **The feed check fails after publishing.** Check `curl <remote>/<app>/appcast.xml`,
  then DNS and the proxy for the remote.

## Rules

- Everything goes through `apps.json` and `release-mac.yml`. If an app needs something
  the standard can't do, change the shared tooling in `Moulik-Budhiraja/app-hosting`, test
  it, and update `DESIGN.md`. Don't fork a copy into the app.
- If `release.yml` pins `uses: …@<ref>`, pass the same ref as `with: { tooling-ref: <ref> }`.
- Never print, log, commit or paste secrets: certificates, passwords, API keys, Sparkle
  private keys, tokens. Pipe them straight into `gh secret set` or environment
  variables.
- Never move or reuse a release tag. Fix forward with a new version.
