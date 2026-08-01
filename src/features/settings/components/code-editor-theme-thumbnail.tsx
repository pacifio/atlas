import type { EditorColorTheme } from "@/features/editor/themes/types";

/**
 * A deterministic mini code preview for a theme — a few fake code lines rendered
 * with the theme's syntax colors on Atlas's fixed AMOLED-black background (every
 * theme shares one background; only syntax varies). Mirrors the visual-preview
 * approach of the Layouts picker's LayoutThumbnail.
 */
export function CodeEditorThemeThumbnail({
  theme,
}: {
  theme: EditorColorTheme;
}) {
  const c = theme.colors;
  return (
    <div
      className="h-[150px] w-full shrink-0 overflow-hidden border-b border-[var(--border-subtle)]"
      style={{ backgroundColor: "var(--bg-base)" }}
    >
      <div
        className="h-full w-full px-2.5 py-2 font-mono leading-[1.6]"
        style={{ fontSize: "9px", color: c.fg }}
      >
        <div style={{ color: c.comment, fontStyle: "italic" }}>
          // {theme.name} syntax preview
        </div>
        <div>
          <span style={{ color: c.keyword, fontStyle: "italic" }}>import</span>{" "}
          <span style={{ color: c.operator }}>{"{"}</span>{" "}
          <span style={{ color: c.variable }}>render</span>
          <span style={{ color: c.operator }}>,</span>{" "}
          <span style={{ color: c.variable }}>parse</span>{" "}
          <span style={{ color: c.operator }}>{"}"}</span>{" "}
          <span style={{ color: c.keyword, fontStyle: "italic" }}>from</span>{" "}
          <span style={{ color: c.string }}>"./core"</span>
          <span style={{ color: c.operator }}>;</span>
        </div>
        <div>
          <span style={{ color: c.keyword, fontStyle: "italic" }}>export</span>{" "}
          <span style={{ color: c.keyword, fontStyle: "italic" }}>
            function
          </span>{" "}
          <span style={{ color: c.func }}>render</span>
          <span style={{ color: c.operator }}>(</span>
          <span style={{ color: c.variable }}>node</span>
          <span style={{ color: c.operator }}>) {"{"}</span>
        </div>
        <div style={{ paddingLeft: "10px" }}>
          <span style={{ color: c.keyword, fontStyle: "italic" }}>const</span>{" "}
          <span style={{ color: c.definition }}>count</span>{" "}
          <span style={{ color: c.operator }}>=</span>{" "}
          <span style={{ color: c.number }}>42</span>
          <span style={{ color: c.operator }}>;</span>
        </div>
        <div style={{ paddingLeft: "10px" }}>
          <span style={{ color: c.keyword, fontStyle: "italic" }}>if</span>{" "}
          <span style={{ color: c.operator }}>(</span>
          <span style={{ color: c.operator }}>!</span>
          <span style={{ color: c.variable }}>node</span>
          <span style={{ color: c.operator }}>)</span>{" "}
          <span style={{ color: c.keyword, fontStyle: "italic" }}>return</span>{" "}
          <span style={{ color: c.keyword }}>null</span>
          <span style={{ color: c.operator }}>;</span>
        </div>
        <div style={{ paddingLeft: "10px" }}>
          <span style={{ color: c.keyword, fontStyle: "italic" }}>const</span>{" "}
          <span style={{ color: c.definition }}>label</span>{" "}
          <span style={{ color: c.operator }}>=</span>{" "}
          <span style={{ color: c.string }}>`item-</span>
          <span style={{ color: c.operator }}>${"{"}</span>
          <span style={{ color: c.variable }}>count</span>
          <span style={{ color: c.operator }}>{"}"}</span>
          <span style={{ color: c.string }}>`</span>
          <span style={{ color: c.operator }}>;</span>
        </div>
        <div style={{ paddingLeft: "10px" }}>
          <span style={{ color: c.keyword, fontStyle: "italic" }}>return</span>{" "}
          <span style={{ color: c.string }}>"{theme.name}"</span>
          <span style={{ color: c.operator }}>;</span>
        </div>
        <div style={{ color: c.operator }}>{"}"}</div>
      </div>
    </div>
  );
}
