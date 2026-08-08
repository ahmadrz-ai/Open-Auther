import type { Config } from "../config.js";
import { beginLogin, type LoginHandle } from "./login.js";

export type AuthAdapterKind = "oauth" | "api_key" | "web_cookie";

export interface AuthAdapterContext {
  cfg: Config;
}

export interface AuthAdapter {
  id: string;
  label: string;
  authKind: AuthAdapterKind;
  begin: (
    context: AuthAdapterContext,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => LoginHandle | Promise<LoginHandle>;
}

export class AuthAdapterRegistry {
  private readonly adapters = new Map<string, AuthAdapter>();

  constructor(adapters: AuthAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: AuthAdapter): this {
    const id = adapter.id.trim();
    if (!id) throw new Error("Auth adapter id cannot be empty.");
    if (this.adapters.has(id)) throw new Error(`Auth adapter "${id}" is already registered.`);
    this.adapters.set(id, { ...adapter, id });
    return this;
  }

  get(id: string): AuthAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): AuthAdapter[] {
    return [...this.adapters.values()].map((adapter) => ({ ...adapter }));
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }
}

/** Built-in interactive adapters. API-key and web-cookie flows are intentionally explicit elsewhere. */
export const BUILTIN_AUTH_ADAPTERS = new AuthAdapterRegistry([
  {
    id: "codex",
    label: "ChatGPT / Codex OAuth",
    authKind: "oauth",
    begin: ({ cfg }, options) => beginLogin(cfg, options),
  },
]);
