import { useEffect, useRef, useState } from "react";

// Mermaid is heavy (~500KB) — load it on first diagram render only. The theme is
// mapped to the *live* Atlas interface-theme tokens (read from CSS custom
// properties), so a diagram matches whichever palette is active (Atlas Black,
// Chyral, Mirage, …). We re-initialize whenever the palette changes so switching
// themes re-skins subsequently-rendered diagrams too.
let counter = 0;
let lastPaletteKey = "";

/** Read one CSS custom property off the document root, with a fallback. */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
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

  const paletteKey = [
    bg,
    raised,
    elevated,
    textPrimary,
    textSecondary,
    border,
    line,
  ].join("|");
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
    !/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|mindmap|gantt)/.test(
      s,
    )
  ) {
    s = `flowchart TD\n${s}`;
  }
  // `subgraph "Title"` → `subgraph s_n["Title"]` (a subgraph needs an id).
  let sg = 0;
  s = s.replace(
    /subgraph\s+"([^"]+)"/g,
    (_m, title) => `subgraph sg${sg++}["${title}"]`,
  );
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

/** Render a Mermaid diagram from raw source. Tries the source as-is, then a
 *  sanitized variant; only falls back to showing the source if both fail. */
export function MermaidBlock({ code }: { code: string }) {
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
      .querySelectorAll(
        'body > [id^="atlas-mermaid-"], body > [id^="datlas-mermaid-"]',
      )
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
    return (
      <div className="p-3 text-[11px] text-text-tertiary">
        Rendering diagram…
      </div>
    );
  }
  return (
    <div
      className="overflow-auto rounded-md border border-border-default bg-[var(--bg-base)] p-2 [&_svg]:max-w-full [&_svg]:h-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
