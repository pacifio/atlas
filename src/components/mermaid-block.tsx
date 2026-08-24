import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { createPortal } from "react-dom";
import { Check, Copy, Download, Maximize2, Minus, Plus, X } from "lucide-react";

import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

// Mermaid is heavy (~500KB) — load it on first diagram render only. The theme is
// mapped to the *live* Atlas interface-theme tokens (read from CSS custom
// properties), so a diagram matches whichever palette is active (Atlas Black,
// Chyral, Mirage, …). We re-initialize whenever the palette changes so switching
// themes re-skins subsequently-rendered diagrams too.
let counter = 0;
let lastPaletteKey = "";

/** Read one CSS custom property off the document root, with a fallback. */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

async function getMermaid() {
  const mod = await import("mermaid");
  const mermaid = mod.default;

  // Pull the current interface-theme palette from CSS vars (set by
  // apply-atlas-theme.ts). Falls back to the AMOLED-black defaults.
  const bg = cssVar("--bg-base", "#0a0a0a");
  const raised = cssVar("--bg-raised", "#161616");
  const elevated = cssVar("--bg-elevated", "#0f0f0f");
  const textPrimary = cssVar("--text-primary", "#ffffff");
  const textSecondary = cssVar("--text-secondary", "#aaaaaa");
  const border = cssVar("--border-strong", "#3d3d3d");
  const line = cssVar("--text-tertiary", "#777777");

  const paletteKey = [bg, raised, elevated, textPrimary, textSecondary, border, line].join("|");
  if (paletteKey !== lastPaletteKey) {
    lastPaletteKey = paletteKey;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      themeVariables: {
        darkMode: true,
        background: bg,
        primaryColor: raised,
        primaryTextColor: textPrimary,
        primaryBorderColor: border,
        secondaryColor: elevated,
        tertiaryColor: bg,
        lineColor: line,
        textColor: textSecondary,
        fontSize: "12px",
        fontFamily: '-apple-system, "SF Pro Text", system-ui, sans-serif',
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
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    setFailed(false);
    setSvg(null);

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
        if (out !== null) {
          if (mountedRef.current) setSvg(out);
          return;
        }
      }
      if (mountedRef.current) setFailed(true);
    })();

    return () => {
      mountedRef.current = false;
    };
  }, [code]);

  if (failed) {
    return (
      <details className="rounded-md border border-border-subtle bg-[var(--bg-elevated)]/30 p-2 text-text-tertiary">
        <summary className="cursor-pointer text-[10.5px]">
          Diagram couldn't be rendered — show source
        </summary>
        <pre className="mt-1.5 text-[10px] font-mono text-text-secondary overflow-auto whitespace-pre-wrap">
          {code}
        </pre>
      </details>
    );
  }
  if (!svg) {
    return <div className="p-3 text-[11px] text-text-tertiary">Rendering diagram…</div>;
  }
  if (!controls) {
    return (
      <div
        className="overflow-auto rounded-md border border-border-default bg-[var(--bg-base)] p-2 [&_svg]:h-auto [&_svg]:max-w-full"
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
    <div className="group/diagram relative overflow-hidden rounded-md border border-border-default bg-[var(--bg-base)]">
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
      <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)]/80 p-0.5 opacity-0 backdrop-blur-xl transition-opacity focus-within:opacity-100 group-hover/diagram:opacity-100">
        <IconButton label="Zoom out" onClick={() => step(-ZOOM_STEP)} disabled={zoom <= MIN_ZOOM}>
          <Minus size={12} />
        </IconButton>
        <button
          type="button"
          onClick={() => setZoom(1)}
          title="Reset zoom"
          className="cursor-pointer px-1 font-mono text-[10px] tabular-nums text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
        >
          {Math.round(zoom * 100)}%
        </button>
        <IconButton label="Zoom in" onClick={() => step(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM}>
          <Plus size={12} />
        </IconButton>
        <span aria-hidden className="mx-0.5 h-3 w-px bg-[var(--border-default)]" />
        <IconButton label="Open full screen" onClick={() => setFull(true)}>
          <Maximize2 size={11} />
        </IconButton>
        <IconButton label="Copy diagram source" onClick={copy}>
          {copied ? <Check size={11} className="text-[var(--capture-live)]" /> : <Copy size={11} />}
        </IconButton>
        <IconButton label="Export as PNG" onClick={() => void exportPng()} disabled={saving}>
          <Download size={11} />
        </IconButton>
      </div>

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
      className="animate-fade-in fixed inset-0 z-[var(--z-max)] flex flex-col bg-[var(--bg-base)]/95 backdrop-blur-2xl"
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--border-default)] px-3">
        <span className="text-[12px] text-[var(--text-secondary)]">Diagram</span>
        <div className="flex-1" />
        <IconButton label="Zoom out" onClick={() => step(-ZOOM_STEP)} disabled={zoom <= MIN_ZOOM}>
          <Minus size={13} />
        </IconButton>
        <button
          type="button"
          onClick={() => setZoom(1)}
          title="Reset zoom"
          className="cursor-pointer px-1.5 font-mono text-[11px] tabular-nums text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
        >
          {Math.round(zoom * 100)}%
        </button>
        <IconButton label="Zoom in" onClick={() => step(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM}>
          <Plus size={13} />
        </IconButton>
        <span aria-hidden className="mx-1 h-3.5 w-px bg-[var(--border-default)]" />
        <IconButton label="Copy diagram source" onClick={onCopy}>
          {copied ? <Check size={12} className="text-[var(--capture-live)]" /> : <Copy size={12} />}
        </IconButton>
        <IconButton label="Export as PNG" onClick={onExport} disabled={saving}>
          <Download size={12} />
        </IconButton>
        <span aria-hidden className="mx-1 h-3.5 w-px bg-[var(--border-default)]" />
        <IconButton label="Close" onClick={onClose}>
          <X size={13} />
        </IconButton>
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
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex size-5 items-center justify-center rounded-full transition-colors",
        disabled
          ? "cursor-default text-[var(--text-ghost)]"
          : "cursor-pointer text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
      )}
    >
      {children}
    </button>
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
  ctx.fillStyle = cssVar("--bg-base", "#0a0a0a");
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL("image/png").split(",")[1];
}
