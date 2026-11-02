# app-hosting: design and contracts

One standard way to build, sign and ship auto-updating desktop apps for macOS and
Windows. The server, CLI, workflows and skill in this repo all follow this file. If
you change a contract here, change every part that uses it.

## Pieces

- `server/`: the update host. One copy runs per **remote**:
  - `moulik` at `https://apps.moulik.dev`, on hp
  - `proletic` at `https://apps.proletic.co`, on rs
  It serves update feeds, downloads and a download page, and takes authenticated
  uploads. Node 24, no runtime dependencies, TypeScript run directly by Node
  (erasable syntax only: no enums, no parameter properties, `.ts` import suffixes).
- `cli/`: the `apps` command. It knows several remotes, like git, and is logged in to
  each one separately. Node ≥ 22, compiled with `tsc` to `dist/`.
- `actions/release-mac` and `actions/release-windows`: composite actions with the release
  steps for one platform, run on a release tag. Apps owned by other accounts call them
  from their own jobs. `.github/workflows/release-mac.yml` and `release-windows.yml` are
  reusable workflows that wrap them for apps under `Moulik-Budhiraja`. They use `scripts/common/`
  (`read-config.mjs` and its `read-config.sh` wrapper, `check-tag.sh`, `published.sh`,
  `build-env.mjs`, `with-build-secrets.mjs`),
  `scripts/mac/*.sh` and `scripts/windows/*.ps1`.
- `skills/mac-app-release/SKILL.md`: tells agents to use all of the above instead of
  building release setups by hand. It covers Windows too, despite the name.

## Words

- **remote**: one server, such as `moulik` or `proletic`.
- **app**: a name unique on its remote, matching `^[a-z0-9][a-z0-9-]{1,39}$`. Each app
  lives on exactly one remote. Reserved names: `api`, `healthz`, `assets`, `download`.
- **platform**: `mac` or `windows`. An app ships for one or both.
- **updater**: the app's update framework family, the same on every platform:
  - `sparkle`: native apps. Sparkle on macOS, WinSparkle on Windows. Both read a
    Sparkle appcast and check Ed25519 (`sparkle:edSignature`) signatures, so one key
    pair serves both platforms.
  - `electron`: electron-updater on both platforms.
- **version**: `X.Y.Z`, three numeric parts. **build**: an integer that rises with the
  version. The default is `X*100000000 + Y*100000 + Z*100` (1.2.3 is 100200300), the
  same scheme hobola uses. Sparkle on macOS compares builds. WinSparkle and
  electron-updater compare versions.
- **release**: one version of an app. It holds files for one or more platforms. Each
  platform is published on its own, so 1.2.3 can ship for macOS first and gain its
  Windows files later. Once a platform's files are published they never change.

## `apps.json` (committed at the app repo root)

```json
{
  "app": "screen-draw",
  "remote": { "name": "moulik", "url": "https://apps.moulik.dev" },
  "updater": "sparkle",
  "tagPrefix": "v",
  "builds": {
    "mac": {
      "kind": "native",
      "command": "./scripts/build.sh",
      "app": "build/ScreenDraw.app",
      "entitlements": null,
      "dmgName": "ScreenDraw"
    },
    "windows": {
      "kind": "native",
      "command": "./scripts/build.ps1",
      "installer": "build/ScreenDraw-Setup-{version}.exe",
      "minimumSystemVersion": "10.0",
      "icon": "assets/icon.png"
    }
  }
}
```

- `builds` needs at least one of `mac` and `windows`. The older form, a top-level
  `build` object, still reads as `builds.mac`. A file can't have both `build` and
  `builds`. Tools that write `apps.json` write `builds`.
- `tagPrefix` defaults to `"v"`. A monorepo can use `"app/v"`, in which case the tag
  `app/v1.2.3` releases 1.2.3. It can also be a list, such as `["v", "win-v"]`: a tag
  matching any of them releases, and the longest prefix the tag starts with gives the
  version, so `win-v0.7.27` and `v0.7.27` both release 0.7.27. A plain string works as
  before. Which platforms a tag releases is up to `release.yml`: `apps init` triggers
  every job on every prefix, and an app that wants `win-v*` to release Windows only
  splits its jobs into workflows with their own `tags:`, such as `release-mac.yml` on
  `v*` and `release-windows.yml` on `v*` and `win-v*`. Both platforms built from the
  same `v` tag share the version and build number, so they join one release.
- A `native` build must use `sparkle`, and an `electron` build must use `electron`, on
  both platforms.
- Paths stay inside the repo: no leading `/` or `~`, and no `..`. Artifact paths can use
  `{version}`.

### `builds.mac`

- `kind: "native"`: the workflow runs `command` with `VERSION` and `BUILD` set. The
  command must leave an **unsigned or ad-hoc signed** `.app` at `app`. The workflow
  then signs it (nested code inside-out, hardened runtime, timestamp, optional
  `entitlements` on the outer app), notarizes and staples it, wraps it in
  `<dmgName>-<version>.dmg` with an /Applications link, signs, notarizes and staples the
  DMG, and publishes.
- `kind: "electron"`: the workflow runs `command` with `VERSION`, `BUILD` and
  electron-builder's signing variables (`CSC_KEYCHAIN`, `CSC_NAME`, `APPLE_API_KEY`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) set. The command must sign and notarize the
  app itself (electron-builder `mac.notarize: true`) and leave the files at `dmg`, `zip`
  and optionally `blockmap`. The workflow notarizes and staples the DMG if it isn't
  stapled yet, verifies everything, and publishes.

### `builds.windows`

Windows builds run in PowerShell 7 (`pwsh`). The command gets `VERSION` and `BUILD`,
plus the Artifact Signing settings: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET`, `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`,
`AZURE_SIGNING_PROFILE` and `AZURE_SIGNING_PUBLISHER`. `APPS_SIGN_SCRIPT` is the path
of `scripts/windows/sign.ps1`, which signs the files it's given with Artifact Signing
(`pwsh -File $env:APPS_SIGN_SCRIPT a.exe b.dll`).

- `kind: "native"`: the command builds the app and its installer, and leaves the
  installer (`.exe` or `.msi`) at `installer`. It should sign the app's own `.exe` and
  `.dll` files with `APPS_SIGN_SCRIPT` before packaging them. The workflow signs the
  installer if it isn't validly signed yet, verifies it, and publishes. The app reads
  `<remote>/<app>/appcast-windows.xml` with WinSparkle, and must report its version as
  `X.Y.Z`, through its `FileVersion` resource or `win_sparkle_set_app_details`.
- `kind: "electron"`: the command runs electron-builder with an NSIS target and
  `win.azureSignOptions` built from the `AZURE_SIGNING_*` variables, so electron-builder
  signs the app, the installer and the uninstaller. It leaves the installer at
  `installer` and optionally its blockmap at `blockmap`, named `<installer name>.blockmap`.
  The workflow verifies and publishes. An unsigned installer fails the release rather
  than being signed afterwards, which would leave the app inside it unsigned and break
  the blockmap.

Electron builds on either platform, with electron-builder 26 (seen on the Windows pool):
- `-c.extraMetadata.version=...` is read as a config path. Commands set the version with
  `npm version <version> --no-git-tag-version --allow-same-version` before building, or
  with `--config.extraMetadata.version=...`.
- `electron-builder.config.js` isn't loaded on its own. Commands pass it with
  `--config electron-builder.config.js`. Without it the build is unsigned and uses the
  default artifact name, so the release fails at the signature check or the
  `installer`/`dmg` path.
- `minimumSystemVersion` (optional): the oldest Windows version the app runs on, such
  as `"10.0"` or `"10.0.17763"`. Feeds and the download page pass it on.
- `icon` (optional): a PNG for the download page, at most 1 MiB and 16-2048 pixels a
  side. Mac releases take the icon from the built app, so a Windows icon is only
  needed for Windows-only apps.

## Server

Environment:
- `APPS_PUBLIC_URL`: for example `https://apps.moulik.dev`, with no trailing slash.
- `APPS_REMOTE_NAME`: for example `moulik`. Used in the app list's page title and `/healthz`.
- `APPS_ADMIN_TOKEN`: the admin bearer token, 32+ characters.
- `APPS_DATA_DIR`: default `/data`.
- `APPS_PORT`: default `3000`.
- `APPS_HOST_ALIASES`: optional, for example `notes.proletic.co=hobola,agent.proletic.co=proactive-agent`.
  A request whose Host is an alias is served as if its path were under `/<app>`, so
  `notes.proletic.co/appcast.xml` is `/hobola/appcast.xml`. API routes keep working.

Data layout (`APPS_DATA_DIR`):
```
apps/<app>/app.json                    {name,title,updater,sparklePublicKey?,icon?,createdAt}
apps/<app>/icon.png                    the app's icon, when it has one; icon in app.json is {sha256,size,updatedAt}
apps/<app>/releases/<version>/<files>  a platform's files never change once committed
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
  "withdrawn": false,
  "platforms": {
    "mac": { "publishedAt": "ISO", "minimumSystemVersion": "13.0" },
    "windows": { "publishedAt": "ISO", "minimumSystemVersion": "10.0" }
  },
  "files": [
    { "name": "ScreenDraw-1.2.3.dmg", "platform": "mac", "role": "dmg", "size": 1,
      "sha256": "hex", "sha512": "base64", "edSignature": "base64 (sparkle only)" },
    { "name": "ScreenDraw-Setup-1.2.3.exe", "platform": "windows", "role": "installer", "size": 1,
      "sha256": "hex", "sha512": "base64", "edSignature": "base64 (sparkle only)" }
  ] }
```
- `publishedAt` at the top is when the first platform was published. Each entry in
  `platforms` has its own `publishedAt`, and its `minimumSystemVersion` when one was given.
- `edSignature` sits on the file that the updater downloads: the DMG on macOS and the
  installer on Windows. Only `sparkle` apps have it.
- Older `release.json` files have no `platforms`, no `platform` on files, and keep
  `minimumSystemVersion` and `edSignature` at the top. The server reads them as a
  macOS-only release: files are `mac`, `platforms.mac` takes the top-level
  `publishedAt` and `minimumSystemVersion`, and the top-level `edSignature` belongs to
  the DMG. It writes the new form whenever it saves a release.

File roles, per updater and platform. Each platform of a release has exactly these:

| Updater | Platform | Files |
| --- | --- | --- |
| `sparkle` | `mac` | one `dmg`, which is also the update archive |
| `sparkle` | `windows` | one `installer` (`.exe` or `.msi`), which is also the update |
| `electron` | `mac` | one `dmg`; one `zip`, the update archive; optionally a `blockmap` named `<zip name>.blockmap` |
| `electron` | `windows` | one `installer` (`.exe`, NSIS), which is also the update; optionally a `blockmap` named `<installer name>.blockmap` |

A platform's **live releases** are the non-withdrawn releases with files for that
platform, newest first. Its **latest release** is the first of them. Feeds, downloads
and the download page work per platform from these.

### Public routes

Everything outside `/api` is public and read-only. These are all of it:

| Route | What |
| --- | --- |
| `GET /healthz` | `{"ok":true,"remote":"moulik"}` |
| `GET /` | HTML list of apps: icon, title, newest live version on any platform |
| `GET /<app>/` | HTML download page for one platform, see below |
| `GET /<app>/app.json` | the app's public metadata, see below |
| `GET /<app>/latest.json` | `{"mac": <release> \| null, "windows": <release> \| null}`: each platform's latest release |
| `GET /<app>/latest.json?platform=mac\|windows` | that platform's latest release; 404 if it has none, 400 for another platform |
| `GET /<app>/releases.json` | one page of live releases, newest first: `{"releases": [...], "next": <url> \| null}`, see below |
| `GET /<app>/releases/<version>.json` | one live release; 404 if it doesn't exist or is withdrawn |
| `GET /<app>/releases/<version>/<file>` | artifact, with `Content-Length`, `ETag` and Range support |
| `GET /<app>/icon.png` | the app's icon. Pages link to `icon.png?v=<first 12 hex of its sha256>`, which is cached for good; without a matching `v` it's `no-cache` |
| `GET /<app>/download` | 302 to the visitor's platform's download, see below |
| `GET /<app>/download/mac` | 302 to the latest macOS DMG |
| `GET /<app>/download/windows` | 302 to the latest Windows installer |
| `GET /<app>/appcast.xml` | Sparkle feed for macOS (sparkle apps only): the newest 10 live releases |
| `GET /<app>/appcast-windows.xml` | WinSparkle feed for Windows (sparkle apps only): the newest 10 live releases |
| `GET /<app>/latest-mac.yml` | electron-updater feed for macOS (electron apps only) |
| `GET /<app>/latest.yml` | electron-updater feed for Windows (electron apps only) |

Every route takes `HEAD` too. Withdrawn releases leave the feeds, the JSON routes, the
download pages and the download routes, but their files still serve. Unknown app or path
returns 404, and so does a download route or feed with nothing to offer. Errors are
`{"error":{"code","message"}}`. The JSON routes send `Cache-Control: no-cache`.

**CORS.** Any website may read the public routes. `GET` and `HEAD` responses on them,
errors and redirects included, carry `Access-Control-Allow-Origin: *` and
`Access-Control-Expose-Headers: Link, ETag, Content-Range, Accept-Ranges`. `OPTIONS` on
a public path answers 204 with `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`,
echoes `Access-Control-Request-Headers` as `Access-Control-Allow-Headers`, and never
allows credentials. `POST`, `PUT`, `PATCH` and `DELETE` on a public path answer 405
without CORS headers, whatever token comes with them. `/api` has no CORS at all: every
request there, `OPTIONS` included, needs a token and gets 401 without one, so a browser
on another site can't call it.

**The visitor's platform** comes from the User-Agent: `Windows` means `windows`, and
`Macintosh`, `Mac OS X` or `Darwin` means `mac`. `/download` sends a known platform to
its download, or to the download page (`./`) if the app has no release for it. Any other
User-Agent (curl, Linux, bots) gets macOS when the app has a macOS release, and Windows
otherwise, so `curl -L .../download` keeps returning the DMG. Responses that depend on
the User-Agent send `Vary: User-Agent` and `Cache-Control: no-cache`.

**A release** in `latest.json`, `releases.json` and `releases/<version>.json` has
`version`, `build`, `publishedAt`, `notes`, `platforms`, and `files` (`name`,
`platform`, `role`, `size`, `url`). It also keeps a top-level `minimumSystemVersion`,
the macOS one or null, for older readers. It lists the files of every platform, also in
`latest.json?platform=`.

**`releases.json` pages.** `?limit=N` sets the page size, 1 to 100, default 20.
`?before=<version>` starts the page after that version, which need not exist. `next`
is the absolute URL of the following page, or null on the last one, and the same URL
comes as `Link: <url>; rel="next"`. Follow `next` until it's null to read every
release. Bad `limit` or `before` values answer 400. Before paging (until November 2026)
the body was a plain array of every live release; `apps releases` and `published.sh`
still read that form from an older server.

**`app.json`:** `name`, `title`, `updater`, `platforms` (those with a live release),
`icon` (the versioned `icon.png` URL, or null), and `urls`: `page`, `download`,
`downloads` and `feeds` keyed by platform (only platforms with a live release),
`latest` and `releases`. It leaves out what only the admin API shows, such as the
Sparkle public key and publish tokens.

### Download page

Pages follow the Paper file "app-hosting — Download pages redesign": one column, the
system font, light and dark from `prefers-color-scheme`, and a narrow layout under 600px.
An app without an icon gets a tile with its initial. Their CSP allows inline styles and
images from the same origin only.

`/<app>/` shows one platform: `?platform=mac` or `?platform=windows` when given and the
app has a live release for it, otherwise the visitor's platform when the app has one,
otherwise macOS, otherwise Windows. It shows that platform's latest release: version and
date, a "Download for Mac" or "Download for Windows" button linking to
`download/<platform>`, the file size and minimum system ("macOS 13 or later",
"Windows 10 or later"), the release notes, and earlier versions from that platform's
live releases. When the app also has releases for the other platform, a link under the
button ("Also for Windows" or "Also for Mac") goes to `?platform=<other>`.

### Feeds

Sparkle item (`appcast.xml`, one per live macOS release, newest 10 only; Sparkle only
needs the newest one it can install):
```xml
<item>
  <title>1.2.3</title>
  <pubDate>RFC 822 of platforms.mac.publishedAt</pubDate>
  <sparkle:version>100200300</sparkle:version>
  <sparkle:shortVersionString>1.2.3</sparkle:shortVersionString>
  <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
  <description><![CDATA[notes as simple, escaped HTML]]></description>
  <enclosure url="<public>/<app>/releases/1.2.3/<dmg>" length="N" type="application/octet-stream" sparkle:edSignature="..."/>
</item>
```
WinSparkle item (`appcast-windows.xml`, one per live Windows release, newest 10 only). WinSparkle
compares `sparkle:version` with the app's own version, so it carries the version, not
the build:
```xml
<item>
  <title>1.2.3</title>
  <pubDate>RFC 822 of platforms.windows.publishedAt</pubDate>
  <sparkle:version>1.2.3</sparkle:version>
  <sparkle:shortVersionString>1.2.3</sparkle:shortVersionString>
  <sparkle:minimumSystemVersion>10.0</sparkle:minimumSystemVersion>
  <description><![CDATA[notes as simple, escaped HTML]]></description>
  <enclosure url="<public>/<app>/releases/1.2.3/<installer>" length="N" type="application/octet-stream" sparkle:os="windows" sparkle:edSignature="..."/>
</item>
```
`latest-mac.yml` (only the latest macOS release, URLs relative to `/<app>/`). Strings
are JSON-quoted, which is valid YAML:
```yaml
version: "1.2.3"
files:
  - url: "releases/1.2.3/App-1.2.3-mac.zip"
    sha512: "<base64>"
    size: N
    blockMapSize: N        # only when a blockmap was uploaded
path: "releases/1.2.3/App-1.2.3-mac.zip"
sha512: "<base64>"
releaseDate: "ISO of platforms.mac.publishedAt"
minimumSystemVersion: "13.0"   # only when given
releaseNotes: "..."            # only when there are notes
```
`latest.yml` is the same for the latest Windows release, with the installer in place of
the zip and `platforms.windows` for the date and minimum system.

### API (JSON, `Authorization: Bearer <token>`)

Two kinds of token: the **admin** token (env), which can do everything, and **publish**
tokens, which are tied to one app and can only call `whoami`, `GET /api/apps/<app>`,
`PUT /api/apps/<app>/icon` and the upload routes for that app. Compare tokens in constant time. Errors look like
`{"error":{"code":"...","message":"..."}}` with a proper status code.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/whoami` | any | `{"remote":"moulik","scope":"admin"}` or `{"remote":..,"scope":"publish","app":"x"}` |
| `GET /api/apps` | admin | `[{app summary, latest}]` |
| `POST /api/apps` | admin | `{name,title,updater,sparklePublicKey?}` → 201 app. 409 if it exists. `sparklePublicKey` (base64 of 32 raw bytes) is required for sparkle |
| `GET /api/apps/<app>` | admin, publish(app) | `{...app, urls, releases: [...]}`, newest first, withdrawn included |
| `PATCH /api/apps/<app>` | admin | `{title?,sparklePublicKey?}` |
| `PUT /api/apps/<app>/icon` | admin, publish(app) | raw PNG body, at most 1 MiB and 16-2048 pixels a side → 200 app. Replaces the icon |
| `DELETE /api/apps/<app>/icon` | admin | → 200 app |
| `POST /api/apps/<app>/tokens` | admin | `{label}` → 201 `{id,token}`, with the token shown only this once |
| `GET /api/apps/<app>/tokens` | admin | `[{id,label,createdAt}]` |
| `DELETE /api/apps/<app>/tokens/<id>` | admin | 204 |
| `POST /api/apps/<app>/releases/<version>/withdraw` | admin | 200 release. Withdraws every platform of the release |
| `POST /api/apps/<app>/releases/<version>/restore` | admin | 200 release |
| `POST /api/apps/<app>/uploads` | admin, publish(app) | start an upload, see below |
| `PUT /api/apps/<app>/uploads/<id>/files/<name>` | same | raw body stream, checked against the declared size and sha256 → 204 |
| `POST /api/apps/<app>/uploads/<id>/commit` | same | publish → 201 release |

App views carry `urls`: `page`, `download`, `updateBase`, `icon` when there is one,
`feeds` (`{"mac": ".../appcast.xml", "windows": ".../appcast-windows.xml"}` for sparkle,
`{"mac": ".../latest-mac.yml", "windows": ".../latest.yml"}` for electron), and `feed`,
the macOS feed, for older readers. Release views are `release.json` with a `url` on each
file.

Starting an upload publishes one platform:
`{version, platform?, build?, notes?, minimumSystemVersion?, edSignature?, files:[{name,role,size,sha256}]}`.
`platform` defaults to `mac`, so older CLIs keep working. The server checks that:
- the version is `X.Y.Z`, and either
  - **a new release:** no release has this version, the version is strictly newer than
    **every** existing release, withdrawn ones included, and `build` (which defaults to
    the scheme above) is higher than every existing build; or
  - **a new platform for an existing release:** the release has no files for this
    platform yet (else 409 `already_published`), isn't withdrawn (else 409
    `release_withdrawn`), and is newer than every other release with files for this
    platform (else 409 `version_not_newer`). `build`, if given, must equal the release's
    build (else 409 `build_mismatch`); if not given, it's the release's build. File names
    must not clash with the release's files (else 409 `file_exists`).
- the file names are safe (`^[A-Za-z0-9._-]+$`, no leading dot), and the files are
  exactly what the role table allows for the app's updater and this platform. An
  `installer` ends in `.exe` or `.msi` (`.exe` only for electron).
- the sizes are at most 4 GiB.
- `minimumSystemVersion`, if given, looks like `13.0` on macOS (`^\d{1,2}(\.\d{1,2}){0,2}$`)
  and like `10.0` or `10.0.17763` on Windows (`^\d{1,2}(\.\d{1,5}){0,2}$`).
- `edSignature` is given for sparkle apps (base64 of 64 bytes) and not for electron apps.

It returns 201 `{uploadId, expiresAt, version, build}`.

On commit, the server:
- checks that every file arrived and matches its size and sha256
- for sparkle, verifies `edSignature` as Ed25519 over the bytes of the platform's update
  file (the DMG or the installer) with the app's `sparklePublicKey`, and rejects with 422
  if it doesn't verify
- computes sha512 (base64)
- under the app lock, checks the version rules above again. Either platform may have
  committed the release in the meantime: a new release that now exists is checked as a
  new platform for it.
- moves the files into `releases/<version>/` and writes `release.json` last. A new
  platform's files join the existing release. Its notes are kept, unless they're empty
  and the upload has notes. A leftover file from an interrupted commit (in the folder
  but not in `release.json`) is replaced.

Re-running a commit that already succeeded returns 409 `already_published`.

## CLI (`apps`)

- Config: `~/.config/apps/config.json` → `{"remotes":{"moulik":{"url":"https://apps.moulik.dev"}},"appleIssuerId":"..."}`.
- Admin tokens are kept in the macOS keychain via `@napi-rs/keyring`, service `apps-cli`,
  account `<remote name>`.
- Sparkle private keys are kept in the keychain too, service `apps-cli-sparkle`, account
  `<remote>/<app>`. The format is base64 of the 32-byte Ed25519 seed, which is Sparkle 2's
  format (`generate_keys -x` / `sign_update --ed-key-file`). Signatures match
  `sign_update` byte for byte. Sparkle's legacy 96-byte format isn't supported. The same
  key signs Windows installers for WinSparkle.
- Environment overrides for CI: `APPS_TOKEN` (used instead of the keychain),
  `SPARKLE_PRIVATE_KEY` (base64 seed).
- Every command takes `--json` for script-safe output and `-C <dir>` for the app repo.

| Command | What |
| --- | --- |
| `apps remote add <name> <url>` / `remove <name>` / `list` | manage remotes |
| `apps login <remote> [--token-stdin]` | prompt for the admin token (hidden), check it with `whoami`, store it |
| `apps logout <remote>` | forget the token |
| `apps create <app> --remote <r> --updater sparkle\|electron [--title T] [--kind native\|electron] [--platforms mac,windows]` | create the app on the remote (for sparkle: generate an Ed25519 key pair, keep the private key in the keychain, send the public key) and write `apps.json` with a default build for each platform. `--platforms` defaults to `mac` |
| `apps init [--repo owner/name] [--signing-dir ~/.config/predictor-release]` | in a repo with `apps.json`: create the GitHub `production` environment, allowed only from `<prefix>*` tags, one rule per `tagPrefix` entry (existing rules stay); set the environment secrets (below) for the platforms in `builds`; write `.github/workflows/release.yml` if missing (calling the reusable workflows when the repo's owner is `Moulik-Budhiraja`, and running the composite actions in its own jobs otherwise); for a public repo, require approval for workflows from every external contributor's fork pull request and say that the runner must allowlist the repo; print what the app must contain for each platform |
| `apps publish --version X [--platform mac\|windows] [--build N] [--notes-file f] [--minimum-system-version v] [--icon png]` and the platform's files: `--dmg p [--zip p] [--blockmap p]` for macOS, `--installer p [--blockmap p]` for Windows | read `apps.json`, sign the update file for sparkle, upload with progress, commit, set the icon if given (a failure there only warns), print the release. `--platform` defaults to `windows` when `--installer` is given and to `mac` otherwise |
| `apps icon <png>` / `apps icon --remove` | set the app's icon, or remove it (admin) |
| `apps releases [--app a --remote r]` | list releases, with their platforms. Logged in it reads the admin API, which includes withdrawn ones; otherwise it follows `releases.json`'s `next` pages |
| `apps withdraw <version>` / `apps restore <version>` | admin |
| `apps token create\|list\|revoke` | manage publish tokens for the current app |
| `apps status [--expect X.Y.Z] [--platform p]` | the current app, its remote, and for each platform in `builds` (or just `--platform`) the latest release and whether the live feed matches. `--json` gives `{..., platforms: [{platform, latest, feed, ok}], ok}`, and the exit code is 1 if any platform is off |
| `apps build-number <version>` | print the default build for a version |

Secrets that `apps init` sets on the GitHub `production` environment:
- always: `APPS_TOKEN`, a new publish token for this app, and `SPARKLE_PRIVATE_KEY`
  (sparkle only), from the keychain
- with a `mac` build: `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, from
  `<signing-dir>/developer-id.p12` and `certificate-password`; `APPLE_API_KEY_BASE64`,
  `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, from `<signing-dir>/AuthKey_<id>.p8`, with the
  issuer from config, asked for once
- with a `windows` build: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` and
  `AZURE_SIGNING_PUBLISHER`, from `<signing-dir>/azure-signing.json`:
  `{"tenantId","clientId","clientSecret","endpoint","account","profile","publisher"}`.
  `publisher` is the subject name on the Artifact Signing certificate profile.

## Release workflows

The release steps live in two composite actions, `actions/release-mac` and
`actions/release-windows`. An app repo runs them in one of two forms, and `apps init`
writes the right one into `.github/workflows/release.yml`. Both forms run the same steps.
The jobs run in parallel and publish on their own, so one platform failing doesn't hold
back the other. Re-running a failed job publishes its platform into the same release.

**The cross-owner rule.** GitHub's `secrets: inherit` only passes secrets to a reusable
workflow owned by the same user, organization or enterprise as the caller. Environment
secrets don't cross either, even though the called job declares `environment:
production`. A repo owned by `Moulik-Budhiraja` can call the reusable workflows. A repo
owned by anyone else, such as `Proletic`, gets only `github_token` there, so it must use
the composite actions in its own jobs. That covers every app on the `proletic` remote.

**Same owner (`Moulik-Budhiraja/*`): reusable workflows.**
```yaml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  mac:
    uses: Moulik-Budhiraja/app-hosting/.github/workflows/release-mac.yml@main
    secrets: inherit
  windows:
    uses: Moulik-Budhiraja/app-hosting/.github/workflows/release-windows.yml@main
    secrets: inherit
```
`release-mac.yml` and `release-windows.yml` (`on: workflow_call`) are thin wrappers: one
job with `environment: production`, `timeout-minutes: 90` and a non-cancelling
concurrency group per repo and platform. It checks out the app, checks out
`Moulik-Budhiraja/app-hosting` into `.apps-tooling` at `tooling-ref`, and runs
`./.apps-tooling/actions/release-<platform>` with `checkout: false` and each secret as
its own input (`apps-token: ${{ secrets.APPS_TOKEN }}` and so on). Their inputs:
- `directory`: the folder holding `apps.json`, for monorepos. Default `.`.
- `tooling-ref`: the ref of `Moulik-Budhiraja/app-hosting` to take the action, scripts
  and CLI from. Default `main`. GitHub doesn't tell a called workflow its own ref, so a
  caller that pins `@<ref>` should pass the same ref.
- `build-secrets`: names of extra secrets the build `command` needs, separated by
  spaces, commas or newlines, such as `with: { build-secrets: GOOGLE_OAUTH_CLIENT_BASE64 }`.
  Default empty. The caller can't put secret values in `with:` here, so the wrapper
  picks the named secrets from `secrets: inherit` in a step of its own
  (`scripts/common/build-env.mjs from-secrets`) and passes them to the action as
  `build-env`. That step is the only one that sees `toJSON(secrets)`, and it runs only
  when `build-secrets` is set.
- `runs-on` (`release-windows.yml` only): see below.

**Other owners: composite actions in the caller's job.** The caller's job declares the
runner, the environment, the timeout and the concurrency group itself, and passes each
secret the action uses as its own input. Because the job runs in the caller repo with
`environment: production`, `secrets.<NAME>` reads that environment's secrets, which stay
limited to tags. The action never sees the repo's other secrets.
```yaml
name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: read
jobs:
  mac:
    runs-on: [self-hosted, macos-ephemeral]
    environment: production
    timeout-minutes: 90
    concurrency:
      group: release-mac-${{ github.repository }}
      cancel-in-progress: false
    steps:
      - uses: Moulik-Budhiraja/app-hosting/actions/release-mac@main
        with:
          apps-token: ${{ secrets.APPS_TOKEN }}
          sparkle-private-key: ${{ secrets.SPARKLE_PRIVATE_KEY }}
          apple-certificate-base64: ${{ secrets.APPLE_CERTIFICATE_BASE64 }}
          apple-certificate-password: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          apple-api-key-base64: ${{ secrets.APPLE_API_KEY_BASE64 }}
          apple-key-id: ${{ secrets.APPLE_KEY_ID }}
          apple-issuer-id: ${{ secrets.APPLE_ISSUER_ID }}
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
          sparkle-private-key: ${{ secrets.SPARKLE_PRIVATE_KEY }}
          azure-tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          azure-client-id: ${{ secrets.AZURE_CLIENT_ID }}
          azure-client-secret: ${{ secrets.AZURE_CLIENT_SECRET }}
          azure-signing-endpoint: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
          azure-signing-account: ${{ secrets.AZURE_SIGNING_ACCOUNT }}
          azure-signing-profile: ${{ secrets.AZURE_SIGNING_PROFILE }}
          azure-signing-publisher: ${{ secrets.AZURE_SIGNING_PUBLISHER }}
          build-env: |
            GOOGLE_OAUTH_CLIENT_BASE64=${{ secrets.GOOGLE_OAUTH_CLIENT_BASE64 }}
```
Electron apps leave out `sparkle-private-key`, and `build-env` is only for builds that
need secrets of their own. The action takes the scripts and CLI from its own copy of the
repo, at the ref after `@`, so it has no `tooling-ref`. Its inputs, all default empty
unless noted:
- `apps-token`: `APPS_TOKEN`, the app's publish token.
- `sparkle-private-key`: `SPARKLE_PRIVATE_KEY`, for Sparkle apps.
- macOS: `apple-certificate-base64`, `apple-certificate-password`, `apple-api-key-base64`,
  `apple-key-id`, `apple-issuer-id` (the `APPLE_*` secrets).
- Windows: `azure-tenant-id`, `azure-client-id`, `azure-client-secret`,
  `azure-signing-endpoint`, `azure-signing-account`, `azure-signing-profile`,
  `azure-signing-publisher` (the `AZURE_*` secrets).
- `build-env`: variables for the build command only, see below.
- `directory`: as above. Default `.`.
- `checkout`: check out the calling repo first. Default `true`; the wrappers pass `false`.
- `secrets` and `build-secrets`, deprecated: the job's whole secrets context as JSON
  (`${{ toJSON(secrets) }}`), and names to pick from it for the build. They hand the
  action every secret in the repo, and GitHub's malicious-workflow check held a test run
  that passed `toJSON(secrets)` to the action. The action still reads
  them, prints a deprecation warning, and prefers a named input over the same secret in
  the JSON. They will be removed once no caller uses them.

**`build-env`** covers secrets the app bundles or uses at build time, such as an OAuth
client file, kept in the `production` environment. It takes the form `$GITHUB_ENV` uses:
`NAME=value` lines, and for a value that may hold a newline, a `NAME<<DELIMITER` line,
the value, and a line holding only `DELIMITER`:
```yaml
build-env: |
  GOOGLE_OAUTH_CLIENT_BASE64=${{ secrets.GOOGLE_OAUTH_CLIENT_BASE64 }}
  SIGNING_PEM<<END_SIGNING_PEM
  ${{ secrets.SIGNING_PEM }}
  END_SIGNING_PEM
```
A multi-line secret in the `NAME=value` form leaves lines that aren't `NAME=value`, and
the run fails on them; pick a delimiter that can't appear in the value. Early in the
job, `scripts/common/build-env.mjs mask` checks the text and masks every line of every
value with `::add-mask::`, so values that didn't come straight from `secrets` are hidden
too. The build step then runs the build through `scripts/common/with-build-secrets.mjs`.
That script starts `build-release.sh` (Mac) or `build-release.ps1` (Windows) with each
variable under its own name, and without the `build-env` text itself, so the build never
sees anything else. Only the build step gets them, not publishing. The run fails before
building if a value is empty (usually a secret that isn't set), a line is malformed, a
name repeats, or a name would replace a variable the build step already sets (such as
`VERSION` or `AZURE_CLIENT_ID`). Errors give line numbers, never line text, and the
script prints only the names. With no build secrets, the build step runs the build
script directly. `release-local.sh` takes the same variables from the shell that runs it.

The action's steps, on both platforms:

1. Warn if the deprecated `secrets` or `build-secrets` inputs are set.
2. Check out the app repo with `fetch-depth: 0` (unless `checkout` is false), and copy the
   action repo's `scripts` and `cli` to `$RUNNER_TEMP/apps-tooling` (`APPS_TOOLING`).
3. Set up Node 24. `scripts/common/read-config.sh <apps.json> <platform>` reads
   `apps.json`.
4. Fail at once if `APPS_TOKEN` didn't arrive, which means the job lacks
   `environment: production`, the `apps-token` input, or the secret itself.
5. Check and mask `build-env`.
6. `scripts/common/check-tag.sh <tag> <prefix>...` checks the tag against every
   `tagPrefix` and that the tagged commit is on `origin/main`. The longest prefix the tag
   starts with gives the version, so overlapping prefixes such as `v` and `v-beta` pick
   the more specific one.
7. The job skips the rest if `scripts/common/published.sh` finds the version live with
   files for its platform in `/<app>/releases/<version>.json`, for example after a local
   release or a re-run.
8. Build the CLI (`npm ci && npm run build` in `$APPS_TOOLING/cli`).
9. Build, sign and verify (per platform, below).
10. The annotated tag's message becomes the release notes.
11. `apps publish --platform <platform>`, with `APPS_TOKEN` and `SPARKLE_PRIVATE_KEY`.
12. Check that the platform's live feed offers the new version.

### macOS (`release-mac.yml`, `actions/release-mac`)

Runs on `[self-hosted, macos-ephemeral]`.

The runner controller on ralph (`Proletic/macos-runner`) gives each queued job a fresh
Tart VM. For personal-account repos it takes jobs from private repos, and from public
repos only if they are in the `publicRepositories` list of its `personal` source, so
fork pull requests can't reach the machine. A public app repo must be on that list and
must require approval for workflows from all external contributors (`apps init` sets the
latter). Until the repo is listed its release job stays queued, and since account sources
don't look for old queued jobs, the run has to be cancelled and re-run after listing it.

Its build steps:
1. `scripts/mac/keychain.sh`: create a throwaway keychain with the Developer ID. Save the
   original search list and restore it at the end, `if: always()`.
2. Build: native runs `command` and then `scripts/mac/sign-app.sh`,
   `notarize.sh <app>` and `make-dmg.sh`. Electron runs `command` with the
   electron-builder variables set, then `notarize.sh <dmg>` if it isn't stapled.
3. Verify with `codesign --verify --deep --strict`, `spctl --assess`, and
   `xcrun stapler validate` on the app and the DMG.
4. Publish with `--icon`, the PNG that `scripts/mac/app-icon.sh` made from the built app.
5. Delete the keychain and remove the key files, `if: always()`.

Apple's timestamp server sometimes fails, so signing and notarizing are retried up to 3
times.

### Windows (`release-windows.yml`, `actions/release-windows`)

`release-windows.yml` takes one more input, `runs-on`: a JSON array of runner labels,
default `["self-hosted", "windows"]`. Pass `'"windows-latest"'` to use GitHub's hosted
runner. With the action, the caller's job sets `runs-on` itself.

The `[self-hosted, windows]` pool runs on the Windows machine at home: each job gets a
fresh Windows 11 x64 Hyper-V VM, deleted afterwards, which can't reach the LAN. Its
image has Git, Node LTS, PowerShell 7, Python 3, Visual Studio 2022 Build Tools (C++
desktop, MSBuild), the .NET SDK (LTS), the Windows SDK (`signtool`), the Artifact Signing
client tools and 7-Zip; the image's README lists the versions. The pool serves repos
under `Moulik-Budhiraja` and `Proletic`. Like the macOS runner, it takes jobs from
private repos, and from public repos only if they're on its controller's allowlist and
require approval for workflows from all external contributors.

Any runner needs Git for Windows, with its `bash` ahead of WSL's on `PATH` (it runs the
shared scripts), and PowerShell 7. The workflow installs Node 24 and the .NET 8 runtime
that signing needs. Scripts keep LF line endings (`scripts/.gitattributes`) so bash can
run them from a Windows checkout.

Its build steps, in `scripts/windows/build-release.ps1`:
1. Run `command` with the variables from `builds.windows` above.
2. Check that the installer (and blockmap, when configured) exists.
3. For native builds, sign the installer with `sign.ps1` if `Get-AuthenticodeSignature`
   doesn't already report it `Valid`. Electron builds fail instead (see above).
4. Verify: the installer's signature is `Valid` and timestamped. If the installer's
   `ProductVersion` is set, it must start with the version.
5. Publish with `--installer`, `--blockmap`, `--minimum-system-version` from
   `builds.windows`, and `--icon` from `builds.windows.icon` when set.

`sign.ps1` uses Microsoft's `ArtifactSigning` PowerShell module (`Invoke-ArtifactSigning`,
formerly `TrustedSigning`), which fetches `signtool` and the Artifact Signing client
itself, with SHA-256 digests and Microsoft's timestamp server
(`http://timestamp.acs.microsoft.com`). It authenticates only with the
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` of an Entra app
registration that has the Artifact Signing Certificate Profile Signer role; the other
Azure credential types are turned off so CI never waits on a login. Signing is retried
up to 3 times.

## Notes from building it

- Reverse proxies in front of the server need `client_max_body_size 0;` and
  `proxy_request_buffering off;`, or large uploads fail. Don't put the upload hostname
  behind Cloudflare's proxy, which caps request bodies at 100 MB.
- The server reads the whole update file into memory to check its Sparkle signature,
  which is fine for normal app sizes.
- The macOS workflow fails if the built app's `CFBundleShortVersionString` or
  `CFBundleVersion` doesn't match the tag. It passes `--minimum-system-version` from
  `LSMinimumSystemVersion`, and `--notes-file` from an annotated tag's message.
- macOS release output goes to `dist/apps-release/` in the app repo. That folder holds a
  `.gitignore` of `*`, so it never shows in `git status` or gets committed.
- `scripts/mac/app-icon.sh <App.app> <out.png>` writes a 256-pixel PNG of the app's
  icon, from the `.icns` in `CFBundleIconFile` or, for asset catalog icons
  (`CFBundleIconName`), by asking AppKit to draw it. It writes nothing for an app with
  no icon of its own, so the page shows the initial rather than the generic app icon.
- `scripts/mac/release-local.sh <version>` runs the macOS pipeline from a Mac when the
  runner is down. `DRY_RUN=1` stops after signing. There's no local Windows release yet.
- Artifact Signing signs with a certificate that lasts 3 days, but the timestamp keeps
  every signature valid after it expires. Nothing needs re-signing.
- Not supported yet: separate x64 and arm64 Windows builds (WinSparkle's
  `sparkle:os="windows-x64"`), Linux, and withdrawing one platform of a release.
