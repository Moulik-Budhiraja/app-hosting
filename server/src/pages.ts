import { downloadFile, platformDate, platformReleases } from './feeds.ts';
import { iconVersion } from './icons.ts';
import { escapeHtml, markdownToHtml } from './markdown.ts';
import type { AppRecord, Platform, Release } from './store.ts';
import { PLATFORMS } from './store.ts';

// The design lives in the Paper file "app-hosting — Download pages redesign".
// Icons are drawn on Apple's grid, with about 10% transparent margin, so icon
// slots pull left by that much to line the visible icon up with the text.
const STYLE = `
:root{color-scheme:light dark;--ground:#f4f5f7;--ink:#1d1d1f;--secondary:#6e6e73;--hairline:rgb(0 0 0/8%);--accent:#0071e3;--tile:#fff;--tile-edge:0 1px 2px rgb(0 0 0/12%),0 0 0 .5px rgb(0 0 0/8%)}
@media (prefers-color-scheme:dark){:root{--ground:#141416;--ink:#f5f5f7;--secondary:#98989d;--hairline:rgb(255 255 255/10%);--accent:#0a84ff;--tile:#2a2a2e;--tile-edge:0 1px 2px rgb(0 0 0/40%),inset 0 0 0 .5px rgb(255 255 255/10%)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/22px -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:728px;margin:0 auto;padding:112px 24px 96px}
a{color:var(--accent);text-decoration:none}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:6px}
h1{margin:0;font-size:34px;line-height:40px;font-weight:700;letter-spacing:-.025em}
h2{margin:0;font-size:17px;line-height:22px;font-weight:600}
.icon{flex-shrink:0;display:flex;align-items:center;justify-content:center}
.icon img{width:100%;height:100%;display:block}
.tile{width:80.5%;height:80.5%;border-radius:22.5%;background:var(--tile);box-shadow:var(--tile-edge);display:flex;align-items:center;justify-content:center;color:var(--secondary);font-weight:600}
.app{display:grid;grid-template-columns:128px 1fr;grid-template-areas:"icon info" "icon get";column-gap:20px;align-items:center;margin-left:-12px}
.app .icon{grid-area:icon;width:128px;height:128px}
.app .tile{font-size:48px}
.info{grid-area:info;align-self:end;min-width:0}
.meta{margin:2px 0 0;color:var(--secondary)}
.get{grid-area:get;align-self:start;display:flex;align-items:center;gap:16px;padding-top:20px}
.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 22px 0 20px;border-radius:10px;background:var(--accent);color:#fff;font-weight:600;white-space:nowrap}
.button:hover{filter:brightness(1.08)}
.button svg{flex-shrink:0}
.req{font-size:13px;line-height:18px;color:var(--secondary)}
.side{display:flex;flex-direction:column;gap:2px}
.also{font-size:13px;line-height:18px;font-weight:500}
section{padding-top:48px}
.app+section{padding-top:64px}
.notes{max-width:560px;padding-top:12px}
.notes p,.notes ul,.notes ol{margin:0 0 12px}
.notes>:last-child{margin-bottom:0}
.notes ul,.notes ol{padding-left:20px}
.notes h3{margin:20px 0 4px;font-size:15px;line-height:22px;font-weight:600}
.notes code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--hairline);padding:1px 5px;border-radius:5px}
.versions{list-style:none;margin:0;padding:8px 0 0}
.versions li{display:grid;grid-template-columns:120px 1fr 80px;align-items:center;height:44px;border-top:1px solid var(--hairline);color:var(--secondary)}
.versions a{font-weight:500;justify-self:start}
.versions .size{text-align:right}
.apps{list-style:none;margin:0;padding:16px 0 0}
.apps a{display:flex;align-items:center;gap:10px;height:84px;margin-left:-7px;color:inherit}
.apps .icon{width:72px;height:72px}
.apps .tile{font-size:27px;border-radius:13px}
.row{flex:1;align-self:stretch;min-width:0;display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--hairline)}
.apps li:last-child .row{border-bottom:0}
.name{display:block;font-size:17px;line-height:22px;font-weight:600}
.sub{display:block;margin-top:2px;font-size:13px;line-height:18px;color:var(--secondary)}
.text{flex:1;min-width:0}
.chevron{flex-shrink:0;color:var(--secondary);opacity:.6}
.apps a:hover .name{color:var(--accent)}
.empty{margin:16px 0 0;color:var(--secondary)}
@media (max-width:600px){
main{padding:32px 20px 64px}
.app{grid-template-columns:100px 1fr;grid-template-areas:"icon info" "get get";column-gap:12px;margin-left:-10px}
.app .icon{width:100px;height:100px}
.app .tile{font-size:36px}
.app h1{font-size:24px;line-height:28px;letter-spacing:-.02em}
.app .meta{margin-top:4px;font-size:13px;line-height:18px}
.info{align-self:center}
.get{flex-direction:column;align-items:stretch;gap:10px;margin-left:10px}
.button{height:50px;border-radius:12px}
.side{align-items:center;gap:12px}
.req,.also{text-align:center}
section{padding-top:40px}
.app+section{padding-top:48px}
.versions li{grid-template-columns:72px 1fr 64px}
.apps{padding-top:8px}
.apps a{height:76px;gap:8px}
.apps .icon{width:64px;height:64px}
.apps .tile{font-size:24px;border-radius:12px}
}
`;

const DOWNLOAD_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRON = '<svg class="chevron" width="8" height="14" viewBox="0 0 8 14" fill="none" aria-hidden="true"><path d="M1.5 1.5 6.5 7l-5 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 100_000_000 ? 1 : 0)} MB`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** "14.0" reads as "macOS 14", "13.5" as "macOS 13.5". */
export function formatMacOS(version: string): string {
  return `macOS ${version.replace(/(\.0)+$/, '')}`;
}

/** "10.0" reads as "Windows 10", "10.0.17763" as "Windows 10 build 17763", "10.0.22000" as "Windows 11". */
export function formatWindows(version: string): string {
  const [major = '', minor = '0', build] = version.split('.');
  const base = minor === '0' ? major : `${major}.${minor}`;
  if (base === '10' && build && Number(build) >= 22000) {
    return build === '22000' ? 'Windows 11' : `Windows 11 build ${build}`;
  }
  return build ? `Windows ${base} build ${build}` : `Windows ${base}`;
}

const BUTTON_LABELS: Record<Platform, string> = { mac: 'Download for Mac', windows: 'Download for Windows' };
const ALSO_LABELS: Record<Platform, string> = { mac: 'Also for Mac', windows: 'Also for Windows' };

/** The app's icon, or a tile with its initial. `base` is the path from the page to the app's folder. */
function appIcon(app: AppRecord, base: string): string {
  const version = iconVersion(app);
  if (version) return `<span class="icon"><img src="${base}icon.png?v=${version}" alt=""></span>`;
  const initial = escapeHtml(app.title.trim().charAt(0).toUpperCase() || '?');
  return `<span class="icon"><span class="tile" aria-hidden="true">${initial}</span></span>`;
}

export function indexPage(remote: string, apps: { app: AppRecord; latest: Release | undefined }[]): string {
  const list = apps.length
    ? `<ul class="apps">${apps
        .map(({ app, latest }) => {
          const base = `${encodeURIComponent(app.name)}/`;
          const sub = latest ? `Version ${escapeHtml(latest.version)}` : 'No releases yet';
          return `<li><a href="${base}">${appIcon(app, base)}<span class="row"><span class="text"><span class="name">${escapeHtml(app.title)}</span><span class="sub">${sub}</span></span>${CHEVRON}</span></a></li>`;
        })
        .join('')}</ul>`
    : '<p class="empty">No apps yet</p>';
  return page(`${remote} apps`, `<h1>Apps</h1>${list}`);
}

/**
 * Which platform a download page shows: the one asked for, else the visitor's,
 * else macOS, else Windows, among those with live releases. Null when there are none.
 */
export function pagePlatform(releases: Release[], requested: Platform | null, visitor: Platform | null): Platform | null {
  const available = PLATFORMS.filter((platform) => platformReleases(releases, platform).length > 0);
  for (const candidate of [requested, visitor, ...PLATFORMS]) {
    if (candidate && available.includes(candidate)) return candidate;
  }
  return null;
}

/** The download page for one platform. Links are relative so it also works at an alias host's root. */
export function appPage(
  _remote: string,
  app: AppRecord,
  releases: Release[],
  choice: { requested: Platform | null; visitor: Platform | null } = { requested: null, visitor: null },
): string {
  const title = `<h1>${escapeHtml(app.title)}</h1>`;
  const platform = pagePlatform(releases, choice.requested, choice.visitor);
  if (!platform) {
    const body = `<header class="app">${appIcon(app, '')}<div class="info">${title}<p class="meta">No releases yet</p></div></header>`;
    return page(app.title, body);
  }

  const live = platformReleases(releases, platform);
  const latest = live[0]!;
  const file = downloadFile(latest, platform);
  const minimum = latest.platforms[platform]?.minimumSystemVersion;
  const system = minimum ? `${platform === 'mac' ? formatMacOS(minimum) : formatWindows(minimum)} or later` : '';
  const requirements = [file ? formatSize(file.size) : '', system].filter(Boolean).map(escapeHtml).join(' · ');
  const other = PLATFORMS.find((candidate) => candidate !== platform && platformReleases(releases, candidate).length > 0);

  let body = `<header class="app">${appIcon(app, '')}<div class="info">${title}<p class="meta">Version ${escapeHtml(latest.version)} · ${formatDate(platformDate(latest, platform))}</p></div>`;
  body += `<div class="get"><a class="button" href="download/${platform}">${DOWNLOAD_ICON}${BUTTON_LABELS[platform]}</a>`;
  const side = (requirements ? `<span class="req">${requirements}</span>` : '')
    + (other ? `<a class="also" href="?platform=${other}">${ALSO_LABELS[other]}</a>` : '');
  if (side) body += `<span class="side">${side}</span>`;
  body += '</div></header>';

  if (latest.notes.trim()) {
    body += `<section><h2>What’s new</h2><div class="notes">${markdownToHtml(latest.notes)}</div></section>`;
  }
  const older = live.slice(1, 6);
  if (older.length) {
    body += `<section><h2>Earlier versions</h2><ul class="versions">${older
      .map((release) => {
        const olderFile = downloadFile(release, platform);
        const version = escapeHtml(release.version);
        const link = olderFile ? `<a href="releases/${release.version}/${encodeURIComponent(olderFile.name)}">${version}</a>` : `<span>${version}</span>`;
        return `<li>${link}<span>${formatDate(platformDate(release, platform))}</span><span class="size">${olderFile ? formatSize(olderFile.size) : ''}</span></li>`;
      })
      .join('')}</ul></section>`;
  }
  return page(`Download ${app.title}`, body);
}
