import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Calendar,
  ChevronRight,
  Clock,
  Flame,
  Link as LinkIcon,
  Plus,
  Tag,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Hint,
  Icon,
  Input,
  Pill,
  Popover,
  PopoverContent,
  PopoverTrigger,
  StatusDot,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import {
  STATUS_PRESETS,
  formatPageDate,
  propertiesSummary,
  type PagePropertiesMeta,
  type PagePropertiesPatch,
} from "../../lib/page-properties-model";

/**
 * The page-properties strip under a note's title: collapsed to a one-line
 * summary by default, and when open a row each for Status, Owner, Tags,
 * Created, Last edited and References. Every edit goes out through
 * `onPatch`; the container persists it.
 */
export function PagePropertiesView({
  meta,
  referencesLabel,
  onPatch,
  defaultOpen,
  now,
}: {
  meta: PagePropertiesMeta;
  referencesLabel: string;
  onPatch: (patch: PagePropertiesPatch) => void;
  /** Start expanded (stories and tests). */
  defaultOpen?: boolean;
  /** The date "this year" is measured against; defaults to now. */
  now?: Date;
}) {
  // Collapsed by default so the page header stays compact. Not keyed on the
  // page, so the open state survives a page switch.
  const [open, setOpen] = useState(defaultOpen ?? false);
  const today = now ?? new Date();

  return (
    <div data-view="page-properties" className="mt-3.5 border-y border-border-subtle">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-2 text-left text-sm text-muted-foreground"
      >
        <Icon
          icon={ChevronRight}
          size="sm"
          className={cn("shrink-0 transition-transform duration-fast", open && "rotate-90")}
        />
        <span className="eyebrow">Properties</span>
        {!open && <span className="min-w-0 flex-1 truncate">{propertiesSummary(meta)}</span>}
      </button>
      {open && (
        <dl className="pt-1 pb-2.5">
          <Row icon={Flame} label="Status">
            <StatusEditor value={meta.status} onChange={(status) => onPatch({ status })} />
          </Row>
          <Row icon={User} label="Owner">
            <TextEditor
              value={meta.owner ?? ""}
              placeholder="—"
              label="Owner"
              onChange={(v) => {
                // An unchanged owner is no edit: patching would still stamp
                // "Last edited".
                const owner = v.trim() || null;
                if ((owner ?? "") !== (meta.owner?.trim() ?? "")) onPatch({ owner });
              }}
            />
          </Row>
          <Row icon={Tag} label="Tags">
            <TagsEditor tags={meta.tags} onChange={(tags) => onPatch({ tags })} />
          </Row>
          <Row icon={Calendar} label="Created">
            <span className="text-secondary-foreground">
              {formatPageDate(meta.createdAt, today) ?? "—"}
            </span>
          </Row>
          <Row icon={Clock} label="Last edited">
            <span className="text-secondary-foreground">
              {formatPageDate(meta.updatedAt, today) ?? "—"}
            </span>
          </Row>
          <Row icon={LinkIcon} label="References">
            <span className="mono text-sm text-secondary-foreground">{referencesLabel}</span>
          </Row>
        </dl>
      )}
    </div>
  );
}

function Row({ icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[132px_minmax(0,1fr)] items-center py-[3px]">
      <dt className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon icon={icon} size="sm" />
        {label}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5 text-base">{children}</dd>
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
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(value ?? ""), [value]);

  const pick = (v: string | null) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        // A click elsewhere closes it, dropping the draft; focus leaving
        // without a click (Tab out) does not.
        if (!next && details.reason === "focus-out") return;
        if (!next) setDraft(value ?? "");
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={<Pill render={<button type="button" />} className="cursor-pointer" />}
      >
        <StatusDot tone="neutral" />
        {value ?? <span className="text-muted-foreground">Add status</span>}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        initialFocus={inputRef}
        className="w-[200px] p-1.5"
      >
        <Input
          ref={inputRef}
          size="sm"
          value={draft}
          aria-label="Status"
          placeholder="Status…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") pick(draft.trim() || null);
          }}
        />
        <div className="mt-1.5 flex flex-wrap gap-1">
          {STATUS_PRESETS.map((p) => (
            <Pill
              key={p}
              render={<button type="button" />}
              className="cursor-pointer"
              onClick={() => pick(p)}
            >
              {p}
            </Pill>
          ))}
          {value && (
            <button
              type="button"
              onClick={() => pick(null)}
              className="px-1 text-xs text-muted-foreground hover:text-foreground"
            >
              clear
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TextEditor({
  value,
  placeholder,
  label,
  onChange,
}: {
  value: string;
  placeholder?: string;
  label: string;
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
        aria-label={label}
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
        className="min-w-[100px] border-0 bg-transparent p-0 text-base text-foreground outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={cn(
        "cursor-text p-0 text-left text-base",
        value ? "text-secondary-foreground" : "text-muted-foreground italic",
      )}
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
        <Pill key={t}>
          {t}
          <Hint label="Remove tag">
            <button
              type="button"
              aria-label={`Remove tag ${t}`}
              onClick={() => onChange(tags.filter((x) => x !== t))}
              className="inline-flex items-center text-muted-foreground hover:text-foreground"
            >
              <Icon icon={X} size="xs" />
            </button>
          </Hint>
        </Pill>
      ))}
      {adding ? (
        <input
          ref={inputRef}
          value={draft}
          aria-label="New tag"
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
          className="h-control-xs w-[80px] rounded-full border border-dashed border-border-subtle bg-transparent px-2 text-xs text-foreground outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 px-1.5 text-sm text-muted-foreground hover:text-secondary-foreground"
        >
          <Icon icon={Plus} size="xs" /> add
        </button>
      )}
    </>
  );
}
