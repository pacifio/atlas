/**
 * The agent's icon as a PNG file for an OS banner (`Notification.imagePath`).
 *
 * Resolution mirrors `AgentGlyph` (first-party mark tinted with its brand hue,
 * the Atlas mark for the native agent, a registry agent's manifest SVG) so the
 * banner shows what the in-app surfaces show. No monogram: a letter is not an
 * icon worth a thumbnail, so an agent without a mark gets no image.
 *
 * Rasterised in the webview — the marks are React/SVG already and the browser
 * rasterises them exactly as it does on screen; Rust has no SVG rasteriser in
 * the lockfile (resvg/usvg are absent) and adding one is not worth a crate for
 * a 128px glyph. The PNG is handed to `notifier_icon_store`, which writes it
 * once under `<app cache>/notification-icons/<key>.png`.
 *
 * Cache: the key is agent + colour scheme + a hash of the exact icon source, so
 * a changed manifest icon or a theme flip gets a new file. In memory a map of
 * key → in-flight/settled path means nothing re-renders per notification; on
 * disk `notifier_icon_lookup` means nothing re-renders per app run either.
 * Every failure resolves to `undefined` — the banner just shows without an image.
 */
import { createElement } from "react";
import atlasIconUrl from "@/assets/atlas-icon.svg";
import { AgentIcons } from "@/components/brand-marks";
import { agentBrandColor } from "@/features/agents/lib/agent-brand";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { notifierIconLookup, notifierIconStore } from "@/features/notifications/lib/notifier-api";

export type IconScheme = "light" | "dark";

/** Rasterised edge in px — crisp as a 2x thumbnail without being heavy. */
const SIZE = 128;
const PADDING = 12;

/** Mono marks follow the OS appearance, which is what themes the banner. */
const MONO_FOREGROUND: Record<IconScheme, string> = {
  light: "#1c1c1e",
  dark: "#f2f2f7",
};

export type IconSource = { kind: "svg"; svg: string } | { kind: "url"; url: string };

/** 53-bit string hash (cyrb53), hex — sync, dependency-free, plenty for a cache key. */
export function hashString(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** Decode an `data:image/svg+xml` URL's markup; null for anything else. */
export function svgFromDataUrl(dataUrl: string): string | null {
  if (!dataUrl.startsWith("data:image/svg+xml")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  try {
    if (head.includes(";base64")) {
      const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(body);
  } catch {
    return null;
  }
}

/** An SVG file as an `<img>` source. */
function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * The icon `AgentGlyph` would draw for this agent, as something rasterisable —
 * or null when it would draw a monogram. Async only for the lazy
 * `react-dom/server` import; pure otherwise.
 */
export async function iconSourceFor(
  agentType: string,
  scheme: IconScheme,
): Promise<IconSource | null> {
  const mono = MONO_FOREGROUND[scheme];
  // `xmlns` because the markup is loaded as a standalone file through an
  // <img>, where an SVG without its namespace does not render at all.
  const size = { width: SIZE, height: SIZE, xmlns: "http://www.w3.org/2000/svg" };
  const firstParty = (Icon: (typeof AgentIcons)[keyof typeof AgentIcons]) =>
    renderMark(
      createElement(Icon, { ...size, style: { color: agentBrandColor(agentType) ?? mono } }),
    );

  // Same order as AgentGlyph.
  if (agentType.includes("claude")) return firstParty(AgentIcons.Claude);
  if (agentType.includes("codex")) return firstParty(AgentIcons.Codex);
  if (agentType.includes("opencode")) return firstParty(AgentIcons.OpenCode);
  if (agentType.includes("cursor")) return firstParty(AgentIcons.Cursor);
  if (agentType.includes("kilo")) return firstParty(AgentIcons.Kilo);
  if (agentType.includes("atlas-agent")) return { kind: "url", url: atlasIconUrl };

  const dataUrl = agentMeta(agentType).iconDataUrl;
  if (!dataUrl) return null;
  const svg = svgFromDataUrl(dataUrl);
  if (svg === null) return { kind: "url", url: dataUrl };
  // As in `ExternalAgentMark`: `currentColor` inside an <img> is black, so
  // defer-to-caller icons get the scheme's foreground instead.
  return { kind: "svg", svg: svg.replaceAll("currentColor", mono) };
}

async function renderMark(element: ReturnType<typeof createElement>): Promise<IconSource> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  return { kind: "svg", svg: inlineTokenFills(renderToStaticMarkup(element)) };
}

/**
 * Turn the package's token-filled paths into plain fills.
 *
 * `OpenCodeMark` paints its two paths with the Tailwind classes
 * `fill-foreground/25` and `fill-foreground`, so it follows the theme in the
 * app. Rasterised as a standalone file there is no stylesheet, and both paths
 * would come out solid black. Swap each class for `currentColor` (the dim one
 * at a quarter opacity), so the root's `style="color:…"` inks it like every
 * other mark.
 */
export function inlineTokenFills(svg: string): string {
  return svg
    .replaceAll('class="fill-foreground/25"', 'fill="currentColor" fill-opacity="0.25"')
    .replaceAll('class="fill-foreground"', 'fill="currentColor"');
}

/** `<agent>-<scheme>-<hash>`: file-name safe (the Rust side re-validates). */
export function iconCacheKey(agentType: string, scheme: IconScheme, source: IconSource): string {
  const agent = agentType.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "agent";
  const material = source.kind === "svg" ? source.svg : source.url;
  return `${agent}-${scheme}-${hashString(material)}`;
}

function currentScheme(): IconScheme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

async function rasterise(source: IconSource): Promise<Uint8Array> {
  const img = new Image();
  img.src = source.kind === "svg" ? svgDataUrl(source.svg) : source.url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  // Contain within the padded box, preserving aspect (OpenCode/Cursor are tall).
  const box = SIZE - PADDING * 2;
  const w = img.naturalWidth || box;
  const h = img.naturalHeight || box;
  const scale = Math.min(box / w, box / h);
  ctx.drawImage(img, (SIZE - w * scale) / 2, (SIZE - h * scale) / 2, w * scale, h * scale);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG encode failed");
  return new Uint8Array(await blob.arrayBuffer());
}

const paths = new Map<string, Promise<string | undefined>>();

async function resolvePath(agentType: string, scheme: IconScheme): Promise<string | undefined> {
  const source = await iconSourceFor(agentType, scheme);
  if (!source) return undefined;
  const key = iconCacheKey(agentType, scheme, source);
  let path = paths.get(key);
  if (!path) {
    path = (async () => {
      const cached = await notifierIconLookup(key);
      if (cached) return cached;
      return (await notifierIconStore(key, await rasterise(source))) ?? undefined;
    })().catch(() => undefined);
    paths.set(key, path);
    // A failure is not sticky: retry on the next notification.
    void path.then((p) => {
      if (!p) paths.delete(key);
    });
  }
  return path;
}

/** File path of the agent's banner icon, rasterised once and reused; undefined
 *  when it has no icon or anything goes wrong. Never throws. */
export async function agentBannerIconPath(agentType: string): Promise<string | undefined> {
  try {
    return await resolvePath(agentType, currentScheme());
  } catch {
    return undefined;
  }
}
