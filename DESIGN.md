# app-hosting: design and contracts

One standard way to build, sign, notarize and ship auto-updating Mac apps.
The server, CLI, workflow and skill in this repo all follow this file. If you
change a contract here, change every part that uses it.

## Pieces

- `server/`: the update host. One copy runs per **remote**:
  - `moulik` at `https://apps.moulik.dev`, on hp
  - `proletic` at `https://apps.proletic.co`, on rs
  It serves update feeds, downloads and a download page, and takes authenticated
  uploads. Node 24, no runtime dependencies, TypeScript run directly by Node
  (erasable syntax only: no enums, no parameter properties, `.ts` import suffixes).
- `cli/`: the `apps` command. It knows several remotes, like git, and is logged in to
  each one separately. Node ≥ 22, compiled with `tsc` to `dist/`.
- `.github/workflows/release-mac.yml`: a reusable workflow that apps call on a release
  tag. It uses `scripts/mac/*.sh`.
- `skills/mac-app-release/SKILL.md`: tells agents to use all of the above instead of
  building release setups by hand.

## Words

- **remote**: one server, such as `moulik` or `proletic`.
- **app**: a name unique on its remote, matching `^[a-z0-9][a-z0-9-]{1,39}$`. Each app
  lives on exactly one remote. Reserved names: `api`, `healthz`, `assets`, `download`.
- **updater**: `sparkle` (native Swift/AppKit apps) or `electron` (electron-updater).
- **version**: `X.Y.Z`, three numeric parts. **build**: an integer that rises with the
  version. The default is `X*100000000 + Y*100000 + Z*100` (1.2.3 is 100200300), the
  same scheme hobola uses. Sparkle compares builds, and electron-updater compares versions.

## `apps.json` (committed at the app repo root)

```json
{
  "app": "screen-draw",
  "remote": { "name": "moulik", "url": "https://apps.moulik.dev" },
  "updater": "sparkle",
  "tagPrefix": "v",
  "build": {
    "kind": "native",
    "command": "./scripts/build.sh",
    "app": "build/ScreenDraw.app",
    "entitlements": null,
    "dmgName": "ScreenDraw"
  }
}
```

- `tagPrefix` defaults to `"v"`. A monorepo can use `"app/v"`, in which case the tag
  `app/v1.2.3` releases 1.2.3.
- `build.kind: "native"`: the workflow runs `build.command` with `VERSION` and `BUILD`
  set. The command must leave an **unsigned or ad-hoc signed** `.app` at `build.app`.
  The workflow then signs it (nested code inside-out, hardened runtime, timestamp,
  optional `build.entitlements` on the outer app), notarizes and staples it, wraps it in
  `<dmgName>-<version>.dmg` with an /Applications link, signs, notarizes and staples the
  DMG, and publishes.
- `build.kind: "electron"`: the workflow runs `build.command` with `VERSION`, `BUILD`
  and electron-builder's signing variables (`CSC_KEYCHAIN`, `CSC_NAME`,
  `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) set. The command must sign
  and notarize the app itself (electron-builder `mac.notarize: true`) and leave the
  files at `build.dmg`, `build.zip` and optionally `build.blockmap`. Those fields can use
  `{version}`. The workflow notarizes and staples the DMG if it isn't stapled yet,
  verifies everything, and publishes.

## Server

Environment:
- `APPS_PUBLIC_URL`: for example `https://apps.moulik.dev`, with no trailing slash.
- `APPS_REMOTE_NAME`: for example `moulik`. Shown on pages.
- `APPS_ADMIN_TOKEN`: the admin bearer token, 32+ characters.
- `APPS_DATA_DIR`: default `/data`.
- `APPS_PORT`: default `3000`.
- `APPS_HOST_ALIASES`: optional, for example `notes.proletic.co=hobola,agent.proletic.co=proactive-agent`.
  A request whose Host is an alias is served as if its path were under `/<app>`, so
  `notes.proletic.co/appcast.xml` is `/hobola/appcast.xml`. API routes keep working.

Data layout (`APPS_DATA_DIR`):
```
apps/<app>/app.json                    {name,title,updater,sparklePublicKey?,createdAt}
apps/<app>/releases/<version>/<files>  immutable once committed
apps/<app>/releases/<version>/release.json   written last, by rename
tokens.json                            [{id,hash,app,label,createdAt}] publish tokens (sha256 of token)
uploads/<uploadId>/                    staging, removed after commit or 6h
```
Feeds are built in memory from the `release.json` files, so there's no feed file that
could go stale. Writes to one app go through a per-app lock. Every JSON write goes to a
temporary file followed by a rename.

`release.json`:
```json
{ "version": "1.2.3", "build": 100200300, "notes": "markdown", "publishedAt": "ISO",
  "minimumSystemVersion": "13.0", "withdrawn": false,
  "edSignature": "base64 (sparkle only)",
  "files": [ { "name": "ScreenDraw-1.2.3.dmg", "role": "dmg", "size": 1, "sha256": "hex", "sha512": "base64" } ] }
```
File roles: `dmg` is required for both updaters. For Sparkle the DMG is also the update
archive. `zip` is the electron update archive, required for electron. `blockmap` is
optional for electron and must be named `<zip name>.blockmap`.

### Public routes

| Route | What |
| --- | --- |
| `GET /healthz` | `{"ok":true,"remote":"moulik"}` |
| `GET /` | HTML list of apps |
| `GET /<app>/` | HTML download page: title, latest version, date, size, notes, Download button |
| `GET /<app>/download` | 302 to the latest non-withdrawn DMG |
| `GET /<app>/appcast.xml` | Sparkle feed (sparkle apps only), newest first |
| `GET /<app>/latest-mac.yml` | electron-updater feed (electron apps only) |
| `GET /<app>/releases/<version>/<file>` | artifact, with `Content-Length`, `ETag` and Range support |
| `GET /<app>/releases.json` | public JSON **array** of live releases (withdrawn ones are left out): version, build, publishedAt, notes, files |

Withdrawn releases leave the feeds, the download page and `/download`, but their files
still serve. Unknown app or path returns 404.

Sparkle item:
```xml
<item>
  <title>1.2.3</title>
  <pubDate>RFC 822</pubDate>
  <sparkle:version>100200300</sparkle:version>
  <sparkle:shortVersionString>1.2.3</sparkle:shortVersionString>
  <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
  <description><![CDATA[notes as simple, escaped HTML]]></description>
  <enclosure url="<public>/<app>/releases/1.2.3/<dmg>" length="N" type="application/octet-stream" sparkle:edSignature="..."/>
</item>
```
`latest-mac.yml` (only the newest non-withdrawn release, URLs relative to `/<app>/`):
```yaml
version: 1.2.3
files:
  - url: releases/1.2.3/App-1.2.3-mac.zip
    sha512: <base64>
    size: N
    blockMapSize: N        # only when a blockmap was uploaded
path: releases/1.2.3/App-1.2.3-mac.zip
sha512: <base64>
releaseDate: 'ISO'
releaseNotes: '...'
```

### API (JSON, `Authorization: Bearer <token>`)

Two kinds of token: the **admin** token (env), which can do everything, and **publish**
tokens, which are tied to one app and can only call `whoami`, `GET /api/apps/<app>` and
the upload routes for that app. Compare tokens in constant time. Errors look like
`{"error":{"code":"...","message":"..."}}` with a proper status code.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/whoami` | any | `{"remote":"moulik","scope":"admin"}` or `{"remote":..,"scope":"publish","app":"x"}` |
| `GET /api/apps` | admin | `[{app summary, latest}]` |
| `POST /api/apps` | admin | `{name,title,updater,sparklePublicKey?}` → 201 app. 409 if it exists. `sparklePublicKey` (base64 of 32 raw bytes) is required for sparkle |
| `GET /api/apps/<app>` | admin, publish(app) | `{...app, urls, releases: [...]}`, newest first, withdrawn included |
| `PATCH /api/apps/<app>` | admin | `{title?,sparklePublicKey?}` |
| `POST /api/apps/<app>/tokens` | admin | `{label}` → 201 `{id,token}`, with the token shown only this once |
| `GET /api/apps/<app>/tokens` | admin | `[{id,label,createdAt}]` |
| `DELETE /api/apps/<app>/tokens/<id>` | admin | 204 |
| `POST /api/apps/<app>/releases/<version>/withdraw` | admin | 200 release |
| `POST /api/apps/<app>/releases/<version>/restore` | admin | 200 release |
| `POST /api/apps/<app>/uploads` | admin, publish(app) | start an upload, see below |
| `PUT /api/apps/<app>/uploads/<id>/files/<name>` | same | raw body stream, checked against the declared size and sha256 → 204 |
| `POST /api/apps/<app>/uploads/<id>/commit` | same | publish → 201 release |

Starting an upload: `{version, build?, notes?, minimumSystemVersion?, edSignature?, files:[{name,role,size,sha256}]}`.
The server checks that:
- the version is `X.Y.Z` and strictly newer than **every** existing release of the app,
  withdrawn ones included. `build` defaults to the scheme above and must be higher than
  every existing build.
- the file names are safe (`^[A-Za-z0-9._-]+$`, no leading dot) and the roles are
  correct for the updater.
- the sizes are at most 4 GiB.

It returns 201 `{uploadId, expiresAt}`.

On commit, the server:
- checks that every file arrived and matches its size and sha256
- for sparkle, verifies `edSignature` as Ed25519 over the DMG's bytes with the app's
  `sparklePublicKey`, and rejects with 422 if it doesn't verify
- computes sha512 (base64)
- moves the files into `releases/<version>/` and writes `release.json` last.

It checks again under the app lock that the version is still the newest. Re-running a
commit that already succeeded returns 409 `already_published`.

## CLI (`apps`)

- Config: `~/.config/apps/config.json` → `{"remotes":{"moulik":{"url":"https://apps.moulik.dev"}},"appleIssuerId":"..."}`.
- Admin tokens are kept in the macOS keychain via `@napi-rs/keyring`, service `apps-cli`,
  account `<remote name>`.
- Sparkle private keys are kept in the keychain too, service `apps-cli-sparkle`, account
  `<remote>/<app>`. The format is base64 of the 32-byte Ed25519 seed, which is Sparkle 2's
  format (`generate_keys -x` / `sign_update --ed-key-file`). Signatures match
  `sign_update` byte for byte. Sparkle's legacy 96-byte format isn't supported.
- Environment overrides for CI: `APPS_TOKEN` (used instead of the keychain),
  `SPARKLE_PRIVATE_KEY` (base64 seed).
- Every command takes `--json` for script-safe output and `-C <dir>` for the app repo.

| Command | What |
| --- | --- |
| `apps remote add <name> <url>` / `remove <name>` / `list` | manage remotes |
| `apps login <remote> [--token-stdin]` | prompt for the admin token (hidden), check it with `whoami`, store it |
| `apps logout <remote>` | forget the token |
| `apps create <app> --remote <r> --updater sparkle\|electron [--title T] [--kind native\|electron]` | create the app on the remote (for sparkle: generate an Ed25519 key pair, keep the private key in the keychain, send the public key) and write `apps.json` in the current directory |
| `apps init [--repo owner/name] [--signing-dir ~/.config/predictor-release]` | in a repo with `apps.json`: create the GitHub `production` environment, allowed only from `<tagPrefix>*` tags; set the environment secrets (below); write `.github/workflows/release.yml` if missing; print what the app must contain (Sparkle `SUFeedURL`/`SUPublicEDKey`, or electron-builder `publish: {provider: generic, url: <public>/<app>/}`) |
| `apps publish --version X [--build N] [--notes-file f] --dmg p [--zip p] [--blockmap p] [--minimum-system-version v]` | read `apps.json`, sign the DMG for sparkle, upload with progress, commit, print the release |
| `apps releases [--app a --remote r]` | list releases |
| `apps withdraw <version>` / `apps restore <version>` | admin |
| `apps token create\|list\|revoke` | manage publish tokens for the current app |
| `apps status` | the current app, its remote, the latest release, and whether the live feed matches |
| `apps build-number <version>` | print the default build for a version |

Secrets that `apps init` sets on the GitHub `production` environment:
- `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, from `<signing-dir>/developer-id.p12` and `certificate-password`
- `APPLE_API_KEY_BASE64`, `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, from `<signing-dir>/AuthKey_<id>.p8`, with the issuer from config, asked for once
- `APPS_TOKEN`: a new publish token for this app
- `SPARKLE_PRIVATE_KEY` (sparkle only), from the keychain

## Reusable workflow

The caller adds `.github/workflows/release.yml`:
```yaml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  release:
    uses: Moulik-Budhiraja/app-hosting/.github/workflows/release-mac.yml@main
    secrets: inherit
```
`release-mac.yml` (`on: workflow_call`) runs one job on `[self-hosted, macos-ephemeral]`
with `environment: production`, `timeout-minutes: 90` and a non-cancelling concurrency
group per repo. Its steps:

1. Check out the app repo with `fetch-depth: 0`, and check out `Moulik-Budhiraja/app-hosting`
   into `.apps-tooling` at the `tooling-ref` input, which defaults to `main`. GitHub
   doesn't tell a called workflow its own ref, so a caller that pins `@<ref>` should pass
   the same ref. The `directory` input points at the folder holding `apps.json`, for
   monorepos. The job skips itself if `/<app>/releases.json` already lists the version,
   for example after a local release.
2. Read `apps.json`. Check that the tag is `<tagPrefix>X.Y.Z` and that the tagged commit
   is on `origin/main`.
3. Set up Node 24, then build the CLI (`npm ci && npm run build` in `.apps-tooling/cli`).
4. `scripts/mac/keychain.sh`: create a throwaway keychain with the Developer ID. Save the
   original search list and restore it at the end, `if: always()`.
5. Build: native runs `build.command` and then `scripts/mac/sign-app.sh`,
   `notarize.sh <app>` and `make-dmg.sh`. Electron runs `build.command` with the
   electron-builder variables set, then `notarize.sh <dmg>` if it isn't stapled.
6. Verify with `codesign --verify --deep --strict`, `spctl --assess`, and
   `xcrun stapler validate` on the app and the DMG.
7. `apps publish`, with `APPS_TOKEN` and `SPARKLE_PRIVATE_KEY` from secrets.
8. Check that the live feed reports the new version.
9. Delete the keychain and remove the key files, `if: always()`.

Apple's timestamp server sometimes fails, so signing and notarizing are retried up to 3
times.

## Notes from building it

- Reverse proxies in front of the server need `client_max_body_size 0;` and
  `proxy_request_buffering off;`, or large uploads fail. Don't put the upload hostname
  behind Cloudflare's proxy, which caps request bodies at 100 MB.
- The server reads the whole DMG into memory to check its Sparkle signature, which is
  fine for normal app sizes.
- The workflow fails if the built app's `CFBundleShortVersionString` or `CFBundleVersion`
  doesn't match the tag. It passes `--minimum-system-version` from `LSMinimumSystemVersion`,
  and `--notes-file` from an annotated tag's message.
- `apps.json`: a `native` build must use `sparkle`, and an `electron` build must use
  `electron`.
- `scripts/mac/release-local.sh <version>` runs the same pipeline from a Mac when the
  runner is down. `DRY_RUN=1` stops after signing.
