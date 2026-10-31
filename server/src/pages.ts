import { fileWithRole, liveReleases } from './feeds.ts';
import { escapeHtml, markdownToHtml } from './markdown.ts';
import type { AppRecord, Release } from './store.ts';

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f8;--card:#fff;--text:#1d1d1f;--muted:#6e6e73;--line:#e3e3e8;--accent:#0a66ff;--accent-text:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--card:#1c1c1f;--text:#f2f2f4;--muted:#9a9aa1;--line:#2c2c31;--accent:#3d8bff}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;align-items:center}
main{width:100%;max-width:560px;padding:72px 24px 32px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:36px}
.mark{width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,var(--accent),#7b5cff);color:#fff;display:grid;place-items:center;font-size:30px;font-weight:650;margin-bottom:20px}
h1{font-size:28px;line-height:1.2;margin:0 0 6px;letter-spacing:-.01em}
.meta{color:var(--muted);font-size:14px;margin:0 0 24px}
.button{display:inline-block;background:var(--accent);color:var(--accent-text);text-decoration:none;font-weight:600;padding:12px 22px;border-radius:12px}
.button:hover{filter:brightness(1.08)}
.req{color:var(--muted);font-size:13px;margin:12px 0 0}
section{margin-top:32px;padding-top:24px;border-top:1px solid var(--line)}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 12px;font-weight:600}
h3{font-size:16px;margin:16px 0 4px}
.notes p,.notes ul{margin:0 0 10px}.notes ul{padding-left:20px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);padding:1px 5px;border-radius:5px}
a{color:var(--accent)}
ul.list{list-style:none;padding:0;margin:0}
ul.list li{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}
ul.list li:last-child{border-bottom:0}
ul.list a{text-decoration:none;font-weight:600}
.muted{color:var(--muted)}
footer{color:var(--muted);font-size:12px;padding:0 24px 32px}
`;

function page(title: string, body: string, remote: string): string {
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
<footer>${escapeHtml(remote)} apps</footer>
</body>
</html>
`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 100_000_000 ? 1 : 0)} MB`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function indexPage(remote: string, apps: { app: AppRecord; latest: Release | undefined }[]): string {
  const items = apps.length
    ? `<ul class="list">${apps
        .map(({ app, latest }) => `<li><a href="${encodeURIComponent(app.name)}/">${escapeHtml(app.title)}</a><span class="muted">${latest ? escapeHtml(latest.version) : 'No releases yet'}</span></li>`)
        .join('')}</ul>`
    : '<p class="muted">No apps yet.</p>';
  return page(`${remote} apps`, `<div class="card"><h1>Apps</h1><p class="meta">Mac apps published on ${escapeHtml(remote)}.</p>${items}</div>`, remote);
}

/** The download page. Links are relative so it also works at an alias host's root. */
export function appPage(remote: string, app: AppRecord, releases: Release[]): string {
  const live = liveReleases(releases);
  const latest = live[0];
  const initial = escapeHtml(app.title.trim().charAt(0).toUpperCase() || '?');
  let body = `<div class="card"><div class="mark" aria-hidden="true">${initial}</div><h1>${escapeHtml(app.title)}</h1>`;

  if (!latest) {
    body += '<p class="meta">No releases yet.</p></div>';
    return page(app.title, body, remote);
  }

  const dmg = fileWithRole(latest, 'dmg');
  const meta = [`Version ${escapeHtml(latest.version)}`, formatDate(latest.publishedAt)];
  if (dmg) meta.push(formatSize(dmg.size));
  body += `<p class="meta">${meta.join(' · ')}</p>`;
  body += '<a class="button" href="download">Download for Mac</a>';
  if (latest.minimumSystemVersion) {
    body += `<p class="req">Requires macOS ${escapeHtml(latest.minimumSystemVersion)} or later.</p>`;
  }
  if (latest.notes.trim()) {
    body += `<section><h2>What’s new</h2><div class="notes">${markdownToHtml(latest.notes)}</div></section>`;
  }
  const older = live.slice(1, 6);
  if (older.length) {
    body += `<section><h2>Earlier versions</h2><ul class="list">${older
      .map((release) => {
        const file = fileWithRole(release, 'dmg');
        const link = file ? `releases/${release.version}/${encodeURIComponent(file.name)}` : '';
        return `<li>${link ? `<a href="${link}">${escapeHtml(release.version)}</a>` : escapeHtml(release.version)}<span class="muted">${formatDate(release.publishedAt)}</span></li>`;
      })
      .join('')}</ul></section>`;
  }
  body += '</div>';
  return page(`Download ${app.title}`, body, remote);
}
