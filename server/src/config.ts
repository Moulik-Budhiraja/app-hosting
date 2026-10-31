export interface Config {
  /** Base URL used in feeds and API responses, without a trailing slash. */
  publicUrl: string;
  /** The remote's name, such as "moulik". Shown on pages and in whoami. */
  remoteName: string;
  adminToken: string;
  dataDir: string;
  port: number;
  /** Host name → app name, for hosts that serve one app at their root. */
  hostAliases: Map<string, string>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = (env.APPS_PUBLIC_URL ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(publicUrl)) {
    throw new Error('APPS_PUBLIC_URL must be an origin like https://apps.moulik.dev');
  }
  const remoteName = env.APPS_REMOTE_NAME ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(remoteName)) {
    throw new Error('APPS_REMOTE_NAME must be a short lowercase name like moulik');
  }
  const adminToken = env.APPS_ADMIN_TOKEN ?? '';
  if (adminToken.length < 32) {
    throw new Error('APPS_ADMIN_TOKEN must be at least 32 characters');
  }
  const port = Number(env.APPS_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('APPS_PORT must be a port number');
  }
  return {
    publicUrl,
    remoteName,
    adminToken,
    dataDir: env.APPS_DATA_DIR || '/data',
    port,
    hostAliases: parseHostAliases(env.APPS_HOST_ALIASES ?? ''),
  };
}

export function parseHostAliases(value: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [host, app, extra] = trimmed.split('=').map((part) => part.trim().toLowerCase());
    if (!host || !app || extra !== undefined) {
      throw new Error(`APPS_HOST_ALIASES entry "${trimmed}" should look like host=app`);
    }
    aliases.set(host, app);
  }
  return aliases;
}
