# apps CLI

`apps` publishes auto-updating Mac apps to an apps **remote**: a server that hosts each
app's update feed, downloads and download page. It works like git remotes. The CLI can
be logged in to several remotes, such as `moulik` (apps.moulik.dev) and `proletic`
(apps.proletic.co), and each app lives on exactly one of them. See `../DESIGN.md` for
the full contract.

## Install

```sh
cd cli && npm ci && npm run build && npm link   # puts `apps` on your PATH
```

Needs Node 22 or later, and `gh` for `apps init`.

## Remotes and login

```sh
apps remote add moulik https://apps.moulik.dev
apps remote add proletic https://apps.proletic.co
apps login moulik          # asks for the remote's admin token and keeps it in the keychain
apps remote list
apps logout moulik
```

`apps login moulik --token-stdin` reads the token from stdin instead.

## Set up an app

Run these in the app's repo:

```sh
apps create screen-draw --remote moulik --updater sparkle --title ScreenDraw
apps init --dry-run        # show what init would change
apps init
```

`apps create` registers the app and writes `apps.json`. For Sparkle apps it also
generates the update-signing key: the private key stays in the keychain (service
`apps-cli-sparkle`), and the public key goes to the server and into the app's
`SUPublicEDKey`. Check the `build` section of `apps.json` afterwards.

`apps init` connects the GitHub repo. It:
- creates the `production` environment, deployable only from release tags
- creates a publish token for the app
- sets the Apple signing secrets (from `~/.config/predictor-release`, or `--signing-dir`)
  and the Sparkle key
- writes `.github/workflows/release.yml`

It asks once for the App Store Connect issuer ID and saves it to
`~/.config/apps/config.json`. Running it again replaces the secrets and revokes the
previous token.

Then release by pushing a tag on main, for example `git tag v1.0.0 && git push origin v1.0.0`.

## Publish

CI runs this. You can run it by hand too:

```sh
apps publish --version 1.2.0 --dmg dist/ScreenDraw-1.2.0.dmg --notes-file NOTES.md
apps publish --version 0.5.0 --dmg dist/App.dmg --zip dist/App-0.5.0-mac.zip --blockmap dist/App-0.5.0-mac.zip.blockmap
```

The build number defaults to the version's scheme (`apps build-number 1.2.3` prints
100200300). Override it with `--build`. In CI, `APPS_TOKEN` and `SPARKLE_PRIVATE_KEY`
replace the keychain.

## Other commands

```sh
apps status [--expect 1.2.0]   # latest release and whether the live feed matches (exit 1 if not)
apps releases                  # or: apps releases --app screen-draw --remote moulik
apps withdraw 1.2.0            # take a bad release out of the feed (admin)
apps restore 1.2.0
apps token create|list|revoke  # publish tokens for this app (admin)
```

Every command accepts `--json` for script-safe output and `-C <dir>` to run against
another repo.

## Development

```sh
npm test        # node --test via tsx, against an in-memory fake server
npm run typecheck
npm run build
```
