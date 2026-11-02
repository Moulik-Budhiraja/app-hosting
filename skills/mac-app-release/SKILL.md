---
name: mac-app-release
description: Set up or fix releases for a Mac or Windows desktop app — auto-updates (Sparkle, WinSparkle or electron-updater), Developer ID signing and notarization, Windows code signing with Azure Artifact Signing, DMGs and Windows installers (NSIS, .exe, .msi), update feeds, download pages, release workflows on GitHub Actions. Use whenever a Mac or Windows app needs to ship, update itself, be signed or notarized, get a download link, or when a release, signature or update feed is broken. Covers native Swift/AppKit apps (Xcode, xcodegen or SwiftPM + script), native Windows apps with WinSparkle, and Electron apps on both platforms.
---

# Mac and Windows app releases

Every desktop app ships the same way. Don't hand-roll a release workflow, signing
script, update server or feed. Use the `apps` CLI, `apps.json` and the
reusable workflows in `Moulik-Budhiraja/app-hosting` (local checkout:
`~/Documents/programming/app-hosting`). `DESIGN.md` there is the full contract.

How a release works: you push a tag `v1.2.3` on main. The app's
`.github/workflows/release.yml` then runs a job per platform in `apps.json`:
- The Mac job runs on the `macos-ephemeral` runner. It builds the app, signs it with
  the Developer ID, notarizes the app and the DMG, and runs `apps publish`.
- The Windows job runs on a Windows runner. It builds the installer, signs it with
  Azure Artifact Signing, and runs `apps publish --platform windows`.

The steps live in the composite actions `actions/release-mac` and
`actions/release-windows`. How `release.yml` reaches them depends on who owns the repo,
and `apps init` writes the right form:
- **Repos owned by `Moulik-Budhiraja`** call the reusable workflows
  `release-mac.yml` and `release-windows.yml` with `secrets: inherit`. They wrap the
  actions.
- **Repos owned by anyone else (`Proletic/*` and every app on the `proletic` remote)**
  must run the actions in their own jobs. `secrets: inherit` doesn't pass secrets to
  another owner's reusable workflow, and neither do environment secrets: the called job
  gets only `github_token`. The job declares `runs-on`, `environment: production`,
  `timeout-minutes: 90` and its concurrency group, and passes each secret the action
  uses as its own input, so the action never sees the repo's other secrets:
  ```yaml
  windows:
    runs-on: [self-hosted, windows]
    environment: production
    timeout-minutes: 90
    concurrency:
      group: release-windows-${{ github.repository }}
      cancel-in-progress: false
    steps:
      - uses: Moulik-Budhiraja/app-hosting/actions/release-windows@main
        with:
          apps-token: ${{ secrets.APPS_TOKEN }}
          sparkle-private-key: ${{ secrets.SPARKLE_PRIVATE_KEY }}   # Sparkle apps only
          azure-tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          azure-client-id: ${{ secrets.AZURE_CLIENT_ID }}
          azure-client-secret: ${{ secrets.AZURE_CLIENT_SECRET }}
          azure-signing-endpoint: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
          azure-signing-account: ${{ secrets.AZURE_SIGNING_ACCOUNT }}
          azure-signing-profile: ${{ secrets.AZURE_SIGNING_PROFILE }}
          azure-signing-publisher: ${{ secrets.AZURE_SIGNING_PUBLISHER }}
  ```
  The Mac job uses `runs-on: [self-hosted, macos-ephemeral]`, `actions/release-mac`,
  and `apple-certificate-base64`, `apple-certificate-password`, `apple-api-key-base64`,
  `apple-key-id` and `apple-issuer-id` in place of the `azure-*` inputs. Never pass
  `${{ toJSON(secrets) }}`: the old `secrets` input still works with a deprecation
  warning, but it hands the action every secret, and GitHub's malicious-workflow check
  held a run that did it.

`directory` works the same in both forms. Build secrets go in `build-secrets` (names)
on the reusable workflows and in `build-env` (values) on the actions; see "Build-time
secrets" below. `tooling-ref` and `runs-on` are reusable-workflow inputs. With the
actions, the ref after `@` picks the tooling and the job sets `runs-on`.

The jobs publish on their own into the same release, so a failed Windows build doesn't
hold back the Mac one; re-run it and it joins the release. The remote serves:
- `<remote>/<app>/`: the download page for the visitor's platform, with the app's icon.
  The Mac workflow takes the icon from the built app (`CFBundleIconFile` or
  `CFBundleIconName`), so give the app a real icon; without one the page shows its initial.
- `/download`: the latest DMG or installer for the visitor's platform
  (`/download/mac`, `/download/windows` for a specific one)
- feeds: `/appcast.xml` (Sparkle) and `/appcast-windows.xml` (WinSparkle), or
  `/latest-mac.yml` and `/latest.yml` (electron-updater)

## Remotes

| Remote | URL | For |
| --- | --- | --- |
| `moulik` | `https://apps.moulik.dev` | personal apps |
| `proletic` | `https://apps.proletic.co` | Proletic products |

Each app lives on exactly one remote. Ask if it's unclear which one.

Websites (a landing page, a changelog) read an app's releases from the remote's public
JSON, which allows any origin (CORS `*`) and needs no token:
- `GET <remote>/<app>/app.json`: title, icon URL, page, download and feed URLs, platforms.
- `GET <remote>/<app>/latest.json`: the latest release per platform, or one with `?platform=mac|windows`.
- `GET <remote>/<app>/releases/<version>.json`: one release.
- `GET <remote>/<app>/releases.json?limit=N&before=<version>`: pages newest first.
  Follow `next` (also in the `Link` header) until it's null.

For a download button, link to `<remote>/<app>/download` (the visitor's platform) or
`download/mac` / `download/windows`. Never use `/api` or a token from a website.

## Onboarding an app

1. **Remote and login (once per machine).** Run `apps remote list`. If the remote is
   missing, run `apps remote add <name> <url>`, then `apps login <name>`. The user
   types the admin token. Never ask for it in chat or echo it.
2. **Create.** In the app repo, run
   `apps create <app> --remote <name> --updater sparkle --kind native --title "Name"`.
   Use `--updater electron --kind electron` for an Electron app, and
   `--platforms mac,windows` (or `windows`) for Windows. This registers the app, keeps a
   new Sparkle key in the keychain (it signs WinSparkle updates too), and writes
   `apps.json`.
3. **Fill in `builds` in `apps.json`** (see "Builds" below).
4. **Wire the updater into the app** (see the Sparkle, WinSparkle and Electron
   sections).
5. **Windows signing (once per machine).** See "Windows signing" below.
6. **Set up GitHub.** Run `apps init --repo owner/name`. It creates the `production`
   environment (release tags only), sets the secrets for each platform, and writes
   `.github/workflows/release.yml`. The repo needs a remote on GitHub first.
   **Public repos:** `apps init` makes fork pull requests need approval before their
   workflows run. The runner on ralph also has to allowlist the repo, or the Mac release
   job queues forever. Ask the user first, then add `"owner/name"` to `publicRepositories` in
   the `personal` source of `~/Library/Application Support/gh-actions-host-controller/app/config/config.json`
   on `ssh ralph`, and restart the controller with `pkill -f 'dist/cli.js serve'`
   (launchd starts it again). A public repo with a Windows build also has to be on the
   Windows runner controller's public-repo allowlist; ask the user to add it.
7. **Dry run (Mac).** Run `DRY_RUN=1 ~/Documents/programming/app-hosting/scripts/mac/release-local.sh 0.0.1`
   from the repo on a clean commit. It builds and signs with the real Developer ID
   without notarizing or publishing. Fix what it reports. There's no Windows dry run
   yet; on a Windows machine, `pwsh scripts/windows/build-release.ps1` with `VERSION`,
   `BUILD` and the `AZURE_*` variables set builds and signs without publishing.
8. **Release.** Commit, then run `git tag -a v1.2.3 -m "What changed"` on main and
   `git push origin v1.2.3`. The tag message becomes the release notes. Watch the run
   with `gh run watch`, then check with `apps status`.

Before tagging the first release, ask the user. Shipping is their call. After
that, follow whatever the repo or user has said about releasing.

## Builds

`builds` has a section per platform. An older `apps.json` with a top-level `build` is
the Mac build; `apps.json` can't have both.

Mac, native (Sparkle):
```json
"mac": { "kind": "native", "command": "./scripts/build.sh", "app": "build/MyApp.app",
         "entitlements": "MyApp/MyApp.entitlements", "dmgName": "MyApp" }
```
- The command gets `VERSION` (1.2.3) and `BUILD` (100200300). It must write them into
  `CFBundleShortVersionString` and `CFBundleVersion`. The workflow checks both.
- It must leave an **unsigned or ad-hoc signed** `.app` at `app`. The workflow does all
  the real signing, nested code included. Don't sign with the Developer ID in the
  build script.
- `entitlements` is the outer app's entitlements, or `null`. Never use Debug builds:
  `get-task-allow` is refused.

Mac, Electron (electron-updater):
```json
"mac": { "kind": "electron", "command": "npm ci && npm version \"$VERSION\" --no-git-tag-version --allow-same-version && npx electron-builder --mac --publish never --config electron-builder.config.js",
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

Windows commands run in PowerShell 7, so they read `$env:VERSION` and `$env:BUILD`.

Windows, native (WinSparkle):
```json
"windows": { "kind": "native", "command": "./scripts/build.ps1",
             "installer": "build/MyApp-Setup-{version}.exe", "minimumSystemVersion": "10.0",
             "icon": "assets/icon.png" }
```
- The command builds the app and its installer (`.exe` or `.msi`; Inno Setup, WiX,
  NSIS) and leaves it at `installer`. The installer's `ProductVersion`, when set, must
  start with the version.
- Sign the app's own `.exe` and `.dll` files before packaging them:
  `pwsh -File $env:APPS_SIGN_SCRIPT build\MyApp.exe build\Helper.dll`. The workflow
  signs the installer itself if it isn't signed yet.
- `minimumSystemVersion` and `icon` are optional. The icon (a PNG) only matters for
  Windows-only apps; Mac releases set it from the app.

Windows, Electron (electron-updater, NSIS):
```json
"windows": { "kind": "electron", "command": "npm ci; npm version $env:VERSION --no-git-tag-version --allow-same-version; npx electron-builder --win nsis --publish never --config electron-builder.config.js",
             "installer": "dist/MyApp-Setup-{version}.exe", "blockmap": "dist/MyApp-Setup-{version}.exe.blockmap" }
```
- electron-builder must sign everything itself, with `win.azureSignOptions` read from
  the environment, so the config has to be JS (`electron-builder.config.js`), passed
  with `--config electron-builder.config.js` (see the electron-builder 26 notes below):
  `azureSignOptions: { publisherName: process.env.AZURE_SIGNING_PUBLISHER, endpoint: process.env.AZURE_SIGNING_ENDPOINT, codeSigningAccountName: process.env.AZURE_SIGNING_ACCOUNT, certificateProfileName: process.env.AZURE_SIGNING_PROFILE }`.
  The workflow refuses an unsigned Electron installer instead of signing it, because
  that would break the blockmap and leave the app inside unsigned.
- `nsis.artifactName` must match `installer`, such as `${productName}-Setup-${version}.${ext}`.
  The blockmap is the installer's name plus `.blockmap`.
- Same `publish: { provider: generic, url: "<remote url>/<app>/" }` as on Mac;
  electron-updater reads `latest.yml` on Windows.

electron-builder 26 notes, from release runs on the Windows pool. They apply on macOS too:
- `-c.extraMetadata.version=...` is read as a config path. Set the version with
  `npm version <version> --no-git-tag-version --allow-same-version` before the build,
  or with `--config.extraMetadata.version=...`. The examples above use `npm version`
  because they also pass `--config <file>`.
- It doesn't load `electron-builder.config.js` on its own. Pass it with
  `--config electron-builder.config.js`. Without it the build is unsigned and uses the
  default artifact name, so the paths in `apps.json` don't match.

Tag prefixes: `tagPrefix` can be a list, such as `["v", "win-v"]`. A tag matching any of them
releases, and the longest prefix the tag starts with gives the version, so `v0.7.28` and
`win-v0.7.28` both mean 0.7.28. To keep a platform-only prefix, split `release.yml`:
the Mac workflow triggers on `v*`, the Windows one on `v*` and `win-v*`. Then `v1.2.3`
releases both platforms from one commit with the same version, and `win-v1.2.3` releases
Windows only. `apps init` adds an environment tag rule for every prefix.

Monorepo: set `"tagPrefix": "app/v"` and tag `app/v1.2.3`. If `apps.json` isn't at the
repo root, pass `with: { directory: path }` to each job in `release.yml` (to the action's
step in the composite-action form).

Build-time secrets: if `command` needs a secret, such as an OAuth client file the app
bundles, put it in the repo's `production` environment and pass it on each platform's
job that needs it:
- Reusable workflows: `with: { build-secrets: GOOGLE_OAUTH_CLIENT_BASE64 }`, names
  separated by spaces or commas.
- Actions: `build-env`, one `NAME=${{ secrets.NAME }}` line each. A value that can hold
  a newline needs the `NAME<<DELIMITER` form: that line, the value, then a line holding
  only `DELIMITER`.

The build step gets each one as an environment variable of the same name and never sees
the other secrets. The run fails before building if a listed secret isn't set, or if a name would
replace a variable the workflow sets (`VERSION`, `BUILD`, `AZURE_*`, `APPLE_*`). For
`release-local.sh`, export the variables in the shell first.

## Windows signing

Windows installers are signed with Azure Artifact Signing (formerly Trusted Signing),
about $10 a month. Set it up once, with the user, in the Azure portal:
1. An Artifact Signing account in a subscription. Note its endpoint, such as
   `https://eus.codesigning.azure.net/`, and name.
2. Identity validation (individuals: US and Canada only). It takes a few days.
3. A Public Trust certificate profile. Its subject name is the publisher Windows shows.
4. An Entra app registration with a client secret, given the "Artifact Signing
   Certificate Profile Signer" role on the account.
5. `~/.config/predictor-release/azure-signing.json`:
   `{"tenantId","clientId","clientSecret","endpoint","account","profile","publisher"}`.
   `apps init` turns it into the `AZURE_*` secrets. Never paste its contents in chat.

Signatures are timestamped, so they stay valid after the 3-day certificate expires.
Nothing needs re-signing.

The Windows job runs on `[self-hosted, windows]` by default: a fresh Windows 11 x64
Hyper-V VM per job on the user's Windows machine, deleted afterwards. It has Git,
PowerShell 7, VS 2022 Build Tools, the .NET SDK, the Windows SDK and the Artifact
Signing client tools. It serves private repos under Moulik-Budhiraja and Proletic, and
public repos only from its controller's allowlist (ask the user to add the repo). Pass
`with: { runs-on: '"windows-latest"' }` in `release.yml` to use GitHub's hosted runner
(with the action, set the job's `runs-on: windows-latest`).
Any runner needs Git for Windows (its `bash` first on PATH, not WSL's) and PowerShell 7;
the workflow sets up Node 24 and the .NET 8 runtime that signing needs.

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


## Adding WinSparkle

Use WinSparkle 0.8 or later (`https://github.com/vslavik/winsparkle`), which checks
Ed25519 signatures. Before `win_sparkle_init()`, call:
- `win_sparkle_set_appcast_url("<remote url>/<app>/appcast-windows.xml")`
- `win_sparkle_set_eddsa_public_key("<SUPublicEDKey>")`: the same public key as the Mac
  app; `apps create` and `apps init` print it

and `win_sparkle_cleanup()` on exit. WinSparkle compares the feed's version with the
app's, so the app must report `X.Y.Z`: set `FileVersion` in its VERSIONINFO resource
from `$env:VERSION`, or pass it to `win_sparkle_set_app_details`. Offer "Check for
Updates…" wired to `win_sparkle_check_update_with_ui()`. WinSparkle runs the downloaded
installer, so the installer must close the running app (or the app must quit through
`win_sparkle_set_shutdown_request_callback`) and upgrade in place.

## Day-to-day commands

- `apps status`: the remote, and for each platform the latest release and whether the
  live feed matches.
- `apps releases`: list the app's releases and their platforms.
- `apps withdraw 1.2.3`: pull a bad release, on every platform, from the feeds and the
  download page. Installed copies keep it. To roll back, ship the fix (or reverted code)
  as a new, higher version. Feeds never go backwards.
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
  in `apps.json` and that the build uses `VERSION` and `BUILD`.
- **Publish fails with 422 on the Sparkle signature.** The `SPARKLE_PRIVATE_KEY` secret
  doesn't match the app's public key. Re-run `apps init`.
- **"Already published" notice.** That version is live for that platform (maybe from a
  local release), so the job did nothing. Bump the version.
- **Windows signing fails with 403 or "no credential".** Check the `AZURE_*` secrets,
  that the client secret hasn't expired, and that the app registration has the signer
  role on the account. Missing `.NET 8` means the setup-dotnet step didn't run.
- **"build-secrets: X isn't set" or "build-env gives X an empty value".** The secret is
  missing from the repo's `production` environment, or `release.yml` doesn't pass it
  (`secrets: inherit` for the reusable workflows, the `build-env` line for the action).
- **"build-env line N isn't NAME=value".** A multi-line secret is in the `NAME=value`
  form. Use `NAME<<DELIMITER`.
- **"APPS_TOKEN didn't reach the release job", or every secret empty.** A repo owned by
  another account than `Moulik-Budhiraja` is calling the reusable workflow, which gets
  no secrets across owners. Switch `release.yml` to the composite-action form above.
  In that form, check the job has `environment: production` and passes `apps-token`.
- **"isn't signed" for an Electron installer.** The command doesn't pass
  `--config electron-builder.config.js`, or `win.azureSignOptions` is missing or doesn't
  read the `AZURE_SIGNING_*` variables. A wrong artifact name has the same first cause.
- **Windows job stuck queued.** No runner has the labels in `runs-on`, or the repo is
  public and not on the Windows controller's allowlist. Ask the user to check the pool
  or allowlist the repo, or pass `runs-on: '"windows-latest"'`.
- **Stuck queued on a public repo (Mac).** `ssh ralph 'tail ~/Library/Logs/dev.moulik.gh-actions-controller.out.log'`
  shows `reason: repo-not-private`. Allowlist the repo (step 6), then
  `gh run cancel <id>` and `gh run rerun <id>`, because the controller doesn't pick up
  jobs that were queued before.
- **Mac runner down or stuck queued.** Release from a Mac with the same steps: run
  `~/Documents/programming/app-hosting/scripts/mac/release-local.sh 1.2.3` from the app repo
  on a clean commit on main. It needs `~/.config/predictor-release`, `APPLE_ISSUER_ID`
  (or `appleIssuerId` in `~/.config/apps/config.json`) and `apps login` for the remote.
  Then push the tag. The Mac job sees the version is out and stops; the Windows job
  still runs.
- **The feed check fails after publishing.** Check `curl <remote>/<app>/appcast.xml`
  (or the platform's feed), then DNS and the proxy for the remote.

## Rules

- Everything goes through `apps.json`, `release-mac.yml` and `release-windows.yml`. If
  an app needs something the standard can't do, change the shared tooling in
  `Moulik-Budhiraja/app-hosting`, test it, and update `DESIGN.md`. Don't fork a copy
  into the app.
- If `release.yml` pins a reusable workflow at `@<ref>`, pass the same ref as
  `with: { tooling-ref: <ref> }`. The actions need no such input.
- Never point a repo outside `Moulik-Budhiraja` at the reusable workflows. Its release
  job would get no secrets.
- Never print, log, commit or paste secrets: certificates, passwords, API keys, Azure
  client secrets, Sparkle private keys, tokens. Pipe them straight into `gh secret set`
  or environment variables.
- Never move or reuse a release tag. Fix forward with a new version.
