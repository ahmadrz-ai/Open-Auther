/**
 * Keeping a Claude key's alias map filled in.
 *
 * Assignment is lazy rather than done at key creation: a key is often made
 * before any provider is connected, and a map computed against an empty pool
 * would be empty forever. Filling it on first use means the names point at
 * whatever the pool actually had when the client first asked.
 *
 * Separate from `keys.ts` because it needs to persist, and `config.ts` already
 * depends on `keys.ts` for the key shape.
 */

import { persistConfig, type Config } from "../config.js";
import { assignClaudeAliases, type GatewayKey } from "./keys.js";
import { createLogger } from "../logging.js";

const log = createLogger({ mod: "key-aliases" });

/**
 * Return this key's Claude aliases, filling any gaps and persisting the result.
 *
 * Existing assignments are never moved while their target is still servable,
 * so a client that pinned a name keeps getting the same model. Only genuinely
 * new or now-unservable slots are recomputed, and the config is written only
 * when something actually changed.
 */
export function ensureAliases(
  cfg: Config,
  key: GatewayKey,
  models: string[],
): Record<string, string> {
  const existing = key.claudeAliases ?? {};
  const next = assignClaudeAliases({
    models,
    existing,
    overrides: cfg.modelCapabilities,
  });

  const changed =
    Object.keys(next).length !== Object.keys(existing).length ||
    Object.entries(next).some(([tier, model]) => existing[tier] !== model);

  if (changed) {
    const updated = cfg.gatewayKeys.map((k) =>
      k.name === key.name ? { ...k, claudeAliases: next } : k,
    );
    persistConfig(cfg, { gatewayKeys: updated });
    // Keep the object the request is already holding in step with what was
    // written, or this same request resolves against the stale map.
    key.claudeAliases = next;
    log.info("claude_aliases_assigned", { key: key.name, count: Object.keys(next).length });
  }
  return next;
}
