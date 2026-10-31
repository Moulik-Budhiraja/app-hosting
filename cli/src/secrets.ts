import { CliError, EXIT } from "./errors.js";

export const TOKEN_SERVICE = "apps-cli";
export const SPARKLE_SERVICE = "apps-cli-sparkle";

/** Where tokens and Sparkle keys live. The keychain in real use, memory in tests. */
export interface SecretStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
}

function storeError(error: unknown): CliError {
  const detail = error instanceof Error ? error.message : String(error);
  return new CliError(
    `Couldn't use the keychain: ${detail}. In CI, set APPS_TOKEN (and SPARKLE_PRIVATE_KEY) instead.`,
    EXIT.auth,
    "KEYCHAIN_UNAVAILABLE",
  );
}

export function keyringStore(): SecretStore {
  let entryClass: Promise<typeof import("@napi-rs/keyring").Entry> | undefined;
  const entry = async (service: string, account: string) => {
    entryClass ??= import("@napi-rs/keyring").then((module) => module.Entry);
    try {
      const Entry = await entryClass;
      return new Entry(service, account);
    } catch (error) {
      throw storeError(error);
    }
  };
  return {
    async get(service, account) {
      const item = await entry(service, account);
      try {
        return item.getPassword() ?? null;
      } catch (error) {
        throw storeError(error);
      }
    },
    async set(service, account, value) {
      const item = await entry(service, account);
      try {
        item.setPassword(value);
      } catch (error) {
        throw storeError(error);
      }
    },
    async delete(service, account) {
      const item = await entry(service, account);
      try {
        return item.deleteCredential();
      } catch (error) {
        throw storeError(error);
      }
    },
  };
}

export function memoryStore(initial: Record<string, string> = {}): SecretStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  const key = (service: string, account: string) => `${service}\u0000${account}`;
  return {
    values,
    async get(service, account) {
      return values.get(key(service, account)) ?? null;
    },
    async set(service, account, value) {
      values.set(key(service, account), value);
    },
    async delete(service, account) {
      return values.delete(key(service, account));
    },
  };
}

export function sparkleAccount(remote: string, app: string): string {
  return `${remote}/${app}`;
}
