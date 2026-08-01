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
import {
  usePageMeta,
  useKnowledgeMetaStore,
} from "../stores/knowledge-meta-store";

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
    summaryParts.push(
      `#${meta.tags[0]}${meta.tags.length > 1 ? ` +${meta.tags.length - 1}` : ""}`,
    );
  const summary =
    summaryParts.length > 0
      ? summaryParts.join(" · ")
      : "Add status, owner, tags…";

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
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "8px 0",
          background: "transparent",
          border: 0,
          color: "var(--text-tertiary)",
          fontSize: 12,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <ChevronRight
          size={12}
          strokeWidth={1.7}
          style={{
            color: "var(--text-muted)",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 120ms",
            flex: "none",
          }}
        />
        <span
          className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: "var(--text-tertiary)" }}
        >
          Properties
        </span>
        {!open && (
          <span
            style={{
              fontSize: 11.5,
              color: "var(--text-muted)",
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
            <TagsEditor
              tags={meta.tags ?? []}
              onChange={(tags) => patch(entryId, { tags })}
            />
          </Row>
          <Row icon={Calendar} label="Created">
            <span style={{ color: "var(--text-secondary)" }}>
              {formatDate(meta.createdAt ?? null) ?? "—"}
            </span>
          </Row>
          <Row icon={Clock} label="Last edited">
            <span style={{ color: "var(--text-secondary)" }}>
              {formatDate(meta.updatedAt ?? fallbackUpdatedAt ?? null) ?? "—"}
            </span>
          </Row>
          <Row icon={LinkIcon} label="References">
            <span
              className="mono"
              style={{ fontSize: 11.5, color: "var(--text-secondary)" }}
            >
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
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          color: "var(--text-tertiary)",
          fontSize: 12,
        }}
      >
        <Icon size={12} className="text-text-muted" strokeWidth={1.5} />
        <span>{label}</span>
      </span>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12.5,
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
        className="pill"
        style={{
          height: 22,
          fontSize: 11,
          color: value ? "var(--text-primary)" : "var(--text-tertiary)",
          background: value ? "var(--bg-elevated-2)" : "transparent",
          borderColor: "var(--border-subtle)",
          cursor: "pointer",
        }}
      >
        <span
          className="dot"
          style={{
            width: 6,
            height: 6,
            background: value ? "var(--text-primary)" : "var(--text-muted)",
          }}
        />
        {value ?? "Add status"}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 30,
            background: "var(--bg-overlay)",
            border: "1px solid var(--border-strong)",
            borderRadius: 8,
            boxShadow: "var(--shadow-md)",
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
            className="bg-bg-input text-text-primary"
            style={{
              width: "100%",
              height: 26,
              padding: "0 8px",
              border: "1px solid var(--border-default)",
              borderRadius: 5,
              fontSize: 12,
              outline: "none",
            }}
          />
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}
          >
            {STATUS_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  onChange(p);
                  setOpen(false);
                }}
                className="pill pill-bare"
                style={{
                  height: 20,
                  fontSize: 10.5,
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
                style={{
                  fontSize: 10.5,
                  color: "var(--text-tertiary)",
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
        style={{
          background: "transparent",
          border: 0,
          outline: "none",
          color: "var(--text-primary)",
          fontSize: 12.5,
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
        value ? "text-text-secondary" : "text-text-tertiary italic",
      )}
      style={{
        background: "transparent",
        border: 0,
        padding: 0,
        fontSize: 12.5,
        cursor: "text",
        textAlign: "left",
      }}
    >
      {value || placeholder || "—"}
    </button>
  );
}

function TagsEditor({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
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
          className="pill pill-bare"
          style={{
            height: 20,
            fontSize: 10.5,
            borderColor: "var(--border-subtle)",
            paddingRight: 4,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {t}
          <button
            type="button"
            onClick={() => onChange(tags.filter((x) => x !== t))}
            style={{
              background: "transparent",
              border: 0,
              padding: 0,
              color: "var(--text-muted)",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
            }}
            title="Remove tag"
          >
            <X size={9} />
          </button>
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
            } else if (
              e.key === "Backspace" &&
              draft === "" &&
              tags.length > 0
            ) {
              onChange(tags.slice(0, -1));
            }
          }}
          placeholder="tag…"
          style={{
            background: "transparent",
            border: "1px dashed var(--border-subtle)",
            borderRadius: 9999,
            padding: "0 8px",
            height: 20,
            fontSize: 10.5,
            color: "var(--text-primary)",
            outline: "none",
            width: 80,
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          style={{
            color: "var(--text-muted)",
            fontSize: 12,
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
