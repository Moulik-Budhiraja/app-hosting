import { escapeHtml, markdownToHtml } from './markdown.ts';
import type { AppRecord, Platform, Release, ReleaseFile, Role, Updater } from './store.ts';

export const PLATFORM_NAMES: Record<Platform, string> = { mac: 'macOS', windows: 'Windows' };

/** Each updater's feed file names, and the platform each one serves. */
export const FEEDS: Record<Updater, Record<string, Platform>> = {
  sparkle: { 'appcast.xml': 'mac', 'appcast-windows.xml': 'windows' },
  electron: { 'latest-mac.yml': 'mac', 'latest.yml': 'windows' },
};

export function feedName(updater: Updater, platform: Platform): string {
  return Object.entries(FEEDS[updater]).find(([, served]) => served === platform)![0];
}

/** The visitor's platform from their User-Agent, or null when it's neither. */
export function detectPlatform(userAgent: string | undefined): Platform | null {
  if (!userAgent) return null;
  if (userAgent.includes('Windows')) return 'windows';
  if (/Macintosh|Mac OS X|Darwin/.test(userAgent)) return 'mac';
  return null;
}

export function liveReleases(releases: Release[]): Release[] {
  return releases.filter((release) => !release.withdrawn);
}

export function hasPlatform(release: Release, platform: Platform): boolean {
  return release.files.some((file) => file.platform === platform);
}

/** A platform's live releases: not withdrawn and with files for it, newest first. */
export function platformReleases(releases: Release[], platform: Platform): Release[] {
  return liveReleases(releases).filter((release) => hasPlatform(release, platform));
}

export function fileWithRole(release: Release, platform: Platform, role: Role): ReleaseFile | undefined {
  return release.files.find((file) => file.platform === platform && file.role === role);
}

/** The file people download on a platform: the DMG on macOS, the installer on Windows. */
export function downloadFile(release: Release, platform: Platform): ReleaseFile | undefined {
  return fileWithRole(release, platform, platform === 'mac' ? 'dmg' : 'installer');
}

/** When a platform of a release was published. */
export function platformDate(release: Release, platform: Platform): string {
  return release.platforms[platform]?.publishedAt ?? release.publishedAt;
}

/** Path of a release file relative to the app's root, such as releases/1.2.3/App.dmg. */
export function releasePath(release: Release, file: ReleaseFile): string {
  return `releases/${release.version}/${encodeURIComponent(file.name)}`;
}

function cdata(text: string): string {
  return `<![CDATA[${text.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

/**
 * A Sparkle appcast with every live release for one platform, newest first:
 * appcast.xml for Sparkle on macOS, appcast-windows.xml for WinSparkle.
 * WinSparkle compares sparkle:version with the app's own X.Y.Z, so it gets the version, not the build.
 */
export function sparkleAppcast(app: AppRecord, releases: Release[], publicUrl: string, platform: Platform = 'mac'): string {
  const base = `${publicUrl}/${app.name}/`;
  const items = platformReleases(releases, platform).map((release) => {
    const file = downloadFile(release, platform);
    if (!file) return '';
    const info = release.platforms[platform];
    const lines = [
      '    <item>',
      `      <title>${escapeHtml(release.version)}</title>`,
      `      <pubDate>${new Date(platformDate(release, platform)).toUTCString()}</pubDate>`,
      `      <sparkle:version>${platform === 'mac' ? release.build : escapeHtml(release.version)}</sparkle:version>`,
      `      <sparkle:shortVersionString>${escapeHtml(release.version)}</sparkle:shortVersionString>`,
    ];
    if (info?.minimumSystemVersion) {
      lines.push(`      <sparkle:minimumSystemVersion>${escapeHtml(info.minimumSystemVersion)}</sparkle:minimumSystemVersion>`);
    }
    if (release.notes.trim()) {
      lines.push(`      <description>${cdata(markdownToHtml(release.notes))}</description>`);
    }
    const os = platform === 'windows' ? ' sparkle:os="windows"' : '';
    lines.push(
      `      <enclosure url="${escapeHtml(base + releasePath(release, file))}" length="${file.size}" type="application/octet-stream"${os} sparkle:edSignature="${escapeHtml(file.edSignature ?? '')}"/>`,
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
 * electron-updater's feed for a platform's latest release: latest-mac.yml (the
 * zip) or latest.yml (the NSIS installer). Null when there is none. URLs are
 * relative to /<app>/, where the feed is served. Strings are JSON-quoted, which
 * is valid YAML.
 */
export function electronLatest(releases: Release[], platform: Platform = 'mac'): string | null {
  const release = platformReleases(releases, platform)[0];
  if (!release) return null;
  const update = fileWithRole(release, platform, platform === 'mac' ? 'zip' : 'installer');
  if (!update) return null;
  const blockmap = fileWithRole(release, platform, 'blockmap');
  const info = release.platforms[platform];
  const q = (value: string) => JSON.stringify(value);
  const url = releasePath(release, update);
  const lines = [
    `version: ${q(release.version)}`,
    'files:',
    `  - url: ${q(url)}`,
    `    sha512: ${q(update.sha512)}`,
    `    size: ${update.size}`,
  ];
  if (blockmap) lines.push(`    blockMapSize: ${blockmap.size}`);
  lines.push(
    `path: ${q(url)}`,
    `sha512: ${q(update.sha512)}`,
    `releaseDate: ${q(platformDate(release, platform))}`,
  );
  if (info?.minimumSystemVersion) lines.push(`minimumSystemVersion: ${q(info.minimumSystemVersion)}`);
  if (release.notes.trim()) lines.push(`releaseNotes: ${q(release.notes)}`);
  return `${lines.join('\n')}\n`;
}
