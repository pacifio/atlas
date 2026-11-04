import { useEffect, useRef, useState } from "react";
import {
  Flame,
  User,
  Tag,
  Calendar,
  Clock,
  Link as LinkIcon,
  X,
  Plus,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { usePageMeta, useKnowledgeMetaStore } from "../stores/knowledge-meta-store";

interface PagePropertiesProps {
  entryId: string;
  /** Optional editor `updatedAt` (file mtime) used as fallback when the
   *  metadata file has no entry for this page yet. */
  fallbackUpdatedAt?: string | null;
  referencesLabel?: string;
}

const STATUS_PRESETS = ["Draft", "RFC", "Published", "Archived"] as const;

/**
 * Matches the `<Properties>` strip from `atlas-knowledge.jsx:543–580`.
 * Every row is editable inline; changes flow through Rust's
 * `knowledge_meta_patch` (debounced 300ms) and persist to
 * `.atlas/knowledge/_meta.json`.
 */
export function PageProperties({
  entryId,
  fallbackUpdatedAt,
  referencesLabel = "—",
}: PagePropertiesProps) {
  const meta = usePageMeta(entryId);
  const { patch } = useKnowledgeMetaStore.use.actions();
  // Collapsed by default so the page header stays compact. The user
  // expands it on demand, like the Notion "Details" accordion.
  const [open, setOpen] = useState(false);

  // Pre-compute a one-line summary for the collapsed header: a few of
  // the most informative bits so the user knows at-a-glance what's set.
  const summaryParts: string[] = [];
  if (meta.status) summaryParts.push(meta.status);
  if (meta.owner) summaryParts.push(`@${meta.owner}`);
  if (meta.tags && meta.tags.length > 0)
    summaryParts.push(`#${meta.tags[0]}${meta.tags.length > 1 ? ` +${meta.tags.length - 1}` : ""}`);
  const summary = summaryParts.length > 0 ? summaryParts.join(" · ") : "Add status, owner, tags…";

  return (
    <div
      style={{
        marginTop: 14,
        borderTop: "1px solid var(--border-subtle)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "8px 0",
          background: "transparent",
          border: 0,
          color: "var(--muted-foreground)",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <ChevronRight
          size={12}
          strokeWidth={1.7}
          style={{
            color: "var(--muted-foreground)",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 120ms",
            flex: "none",
          }}
        />
        <span
          className="text-2xs font-semibold uppercase tracking-wider"
          style={{ color: "var(--muted-foreground)" }}
        >
          Properties
        </span>
        {!open && (
          <span
            className="text-sm"
            style={{
              color: "var(--muted-foreground)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            {summary}
          </span>
        )}
      </button>
      {open && (
        <div style={{ padding: "4px 0 10px" }}>
          <Row icon={Flame} label="Status">
            <StatusEditor
              value={meta.status ?? null}
              onChange={(v) => patch(entryId, { status: v })}
            />
          </Row>
          <Row icon={User} label="Owner">
            <TextEditor
              value={meta.owner ?? ""}
              placeholder="—"
              onChange={(v) => patch(entryId, { owner: v.trim() || null })}
            />
          </Row>
          <Row icon={Tag} label="Tags">
            <TagsEditor tags={meta.tags ?? []} onChange={(tags) => patch(entryId, { tags })} />
          </Row>
          <Row icon={Calendar} label="Created">
            <span style={{ color: "var(--secondary-foreground)" }}>
              {formatDate(meta.createdAt ?? null) ?? "—"}
            </span>
          </Row>
          <Row icon={Clock} label="Last edited">
            <span style={{ color: "var(--secondary-foreground)" }}>
              {formatDate(meta.updatedAt ?? fallbackUpdatedAt ?? null) ?? "—"}
            </span>
          </Row>
          <Row icon={LinkIcon} label="References">
            <span className="mono text-sm" style={{ color: "var(--secondary-foreground)" }}>
              {referencesLabel}
            </span>
          </Row>
        </div>
      )}
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Flame;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "132px 1fr",
        alignItems: "center",
        padding: "3px 0",
      }}
    >
      <span
        className="text-sm"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          color: "var(--muted-foreground)",
        }}
      >
        <Icon size={12} className="text-muted-foreground" strokeWidth={1.5} />
        <span>{label}</span>
      </span>
      <span
        className="text-base"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {children}
      </span>
    </div>
  );
}

function StatusEditor({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="pill text-xs"
        style={{
          height: 22,
          color: value ? "var(--foreground)" : "var(--muted-foreground)",
          background: value ? "var(--card)" : "transparent",
          borderColor: "var(--border-subtle)",
          cursor: "pointer",
        }}
      >
        <span
          className="dot"
          style={{
            width: 6,
            height: 6,
            background: value ? "var(--foreground)" : "var(--muted-foreground)",
          }}
        />
        {value ?? "Add status"}
      </button>
      {open && (
        <div
          className="z-popover bg-popover border border-border-strong rounded-lg shadow-md"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            padding: 6,
            width: 200,
          }}
        >
          <input
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onChange(draft.trim() || null);
                setOpen(false);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="Status…"
            className="bg-panel-input text-foreground text-sm"
            style={{
              width: "100%",
              height: 26,
              padding: "0 8px",
              border: "1px solid var(--border)",
              borderRadius: 5,
              outline: "none",
            }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
            {STATUS_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  onChange(p);
                  setOpen(false);
                }}
                className="pill pill-bare text-xs"
                style={{
                  height: 20,
                  cursor: "pointer",
                  borderColor: "var(--border-subtle)",
                }}
              >
                {p}
              </button>
            ))}
            {value && (
              <button
                type="button"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
                className="text-xs"
                style={{
                  color: "var(--muted-foreground)",
                  cursor: "pointer",
                  padding: "0 4px",
                }}
              >
                clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TextEditor({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => setDraft(value), [value]);
  if (editing) {
    return (
      <input
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          onChange(draft);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onChange(draft);
            setEditing(false);
          } else if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        className="text-base"
        style={{
          background: "transparent",
          border: 0,
          outline: "none",
          color: "var(--foreground)",
          padding: 0,
          minWidth: 100,
        }}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={cn(
        "text-base",
        value ? "text-secondary-foreground" : "text-muted-foreground italic",
      )}
      style={{
        background: "transparent",
        border: 0,
        padding: 0,
        cursor: "text",
        textAlign: "left",
      }}
    >
      {value || placeholder || "—"}
    </button>
  );
}

function TagsEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const commit = () => {
    const v = draft.trim();
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setDraft("");
    setAdding(false);
  };

  return (
    <>
      {tags.map((t) => (
        <span
          key={t}
          className="pill pill-bare text-xs"
          style={{
            height: 20,
            borderColor: "var(--border-subtle)",
            paddingRight: 4,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {t}
          <Hint label="Remove tag">
            <button
              type="button"
              onClick={() => onChange(tags.filter((x) => x !== t))}
              style={{
                background: "transparent",
                border: 0,
                padding: 0,
                color: "var(--muted-foreground)",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              <X size={9} />
            </button>
          </Hint>
        </span>
      ))}
      {adding ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") {
              setDraft("");
              setAdding(false);
            } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
              onChange(tags.slice(0, -1));
            }
          }}
          placeholder="tag…"
          className="text-xs"
          style={{
            background: "transparent",
            border: "1px dashed var(--border-subtle)",
            borderRadius: 9999,
            padding: "0 8px",
            height: 20,
            color: "var(--foreground)",
            outline: "none",
            width: 80,
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="text-sm"
          style={{
            color: "var(--muted-foreground)",
            padding: "0 6px",
            background: "transparent",
            border: 0,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Plus size={10} /> add
        </button>
      )}
    </>
  );
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: sameYear ? undefined : "numeric",
    });
  } catch {
    return null;
  }
}
