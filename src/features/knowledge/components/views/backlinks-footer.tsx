/** "Mentioned in · N places" card under a note: the first four backlinks. */
export function BacklinksFooter({
  backlinks,
  onSelectEntry,
}: {
  backlinks: ReadonlyArray<{ fromEntryId: string; fromTitle: string; snippet: string }>;
  onSelectEntry: (id: string) => void;
}) {
  return (
    <div className="mt-8 rounded-lg border border-border-subtle bg-card px-4 py-3.5">
      <div className="eyebrow mb-2.5">
        Mentioned in · {backlinks.length} {backlinks.length === 1 ? "place" : "places"}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {backlinks.slice(0, 4).map((b, idx) => (
          <button
            key={`${b.fromEntryId}-${idx}`}
            type="button"
            onClick={() => onSelectEntry(b.fromEntryId)}
            className="rounded-md border border-border-subtle bg-background px-2.5 py-2 text-left transition-colors duration-fast hover:bg-element-hover"
          >
            <div className="mb-1 truncate text-sm font-medium text-foreground">{b.fromTitle}</div>
            <div className="line-clamp-2 text-sm text-muted-foreground">{b.snippet}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
