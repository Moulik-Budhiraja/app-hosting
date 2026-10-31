# app-hosting

One standard way to build, sign, notarize and ship auto-updating Mac apps,
native (Sparkle) or Electron (electron-updater).

- `server/` is the update host. One copy runs per remote and serves the update feed,
  downloads and a download page for each app.
- `cli/` is the `apps` command. It manages remotes (like git) and apps, and publishes
  releases.
- `.github/workflows/release-mac.yml` is the reusable release workflow. It builds,
  signs, notarizes and publishes on the self-hosted `macos-ephemeral` runner.
- `scripts/mac/` holds the signing, notarizing, DMG and verification scripts that the
  workflow and local releases use.
- `skills/mac-app-release/` is the agent skill for setting apps up this way.

[DESIGN.md](DESIGN.md) is the contract that all of these follow.

## Remotes

| Remote | URL |
| --- | --- |
| `moulik` | https://apps.moulik.dev |
| `proletic` | https://apps.proletic.co |

Each app lives on one remote, at `<remote>/<app>/`. The feed is `appcast.xml` or
`latest-mac.yml`, `/download` gives the latest DMG, and `/` is the download page.

## Onboarding an app

```sh
apps remote add moulik https://apps.moulik.dev && apps login moulik   # once per machine
cd my-app
apps create my-app --remote moulik --updater sparkle --kind native --title "My App"
# fill in apps.json "build", and add SUFeedURL / SUPublicEDKey to the app
apps init --repo Moulik-Budhiraja/my-app     # GitHub environment, secrets, release.yml
git tag -a v1.0.0 -m "First release" && git push origin v1.0.0
```

To check a build without shipping it, run
`DRY_RUN=1 scripts/mac/release-local.sh 0.0.1` from the app repo. It builds and signs
the app but doesn't notarize or publish it. Leave out `DRY_RUN` to release from your
Mac when the runner is down.

## Lint

```sh
shellcheck -x scripts/mac/*.sh
actionlint
```
