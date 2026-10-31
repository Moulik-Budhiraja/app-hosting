# Deploying a remote

Each remote is one copy of `server/`, run with Docker Compose behind the host's Nginx
Proxy Manager. The two remotes:

| Remote | URL | Host | Checkout |
| --- | --- | --- | --- |
| `moulik` | https://apps.moulik.dev | hp | `/root/hosting/app-hosting` |
| `proletic` | https://apps.proletic.co | rs | `/root/hosting/production/app-hosting` |

## First time

```sh
git clone https://github.com/Moulik-Budhiraja/app-hosting.git <checkout>
cd <checkout>/deploy
cp .env.example .env && chmod 600 .env      # set APPS_PUBLIC_URL, APPS_REMOTE_NAME, APPS_ADMIN_TOKEN
install -d -m 700 -o 1000 -g 1000 data      # the container runs as node (uid 1000)
docker compose up -d --build
curl -fsS http://127.0.0.1:37650/healthz
```

In Nginx Proxy Manager, add a proxy host for the domain, forwarding to `apps-server`
port `3000` on the `nginx-proxy_default` network, with SSL. Under Advanced, add:

```nginx
client_max_body_size 0;
proxy_request_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

Uploads are DMGs and zips of hundreds of MB, and the server checks their size and hash
itself, so the proxy shouldn't buffer them or cap their size.

Then log in from your Mac with `apps remote add <name> <url>` and `apps login <name>`,
pasting `APPS_ADMIN_TOKEN`.

## Updating

```sh
cd <checkout> && git pull && cd deploy && docker compose up -d --build
```

## Data

Everything lives in `deploy/data`: `apps/<app>/app.json`, the immutable files in
`apps/<app>/releases/<version>/` with `release.json`, publish-token hashes in
`tokens.json`, and staged uploads in `uploads/`, which are removed after 6 hours. Back up
`data/` except `uploads/`. Feeds are rebuilt from the `release.json` files, so a
restored copy serves the same feeds.
