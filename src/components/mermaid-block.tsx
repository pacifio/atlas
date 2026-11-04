import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { createPortal } from "react-dom";
import { Check, Copy, Download, Maximize2, Minus, Plus, X } from "lucide-react";

import { getActiveTheme } from "@/features/theme/apply-theme";
import { themeBase, themeColor, useThemeVersion } from "@/features/theme/theme-values";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";

// Mermaid is heavy (~500KB) — load it on first diagram render only.
//
// A diagram is an SVG mermaid BUILDS from a `themeVariables` object, not
// something it styles afterwards, so the colours have to be resolved values
// (decision 14) and re-initializing is not enough on its own: an already-drawn
// diagram keeps the palette it was drawn with for ever. `MermaidBlock` watches
// `useThemeVersion()` and re-renders on a theme switch, which is what makes a
// diagram that is already on screen follow the theme rather than the next one
// somebody types.
let counter = 0;
let lastPaletteKey = "";

async function getMermaid() {
  const mod = await import("mermaid");
  const mermaid = mod.default;

  const appearance = getActiveTheme()?.appearance ?? "dark";
  const background = themeBase("background");
  const card = themeBase("card");
  const secondary = themeBase("secondary");
  const foreground = themeBase("foreground");
  const textColor = themeBase("secondary-foreground");
  const border = themeColor("border.strong");
  const line = themeBase("muted-foreground");
  const fontFamily = themeBase("font-sans");

  const paletteKey = [
    appearance,
    background,
    card,
    secondary,
    foreground,
    textColor,
    border,
    line,
    fontFamily,
  ].join("|");
  if (paletteKey !== lastPaletteKey) {
    lastPaletteKey = paletteKey;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // The built-in base that `themeVariables` is layered over. Mermaid
      // derives a long tail of secondary colours (pie slices, gantt bars, note
      // fills) from it, and only the matching one derives them light enough or
      // dark enough to read against the theme's background.
      theme: appearance === "light" ? "default" : "dark",
      themeVariables: {
        darkMode: appearance === "dark",
        background,
        primaryColor: card,
        primaryTextColor: foreground,
        primaryBorderColor: border,
        secondaryColor: secondary,
        tertiaryColor: background,
        lineColor: line,
        textColor,
        // mermaid parses themeVariables itself and bakes the result into its SVG.
        // ratchet-allow: a var() reference would never resolve down that path.
        fontSize: "12px",
        fontFamily,
      },
    });
  }
  return mermaid;
}

/** Best-effort repair of the most common AI-generated Mermaid mistakes so a
 *  slightly-off diagram still renders. Only used as a second attempt after the
 *  original source fails — valid diagrams are never touched. */
function sanitize(src: string): string {
  let s = src.trim();
  // Ensure a diagram header.
  if (
    !/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|mindmap|gantt)/.test(s)
  ) {
    s = `flowchart TD\n${s}`;
  }
  // `subgraph "Title"` → `subgraph s_n["Title"]` (a subgraph needs an id).
  let sg = 0;
  s = s.replace(/subgraph\s+"([^"]+)"/g, (_m, title) => `subgraph sg${sg++}["${title}"]`);
  // Old-style labeled edge `A -- text --> B` → pipe form with a quoted label
  // (handles labels with leading dashes / specials that break the `--` form).
  s = s.replace(
    /([A-Za-z0-9_]+)\s*--\s+([^>\n][^\n]*?)\s+-->\s*([A-Za-z0-9_]+)/g,
    (_m, a, label, b) =>
      `${a} -->|"${String(label).replace(/^-+/, "").replace(/"/g, "'").trim()}"| ${b}`,
  );
  // Quote `[...]`/`{...}`/`(...)` labels that contain risky chars and aren't
  // already quoted.
  const quoteLabels = (text: string, open: string, close: string) => {
    const esc = open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escC = close.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${esc}([^${escC}"]*)${escC}`, "g");
    return text.replace(re, (m, label: string) => {
      if (/[^A-Za-z0-9 _]/.test(label)) {
        return `${open}"${label.replace(/"/g, "'").trim()}"${close}`;
      }
      return m;
    });
  };
  s = quoteLabels(s, "[", "]");
  s = quoteLabels(s, "{", "}");
  return s;
}

/** Render one candidate to SVG, or return null. CRITICAL: gate on `parse`
 *  first — calling `mermaid.render` on invalid syntax injects a "Syntax error"
 *  diagram straight into `document.body` (the orphaned error "bombs" that pile
 *  up across tab switches). `parse({ suppressErrors: true })` validates without
 *  throwing or touching the DOM, so we only ever `render` valid input. */
async function tryRender(
  m: Awaited<ReturnType<typeof getMermaid>>,
  candidate: string,
): Promise<string | null> {
  let valid = false;
  try {
    valid = (await m.parse(candidate, { suppressErrors: true })) !== false;
  } catch {
    valid = false;
  }
  if (!valid) return null;

  const id = `atlas-mermaid-${counter++}`;
  try {
    const { svg } = await m.render(id, candidate);
    return svg;
  } catch {
    return null;
  } finally {
    // Remove any temp measurement node mermaid may have left in the body.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/** Zoom bounds. Below 0.4 a diagram is unreadable; above 3 it is a texture. */
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

/**
 * Export scale. Mermaid emits vector SVG, so the only thing a PNG loses is
 * resolution — rasterising at 2× keeps a diagram legible when it is pasted into
 * a ticket and viewed at 100%.
 */
const EXPORT_SCALE = 2;

/** Render a Mermaid diagram from raw source. Tries the source as-is, then a
 *  sanitized variant; only falls back to showing the source if both fail.
 *
 *  `controls` adds zoom, copy-source and export-as-PNG. Off by default: the
 *  review panel renders diagrams inline at a fixed size, where a toolbar would
 *  be chrome on something nobody manipulates. A diagram an agent just drew in a
 *  chat is the opposite — it is the answer, and it gets read, kept and shared. */
export function MermaidBlock({ code, controls = false }: { code: string; controls?: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // The source the current `svg` was rendered from. A theme switch re-renders
  // the SAME source, and keeps the old diagram on screen until the new one is
  // ready — clearing it collapsed the block to "Rendering diagram…" and, in the
  // full-screen viewer, unmounted it and closed it under the user.
  const renderedCode = useRef(code);
  // Re-renders the diagram after a theme switch: mermaid bakes the palette into
  // the SVG it emits, so nothing about the existing markup can follow a change.
  const themeVersion = useThemeVersion();

  useEffect(() => {
    // Per run, not per mount: a run superseded by a newer `code` or theme must
    // not land its (now stale) result, even though the component is mounted.
    let cancelled = false;
    if (renderedCode.current !== code) {
      renderedCode.current = code;
      setSvg(null);
      setFailed(false);
    }

    // Defensive: remove any stray mermaid render/measurement nodes left directly
    // under <body> (e.g. from an earlier failed render). Successful diagrams are
    // injected inside this component, never appended to the body.
    document
      .querySelectorAll('body > [id^="atlas-mermaid-"], body > [id^="datlas-mermaid-"]')
      .forEach((n) => n.remove());

    (async () => {
      const m = await getMermaid();
      for (const candidate of [code, sanitize(code)]) {
        const out = await tryRender(m, candidate);
        if (cancelled) return;
        if (out !== null) {
          setSvg(out);
          setFailed(false);
          return;
        }
      }
      if (!cancelled) setFailed(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [code, themeVersion]);

  if (failed) {
    return (
      <details className="rounded-md border border-border-subtle bg-[var(--card)]/30 p-2 text-muted-foreground">
        <summary className="cursor-pointer text-xs">
          Diagram couldn't be rendered — show source
        </summary>
        <pre className="mt-1.5 text-2xs font-mono text-secondary-foreground overflow-auto whitespace-pre-wrap">
          {code}
        </pre>
      </details>
    );
  }
  if (!svg) {
    return <div className="p-3 text-xs text-muted-foreground">Rendering diagram…</div>;
  }
  if (!controls) {
    return (
      <div
        className="overflow-auto rounded-md border border-border bg-[var(--background)] p-2 [&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  return <DiagramViewer svg={svg} code={code} />;
}

/**
 * A rendered diagram you can actually work with.
 *
 * Zoom is a CSS transform on the SVG rather than a re-render: mermaid's output
 * is vector, so scaling it stays sharp at any factor and costs nothing, where
 * re-rendering at a new size would re-run layout on every click.
 */
function DiagramViewer({ svg, code }: { svg: string; code: string }) {
  const [zoom, setZoom] = useState(1);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const copy = useCallback(() => {
    // The *source*, not the SVG: mermaid is what someone pastes back into a doc
    // or another chat, and an SVG blob is not editable by hand.
    void copyText(code).then((ok) => setCopied(ok));
  }, [code]);

  const exportPng = useCallback(async () => {
    setSaving(true);
    try {
      const path = await save({
        defaultPath: "diagram.png",
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!path) return;
      const base64 = await svgToPngBase64(svg);
      await invoke("write_file_base64", { path, contents: base64 });
    } catch {
      /* a cancelled dialog and a failed raster both leave the diagram intact */
    } finally {
      setSaving(false);
    }
  }, [svg]);

  const step = (delta: number) =>
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((z + delta) * 100) / 100)));

  return (
    <div className="group/diagram relative overflow-hidden rounded-md border border-border bg-[var(--background)]">
      <div className="hide-scrollbar max-h-[420px] overflow-auto p-2">
        <div
          // `top left` so zooming grows into the scrollable area rather than
          // pushing the diagram off the left edge.
          style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}
          className="inline-block origin-top-left transition-transform duration-100 [&_svg]:h-auto [&_svg]:max-w-none"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      {/* Revealed on hover: at rest the diagram is the content, not a widget. */}
      <HintGroup>
        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--card)]/80 p-0.5 opacity-0 backdrop-blur-xl transition-opacity focus-within:opacity-100 group-hover/diagram:opacity-100">
          <IconButton label="Zoom out" onClick={() => step(-ZOOM_STEP)} disabled={zoom <= MIN_ZOOM}>
            <Minus size={12} />
          </IconButton>
          <HintItem label="Reset zoom">
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="cursor-pointer px-1 font-mono text-2xs tabular-nums text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            >
              {Math.round(zoom * 100)}%
            </button>
          </HintItem>
          <IconButton label="Zoom in" onClick={() => step(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM}>
            <Plus size={12} />
          </IconButton>
          <span aria-hidden className="mx-0.5 h-3 w-px bg-[var(--border)]" />
          <IconButton label="Open full screen" onClick={() => setFull(true)}>
            <Maximize2 size={11} />
          </IconButton>
          <IconButton label="Copy diagram source" onClick={copy}>
            {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
          </IconButton>
          <IconButton label="Export as PNG" onClick={() => void exportPng()} disabled={saving}>
            <Download size={11} />
          </IconButton>
        </div>
      </HintGroup>

      {full &&
        createPortal(
          <Fullscreen
            svg={svg}
            copied={copied}
            saving={saving}
            onCopy={copy}
            onExport={() => void exportPng()}
            onClose={() => setFull(false)}
          />,
          document.body,
        )}
    </div>
  );
}

/**
 * The diagram at full size.
 *
 * Portalled to `document.body` rather than rendered in place: the chat panel is
 * a 420px column inside a scroller with `overflow: hidden` on the way up, so an
 * in-tree overlay would be clipped to the very column the reader is trying to
 * escape.
 *
 * Its zoom is deliberately independent of the inline one — you open this to look
 * closer, and inheriting a 40% inline zoom would defeat the point.
 */
function Fullscreen({
  svg,
  copied,
  saving,
  onCopy,
  onExport,
  onClose,
}: {
  svg: string;
  copied: boolean;
  saving: boolean;
  onCopy: () => void;
  onExport: () => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const step = (delta: number) =>
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((z + delta) * 100) / 100)));

  return (
    <div
      role="dialog"
      aria-label="Diagram"
      className="animate-fade-in fixed inset-0 z-modal flex flex-col bg-[var(--background)]/95 backdrop-blur-2xl"
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--border)] px-3">
        <span className="text-sm text-[var(--secondary-foreground)]">Diagram</span>
        <div className="flex-1" />
        <HintGroup>
          <IconButton label="Zoom out" onClick={() => step(-ZOOM_STEP)} disabled={zoom <= MIN_ZOOM}>
            <Minus size={13} />
          </IconButton>
          <HintItem label="Reset zoom">
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="cursor-pointer px-1.5 font-mono text-xs tabular-nums text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            >
              {Math.round(zoom * 100)}%
            </button>
          </HintItem>
          <IconButton label="Zoom in" onClick={() => step(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM}>
            <Plus size={13} />
          </IconButton>
          <span aria-hidden className="mx-1 h-3.5 w-px bg-[var(--border)]" />
          <IconButton label="Copy diagram source" onClick={onCopy}>
            {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          </IconButton>
          <IconButton label="Export as PNG" onClick={onExport} disabled={saving}>
            <Download size={12} />
          </IconButton>
          <span aria-hidden className="mx-1 h-3.5 w-px bg-[var(--border)]" />
          <IconButton label="Close" onClick={onClose}>
            <X size={13} />
          </IconButton>
        </HintGroup>
      </header>

      <div className="hide-scrollbar min-h-0 flex-1 overflow-auto p-6">
        <div
          style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}
          className="inline-block transition-transform duration-100 [&_svg]:h-auto [&_svg]:max-w-none"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <HintItem label={label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "flex size-5 items-center justify-center rounded-full transition-colors",
          disabled
            ? "cursor-default text-disabled"
            : "cursor-pointer text-[var(--muted-foreground)] hover:bg-element-hover hover:text-[var(--foreground)]",
        )}
      >
        {children}
      </button>
    </HintItem>
  );
}

/**
 * Rasterise an SVG string to base64 PNG.
 *
 * The size comes from the SVG's own `viewBox` rather than the rendered element:
 * the element is under a zoom transform, and exporting whatever the reader
 * happened to be zoomed to would make the file's resolution an accident.
 *
 * The image is loaded from a data URL rather than a blob URL because a
 * `securityLevel: "strict"` mermaid SVG is self-contained — no external refs —
 * so the canvas never becomes tainted and `toDataURL` stays legal.
 */
async function svgToPngBase64(svg: string): Promise<string> {
  const viewBox = svg
    .match(/viewBox="([\d.\-\s]+)"/)?.[1]
    ?.trim()
    .split(/\s+/);
  const width = viewBox ? Number(viewBox[2]) : 1200;
  const height = viewBox ? Number(viewBox[3]) : 800;

  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not rasterise the diagram"));
    img.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * EXPORT_SCALE));
  canvas.height = Math.max(1, Math.round(height * EXPORT_SCALE));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  // Mermaid draws no background of its own, so a PNG without this is a diagram
  // on transparency — invisible in any light-background document.
  ctx.fillStyle = themeBase("background");
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL("image/png").split(",")[1];
}
