/**
 * Web-session ("cookie") providers.
 *
 * These route through a consumer web app's own private API using the session
 * credential from a signed-in browser, rather than an API key. That has
 * consequences worth stating plainly:
 *
 *  - A session credential is closer to a password than to an API key. It can
 *    usually act as the whole signed-in account, not just its chat.
 *  - Private web APIs are not contracts. They change without notice, and each
 *    one breaks independently.
 *  - Using a subscription this way is against most of these services' terms.
 *
 * Each provider needs its own transport, so they are added one at a time and
 * `implemented` says which actually work. A provider listed but unimplemented
 * is shown greyed out rather than offered and then failing.
 */

export type WebCredentialKind = "cookie" | "token";

export interface WebCookieProviderDef {
  id: string;
  label: string;
  /** Where the user signs in to get the credential. */
  website: string;
  blurb: string;
  kind: WebCredentialKind;
  /** Human name of the credential to copy, shown in the instructions. */
  credentialName: string;
  placeholder: string;
  /** Extra provider-specific warning, beyond the generic one. */
  note?: string;
  /** False until a transport exists for it. */
  implemented: boolean;
  defaultModels: string[];
}

export const WEB_COOKIE_PROVIDERS: WebCookieProviderDef[] = [
  {
    id: "kimi-web",
    label: "Kimi Web (Moonshot)",
    website: "https://www.kimi.com",
    blurb: "Moonshot's consumer Kimi chat, using the signed-in web session.",
    kind: "token",
    credentialName: "access_token",
    placeholder: "access_token=… (or paste the raw token)",
    note:
      "Kimi stores its token in localStorage, not a cookie. In DevTools open " +
      "Application → Local Storage → www.kimi.com and copy the access_token value.",
    implemented: true,
    defaultModels: ["kimi-k2", "kimi-k2-thinking", "kimi-k3"],
  },
  {
    id: "gemini-web",
    label: "Gemini Web (Free)",
    website: "https://gemini.google.com",
    blurb: "Google's consumer Gemini app.",
    kind: "cookie",
    credentialName: "__Secure-1PSID (optional: __Secure-1PSIDTS)",
    placeholder: "__Secure-1PSID=…; __Secure-1PSIDTS=…",
    note:
      "Not implemented here on purpose: the only known way to drive this one is a " +
      "real headless Chromium, which is the kind of weight this gateway exists to avoid.",
    implemented: false,
    defaultModels: [],
  },
  {
    id: "chatgpt-web",
    label: "ChatGPT Web (Plus/Pro)",
    website: "https://chatgpt.com",
    blurb: "A signed-in ChatGPT session, as opposed to the Codex OAuth path.",
    kind: "cookie",
    credentialName: "__Secure-next-auth.session-token",
    placeholder: "__Secure-next-auth.session-token=…",
    implemented: false,
    defaultModels: [],
  },
  {
    id: "deepseek-web",
    label: "DeepSeek Web",
    website: "https://chat.deepseek.com",
    blurb: "DeepSeek's consumer chat.",
    kind: "cookie",
    credentialName: "userToken",
    placeholder: "paste the full Cookie header from chat.deepseek.com",
    note:
      "Not implemented yet: DeepSeek's web API requires solving a proof-of-work " +
      "challenge per request, which needs its WASM solver.",
    implemented: false,
    defaultModels: [],
  },
  {
    id: "qwen-web",
    label: "Qwen Web (Free)",
    website: "https://chat.qwen.ai",
    blurb: "Alibaba's Qwen consumer chat.",
    kind: "cookie",
    credentialName: "token",
    placeholder: "token=…",
    implemented: false,
    defaultModels: [],
  },
];

export const WEB_COOKIE_BY_ID = new Map(WEB_COOKIE_PROVIDERS.map((p) => [p.id, p]));

/**
 * Pull the usable credential out of whatever the user pasted.
 *
 * People paste a full `Cookie:` header, a single `name=value` pair, or the
 * bare value. All three are accepted; anything else returns empty so the
 * caller can say so rather than storing junk that fails later.
 */
export function extractWebCredential(providerId: string, raw: string): string {
  const input = String(raw ?? "").trim();
  if (!input) return "";

  // `Authorization: Bearer x` or plain `Bearer x`.
  const bearer = input.match(/^(?:authorization:\s*)?bearer\s+([^;\s]+)/i);
  if (bearer?.[1]) return bearer[1];

  // Tolerate a pasted `Cookie: ` prefix.
  const body = input.replace(/^cookie:\s*/i, "").trim();

  const keys = COOKIE_KEYS[providerId] ?? [];
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = body.match(new RegExp(`(?:^|[\\s;])${escaped}=([^;\\s]+)`));
    if (match?.[1]) return match[1];
  }

  // A bare value with no cookie syntax at all.
  if (!body.includes("=") && !body.includes(";")) return body;
  return "";
}

/** Credential names to look for, most specific first. */
const COOKIE_KEYS: Record<string, string[]> = {
  "kimi-web": ["access_token", "kimi-auth"],
  "gemini-web": ["__Secure-1PSID"],
  "chatgpt-web": ["__Secure-next-auth.session-token"],
  "deepseek-web": ["userToken"],
  "qwen-web": ["token"],
};

/**
 * Generic instructions, rendered above the input. Deliberately the same shape
 * for every provider so the page reads consistently.
 */
export function credentialInstructions(def: WebCookieProviderDef): string[] {
  return [
    `Sign in to ${def.label} in your browser at ${def.website}.`,
    def.kind === "token"
      ? "Open DevTools → Application → Local Storage and find the value named below."
      : "Open DevTools → Application → Cookies and find the cookie named below.",
    "Copy only the value. A full Cookie header is fine too — the name is picked out for you.",
    "Paste it here and check the connection. When it stops working, sign in again and replace it.",
  ];
}
