import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useBacklinks } from "../stores/knowledge-links-store";

export interface OutlineHeading {
  id: string;
  label: string;
  level: 2 | 3;
}

interface KnowledgeInspectorProps {
  outline: OutlineHeading[];
  activeHeadingId?: string | null;
  onJumpToHeading: (id: string) => void;
  pageStats: Array<[string, string | number]>;
  /** Optional current entry id so the Backlinks tab can query for it. */
  entryId?: string | null;
  onJumpToEntry?: (entryId: string) => void;
  /** Width in px (parent owns the resizable state). */
  width?: number;
}

/**
 * Matches `atlas-knowledge.jsx::Inspector` (lines 1081–1253). Two tabs
 * — Outline (live TOC; Phase E populates it from the editor) and
 * Backlinks (Phase H wires it). For Phase B we render both tabs with
 * the design layout; Backlinks tab is an explicit empty state until
 * the link engine ships.
 */
export function KnowledgeInspector({
  outline,
  activeHeadingId,
  onJumpToHeading,
  pageStats,
  entryId,
  onJumpToEntry,
  width = 280,
}: KnowledgeInspectorProps) {
  const [tab, setTab] = useState<"outline" | "links">("outline");
  const backlinks = useBacklinks(entryId ?? null);

  const headingDepthOf = useMemo(
    () => (lvl: number) => (lvl === 3 ? 16 : 0),
    [],
  );

  return (
    <aside
      className="flex flex-col min-h-0 shrink-0 border-l border-border-subtle"
      style={{ width, background: "var(--bg-base)" }}
    >
      {/* Pill-style tab strip — active tab gets a full rounded white
          background, inactive tabs are plain text. Matches the
          reference screenshot from the user's feedback. */}
      <div
        className="flex items-center shrink-0 border-b border-border-subtle"
        style={{ height: 36, gap: 4, padding: "0 10px" }}
      >
        {(["outline", "links"] as const).map((id) => {
          const label = id === "outline" ? "Outline" : "Backlinks";
          const active = tab === id;
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "transition-colors",
                active
                  ? "bg-text-primary text-text-inverse font-semibold"
                  : "text-text-tertiary hover:text-text-secondary",
              )}
              style={{
                fontSize: 12,
                padding: "0 12px",
                borderRadius: 9999,
                height: 24,
                lineHeight: 1,
                background: active ? "var(--text-primary)" : "transparent",
                color: active ? "var(--text-inverse)" : undefined,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div
        className="flex-1 overflow-y-auto min-h-0"
        style={{ padding: "12px 14px" }}
      >
        {tab === "outline" && (
          <>
            <div
              className="text-text-tertiary uppercase mb-2"
              style={{ fontSize: 10.5, letterSpacing: "0.08em" }}
            >
              On this page
            </div>
            {outline.length === 0 ? (
              <div className="text-text-muted italic" style={{ fontSize: 11 }}>
                Add H2 or H3 headings to build an outline
              </div>
            ) : (
              outline.map((h, idx) => {
                const isActive = h.id === activeHeadingId;
                return (
                  <button
                    // Compose with index so headings with identical text
                    // (and thus identical slug ids) get unique React keys.
                    key={`${h.id}-${idx}`}
                    onClick={() => onJumpToHeading(h.id)}
                    className={cn(
                      "block w-full text-left transition-colors",
                      isActive
                        ? "text-text-primary"
                        : "text-text-tertiary hover:text-text-secondary",
                    )}
                    style={{
                      fontSize: 12.5,
                      lineHeight: 1.5,
                      padding: `3px 0 3px ${isActive ? 10 : headingDepthOf(h.level)}px`,
                      borderLeft: isActive
                        ? "1.5px solid var(--text-primary)"
                        : "1.5px solid transparent",
                      marginLeft: isActive ? -10 : 0,
                    }}
                  >
                    {h.label}
                  </button>
                );
              })
            )}

            <div
              className="mt-6 pt-3.5 border-t border-border-subtle"
              style={{ marginTop: 22 }}
            >
              <div className="eyebrow mb-2.5" style={{ fontSize: 9.5 }}>
                Page stats
              </div>
              {pageStats.map(([k, v]) => (
                <div
                  key={k}
                  className="flex justify-between border-b border-border-subtle text-text-tertiary"
                  style={{ padding: "5px 0", fontSize: 12 }}
                >
                  <span>{k}</span>
                  <span className="mono tnum text-text-primary">{v}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "links" && (
          <>
            <div className="eyebrow mb-2.5" style={{ fontSize: 9.5 }}>
              Pages linking here · {backlinks.length}
            </div>
            {backlinks.length === 0 ? (
              <div className="text-text-muted italic" style={{ fontSize: 11 }}>
                No backlinks yet. Reference this page from another note with
                <span className="mono"> [[note-id]] </span>
                and it'll show up here.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {backlinks.map((b, idx) => (
                  <button
                    key={`${b.fromEntryId}-${idx}`}
                    type="button"
                    onClick={() => onJumpToEntry?.(b.fromEntryId)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "auto 1fr",
                      gap: 10,
                      width: "100%",
                      padding: "8px 6px",
                      borderRadius: 6,
                      background: "transparent",
                      border: 0,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span
                      style={{
                        fontSize: 14,
                        lineHeight: 1,
                        color: "var(--text-tertiary)",
                      }}
                    >
                      ›
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12.5,
                          color: "var(--text-primary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {b.fromTitle}
                      </div>
                      <div
                        style={{
                          fontSize: 10.5,
                          color: "var(--text-tertiary)",
                          lineHeight: 1.4,
                          // Two-line clamp on the snippet so cards stay compact.
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical" as const,
                          overflow: "hidden",
                        }}
                      >
                        {b.snippet}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
