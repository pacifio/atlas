/** "Mentioned in · N places" card under a note: the first four backlinks. */
export function BacklinksFooter({
  backlinks,
  onSelectEntry,
}: {
  backlinks: ReadonlyArray<{ fromEntryId: string; fromTitle: string; snippet: string }>;
  onSelectEntry: (id: string) => void;
}) {
  return (
    <div
      style={{
        marginTop: 32,
        padding: "14px 16px",
        background: "var(--card)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <span className="eyebrow" style={{ flex: 1 }}>
          Mentioned in · {backlinks.length} {backlinks.length === 1 ? "place" : "places"}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        {backlinks.slice(0, 4).map((b, idx) => (
          <button
            key={`${b.fromEntryId}-${idx}`}
            type="button"
            onClick={() => onSelectEntry(b.fromEntryId)}
            style={{
              padding: "8px 10px",
              borderRadius: 7,
              background: "var(--background)",
              border: "1px solid var(--border-subtle)",
              textAlign: "left",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--element-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--background)";
            }}
          >
            <div
              className="text-sm"
              style={{
                color: "var(--foreground)",
                fontWeight: 500,
                marginBottom: 4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {b.fromTitle}
            </div>
            <div
              className="text-sm"
              style={{
                color: "var(--muted-foreground)",
                lineHeight: 1.5,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical" as const,
                overflow: "hidden",
              }}
            >
              {b.snippet}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
