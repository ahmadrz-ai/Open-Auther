/**
 * Image parts, and getting them onto the wire.
 *
 * Every transport except Codex used to flatten a message's content parts with
 * `parts.map(p => p.text).join("")`. An image part carries no `text`, so it
 * contributed an empty string and vanished — and an image-only message
 * flattened to `""`, which the Gemini builder then skipped entirely as an
 * empty turn. Images were accepted by the gateway, logged as sent, and never
 * actually left the process.
 *
 * That is why lifting the capability gate did not make vision work on its own:
 * the gate was the second of two problems, and this was the first.
 *
 * All three provider schemas accept both an inline base64 payload and a remote
 * URL, so nothing here needs to fetch anything — each transport just has to
 * say it in its own dialect.
 */

/** A normalised image reference, in whichever form the client supplied. */
export type ImagePart =
  | { kind: "base64"; mimeType: string; data: string }
  | { kind: "url"; mimeType: string | null; url: string };

const DATA_URL = /^data:([^;,]+)(;[^,]*)?,(.*)$/s;

/** Guess a media type from a URL's extension, for schemas that require one. */
function mimeFromUrl(url: string): string | null {
  const match = /\.(png|jpe?g|gif|webp|heic|heif|bmp)(?:[?#]|$)/i.exec(url);
  if (!match) return null;
  const ext = match[1]!.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "heif") return "image/heic";
  return `image/${ext}`;
}

/**
 * Parse whatever a client put in `image_url`.
 *
 * Returns null for anything unusable, so a malformed part is dropped rather
 * than sent upstream to produce an opaque 400.
 */
export function parseImagePart(raw: unknown): ImagePart | null {
  const url = typeof raw === "string" ? raw.trim() : "";
  if (!url) return null;

  const data = DATA_URL.exec(url);
  if (data) {
    const mimeType = data[1]!.trim() || "image/png";
    const encoding = (data[2] ?? "").toLowerCase();
    const payload = data[3] ?? "";
    if (!payload) return null;
    // A data: URL without `;base64` is percent-encoded text, which is not an
    // image any provider will take.
    if (!encoding.includes("base64")) return null;
    return { kind: "base64", mimeType, data: payload.replace(/\s+/g, "") };
  }

  if (/^https?:\/\//i.test(url)) {
    return { kind: "url", mimeType: mimeFromUrl(url), url };
  }
  return null;
}

/** One normalised content part, as `toCodexRequest` emits them. */
export interface NormalisedPart {
  type?: unknown;
  text?: unknown;
  image_url?: unknown;
}

export function isImagePart(part: NormalisedPart): boolean {
  return part?.type === "input_image" || part?.type === "image_url";
}

/** Every image in a content-part array, in order. */
export function imagesOf(content: unknown): ImagePart[] {
  if (!Array.isArray(content)) return [];
  const out: ImagePart[] = [];
  for (const part of content as NormalisedPart[]) {
    if (!isImagePart(part)) continue;
    const parsed = parseImagePart(part.image_url);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** The text of a content-part array, ignoring images. */
export function textOfParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as NormalisedPart[])
    .filter((part) => !isImagePart(part))
    .map((part) => String(part.text ?? ""))
    .join("");
}

/** True when a content-part array carries at least one usable image. */
export function hasImages(content: unknown): boolean {
  return imagesOf(content).length > 0;
}

// ---------------------------------------------------------------------------
// Per-provider encodings

/** Gemini: `inlineData` for a payload, `fileData` for a URI. */
export function toGeminiPart(image: ImagePart): Record<string, unknown> {
  if (image.kind === "base64") {
    return { inlineData: { mimeType: image.mimeType, data: image.data } };
  }
  return { fileData: { mimeType: image.mimeType ?? "image/png", fileUri: image.url } };
}

/** OpenAI Chat Completions: an `image_url` part, in the form it arrived. */
export function toOpenAiPart(image: ImagePart): Record<string, unknown> {
  const url =
    image.kind === "base64" ? `data:${image.mimeType};base64,${image.data}` : image.url;
  return { type: "image_url", image_url: { url } };
}

/** Anthropic: an `image` block with either a base64 or url source. */
export function toAnthropicPart(image: ImagePart): Record<string, unknown> {
  if (image.kind === "base64") {
    return {
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data },
    };
  }
  return { type: "image", source: { type: "url", url: image.url } };
}
