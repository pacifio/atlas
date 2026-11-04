import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Copy, Download, Maximize2, Minus, Plus, X } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  HintGroup,
  HintItem,
  Icon,
  IconButton,
} from "@tryatlas/design";

import { getActiveTheme } from "@/features/theme/apply-theme";
import { themeBase, themeColor, useThemeVersion } from "@/features/theme/theme-values";

// Mermaid is heavy (~500KB) — load it on first diagram render only.
//
// A diagram is an SVG mermaid BUILDS from a `themeVariables` object, not
// something it styles afterwards, so the colours have to be resolved values
// (decision 14) and re-initializing is not enough on its own: an already-drawn
// diagram keeps the palette it was drawn with for ever. `MermaidBlockView`
// watches `useThemeVersion()` and re-renders on a theme switch, which is what
// makes a diagram that is already on screen follow the theme rather than the
// next one somebody types.
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

export interface MermaidBlockViewProps {
  code: string;
  /**
   * Adds zoom, full screen, and — when their callbacks are given — copy-source
   * and export-as-PNG. Off by default: the review panel renders diagrams inline
   * at a fixed size, where a toolbar would be chrome on something nobody
   * manipulates. A diagram an agent just drew in a chat is the opposite — it is
   * the answer, and it gets read, kept and shared.
   */
  controls?: boolean;
  /** Puts the source on the clipboard; resolve `true` once it is there. */
  onCopySource?: (code: string) => Promise<boolean>;
  /** Saves the rendered diagram as a PNG (asking where, and writing it). */
  onExportPng?: (svg: string) => Promise<void>;
}

/** Render a Mermaid diagram from raw source. Tries the source as-is, then a
 *  sanitized variant; only falls back to showing the source if both fail. */
export function MermaidBlockView({
  code,
  controls = false,
  onCopySource,
  onExportPng,
}: MermaidBlockViewProps) {
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
      <div
        data-mermaid=""
        className="rounded-md border border-border-subtle bg-card/30 p-2 text-muted-foreground"
      >
        {/* Closed at first, and a keyboard toggle, as the `<details>` it replaced. */}
        <Collapsible>
          <CollapsibleTrigger className="group/source flex cursor-pointer items-center text-left">
            <span className="mr-1 flex shrink-0">
              <Icon
                icon={ChevronRight}
                size="xs"
                className="transition-transform duration-fast group-data-[panel-open]/source:rotate-90"
              />
            </span>
            <span className="text-xs">Diagram couldn't be rendered — show source</span>
          </CollapsibleTrigger>
          <CollapsibleContent hiddenUntilFound>
            <pre className="mt-1.5 overflow-auto whitespace-pre-wrap font-mono text-2xs text-secondary-foreground">
              {code}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      </div>
    );
  }
  if (!svg) {
    return (
      <div data-mermaid="" className="p-3 text-xs text-muted-foreground">
        Rendering diagram…
      </div>
    );
  }
  if (!controls) {
    return (
      <div
        data-mermaid=""
        className="overflow-auto rounded-md border border-border bg-background p-2 [&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  return (
    <DiagramViewer svg={svg} code={code} onCopySource={onCopySource} onExportPng={onExportPng} />
  );
}

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
}

/** The copy and export actions, shared by the inline toolbar and full screen. */
interface Actions {
  copied: boolean;
  saving: boolean;
  onCopy?: () => void;
  onExport?: () => void;
}

/**
 * A rendered diagram you can actually work with.
 *
 * Zoom is a CSS transform on the SVG rather than a re-render: mermaid's output
 * is vector, so scaling it stays sharp at any factor and costs nothing, where
 * re-rendering at a new size would re-run layout on every click.
 */
function DiagramViewer({
  svg,
  code,
  onCopySource,
  onExportPng,
}: {
  svg: string;
  code: string;
  onCopySource?: (code: string) => Promise<boolean>;
  onExportPng?: (svg: string) => Promise<void>;
}) {
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
    void onCopySource?.(code).then((ok) => setCopied(ok));
  }, [code, onCopySource]);

  const exportPng = useCallback(async () => {
    if (!onExportPng) return;
    setSaving(true);
    try {
      await onExportPng(svg);
    } finally {
      setSaving(false);
    }
  }, [svg, onExportPng]);

  const actions: Actions = {
    copied,
    saving,
    onCopy: onCopySource ? copy : undefined,
    onExport: onExportPng ? () => void exportPng() : undefined,
  };

  return (
    <div
      data-mermaid=""
      className="group/diagram relative overflow-hidden rounded-md border border-border bg-background"
    >
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
        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full border border-border bg-card/80 p-0.5 opacity-0 backdrop-blur-xl transition-opacity focus-within:opacity-100 group-hover/diagram:opacity-100">
          <ZoomControls zoom={zoom} onZoom={setZoom} size="xs" />
          <Divider />
          <ToolButton label="Open full screen" icon={Maximize2} onClick={() => setFull(true)} />
          <CopyExport {...actions} size="xs" />
        </div>
      </HintGroup>

      {full &&
        createPortal(
          <Fullscreen svg={svg} {...actions} onClose={() => setFull(false)} />,
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
function Fullscreen({ svg, onClose, ...actions }: Actions & { svg: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  // Focus moves into the overlay, onto Close, and goes back to whatever opened
  // it when it closes; left alone it stayed behind the overlay.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-label="Diagram"
      className="animate-fade-in fixed inset-0 z-modal flex flex-col bg-background/95 backdrop-blur-2xl"
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
        <span className="text-sm text-secondary-foreground">Diagram</span>
        <div className="flex-1" />
        <HintGroup>
          <ZoomControls zoom={zoom} onZoom={setZoom} size="sm" />
          {(actions.onCopy || actions.onExport) && <Divider />}
          <CopyExport {...actions} size="sm" />
          <Divider />
          <ToolButton label="Close" icon={X} onClick={onClose} size="sm" buttonRef={closeRef} />
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

function ZoomControls({
  zoom,
  onZoom,
  size,
}: {
  zoom: number;
  onZoom: (zoom: number) => void;
  size: "xs" | "sm";
}) {
  return (
    <>
      <ToolButton
        label="Zoom out"
        icon={Minus}
        size={size}
        onClick={() => onZoom(clampZoom(zoom - ZOOM_STEP))}
        disabled={zoom <= MIN_ZOOM}
      />
      <HintItem label="Reset zoom">
        <button
          type="button"
          onClick={() => onZoom(1)}
          className="cursor-pointer px-1 font-mono text-2xs tabular-nums text-muted-foreground transition-colors hover:text-foreground"
        >
          {Math.round(zoom * 100)}%
        </button>
      </HintItem>
      <ToolButton
        label="Zoom in"
        icon={Plus}
        size={size}
        onClick={() => onZoom(clampZoom(zoom + ZOOM_STEP))}
        disabled={zoom >= MAX_ZOOM}
      />
    </>
  );
}

function CopyExport({ copied, saving, onCopy, onExport, size }: Actions & { size: "xs" | "sm" }) {
  return (
    <>
      {onCopy && (
        <HintItem label="Copy diagram source">
          <IconButton
            variant="ghost"
            shape="round"
            size={size}
            label="Copy diagram source"
            icon={copied ? <Icon icon={Check} size={size} className="text-success" /> : Copy}
            onClick={onCopy}
          />
        </HintItem>
      )}
      {onExport && (
        <ToolButton
          label="Export as PNG"
          icon={Download}
          size={size}
          onClick={onExport}
          disabled={saving}
        />
      )}
    </>
  );
}

function ToolButton({
  label,
  icon,
  onClick,
  disabled,
  size = "xs",
  buttonRef,
}: {
  label: string;
  icon: typeof Plus;
  onClick: () => void;
  disabled?: boolean;
  size?: "xs" | "sm";
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <HintItem label={label}>
      <IconButton
        ref={buttonRef}
        variant="ghost"
        shape="round"
        size={size}
        label={label}
        icon={icon}
        onClick={onClick}
        disabled={disabled}
      />
    </HintItem>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-3 w-px bg-border" />;
}
