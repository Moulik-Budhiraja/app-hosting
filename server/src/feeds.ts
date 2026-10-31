import { escapeHtml, markdownToHtml } from './markdown.ts';
import type { AppRecord, Release, ReleaseFile } from './store.ts';

export function liveReleases(releases: Release[]): Release[] {
  return releases.filter((release) => !release.withdrawn);
}

export function fileWithRole(release: Release, role: ReleaseFile['role']): ReleaseFile | undefined {
  return release.files.find((file) => file.role === role);
}

/** Path of a release file relative to the app's root, such as releases/1.2.3/App.dmg. */
export function releasePath(release: Release, file: ReleaseFile): string {
  return `releases/${release.version}/${encodeURIComponent(file.name)}`;
}

function cdata(text: string): string {
  return `<![CDATA[${text.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

/** Sparkle appcast with every live release, newest first. */
export function sparkleAppcast(app: AppRecord, releases: Release[], publicUrl: string): string {
  const base = `${publicUrl}/${app.name}/`;
  const items = liveReleases(releases).map((release) => {
    const dmg = fileWithRole(release, 'dmg');
    if (!dmg) return '';
    const lines = [
      '    <item>',
      `      <title>${escapeHtml(release.version)}</title>`,
      `      <pubDate>${new Date(release.publishedAt).toUTCString()}</pubDate>`,
      `      <sparkle:version>${release.build}</sparkle:version>`,
      `      <sparkle:shortVersionString>${escapeHtml(release.version)}</sparkle:shortVersionString>`,
    ];
    if (release.minimumSystemVersion) {
      lines.push(`      <sparkle:minimumSystemVersion>${escapeHtml(release.minimumSystemVersion)}</sparkle:minimumSystemVersion>`);
    }
    if (release.notes.trim()) {
      lines.push(`      <description>${cdata(markdownToHtml(release.notes))}</description>`);
    }
    lines.push(
      `      <enclosure url="${escapeHtml(base + releasePath(release, dmg))}" length="${dmg.size}" type="application/octet-stream" sparkle:edSignature="${escapeHtml(release.edSignature ?? '')}"/>`,
      '    </item>',
    );
    return lines.join('\n');
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '  <channel>',
    `    <title>${escapeHtml(app.title)}</title>`,
    `    <link>${escapeHtml(base)}</link>`,
    `    <description>${escapeHtml(`Updates for ${app.title}`)}</description>`,
    '    <language>en</language>',
    ...items.filter(Boolean),
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

/**
 * electron-updater's latest-mac.yml for the newest live release, or null when
 * there is none. URLs are relative to /<app>/, where the feed is served. Strings
 * are JSON-quoted, which is valid YAML.
 */
export function electronLatestMac(releases: Release[]): string | null {
  const release = liveReleases(releases)[0];
  if (!release) return null;
  const zip = fileWithRole(release, 'zip');
  if (!zip) return null;
  const blockmap = fileWithRole(release, 'blockmap');
  const q = (value: string) => JSON.stringify(value);
  const zipUrl = releasePath(release, zip);
  const lines = [
    `version: ${q(release.version)}`,
    'files:',
    `  - url: ${q(zipUrl)}`,
    `    sha512: ${q(zip.sha512)}`,
    `    size: ${zip.size}`,
  ];
  if (blockmap) lines.push(`    blockMapSize: ${blockmap.size}`);
  lines.push(
    `path: ${q(zipUrl)}`,
    `sha512: ${q(zip.sha512)}`,
    `releaseDate: ${q(release.publishedAt)}`,
  );
  if (release.minimumSystemVersion) lines.push(`minimumSystemVersion: ${q(release.minimumSystemVersion)}`);
  if (release.notes.trim()) lines.push(`releaseNotes: ${q(release.notes)}`);
  return `${lines.join('\n')}\n`;
}
