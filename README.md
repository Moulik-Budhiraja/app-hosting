# app-hosting

One standard way to build, sign and ship auto-updating desktop apps for macOS and
Windows: native apps (Sparkle on macOS, WinSparkle on Windows) or Electron
(electron-updater on both).

- `server/` is the update host. One copy runs per remote and serves the update feeds,
  downloads and a download page for each app.
- `cli/` is the `apps` command. It manages remotes (like git) and apps, and publishes
  releases.
- `.github/workflows/release-mac.yml` and `release-windows.yml` are the reusable release
  workflows, one per platform. The Mac one builds, signs, notarizes and publishes on the
  self-hosted `macos-ephemeral` runner. The Windows one builds, signs with Azure
  Artifact Signing and publishes on a Windows runner.
- `actions/release-mac` and `actions/release-windows` hold the steps those workflows run.
  Repos owned by another account, such as Proletic, call these actions from their own
  jobs, because `secrets: inherit` doesn't pass secrets to another owner's workflow.
  Those jobs pass each secret as its own input (`apps-token`, `azure-*`, `apple-*`), and
  build-time secrets as `build-env` lines; never the whole `toJSON(secrets)`.
- `scripts/common/` reads `apps.json`, checks tags and hands build secrets to the build
  for both workflows. `tagPrefix` in `apps.json` can be one prefix or a list, such as
  `["v", "win-v"]`; a tag matching any of them releases.
  `scripts/mac/` holds the signing, notarizing, DMG and verification scripts, and
  `scripts/windows/` the build and signing scripts for Windows.
- `skills/mac-app-release/` is the agent skill for setting apps up this way, on either
  platform.

[DESIGN.md](DESIGN.md) is the contract that all of these follow.

## Remotes

| Remote | URL |
| --- | --- |
| `moulik` | https://apps.moulik.dev |
| `proletic` | https://apps.proletic.co |

Each app lives on one remote, at `<remote>/<app>/`, and ships for macOS, Windows or
both. Its feeds are `appcast.xml` and `appcast-windows.xml` (native apps) or
`latest-mac.yml` and `latest.yml` (Electron). `/download` gives the latest DMG or
installer for the visitor's platform, and `/` is the download page.

## Onboarding an app

```sh
apps remote add moulik https://apps.moulik.dev && apps login moulik   # once per machine
cd my-app
apps create my-app --remote moulik --updater sparkle --kind native --title "My App" \
  --platforms mac,windows
# fill in apps.json "builds", and point Sparkle / WinSparkle at the feeds
apps init --repo Moulik-Budhiraja/my-app     # GitHub environment, secrets, release.yml
git tag -a v1.0.0 -m "First release" && git push origin v1.0.0
```

One tag releases every platform in `builds`. Each platform publishes on its own, so
one failing doesn't hold back the other. Windows signing needs an Azure Artifact
Signing account first; the skill walks through it.

To check a Mac build without shipping it, run
`DRY_RUN=1 scripts/mac/release-local.sh 0.0.1` from the app repo. It builds and signs
the app but doesn't notarize or publish it. Leave out `DRY_RUN` to release from your
Mac when the runner is down.

## Lint

```sh
shellcheck -x scripts/common/*.sh scripts/mac/*.sh
actionlint
```
