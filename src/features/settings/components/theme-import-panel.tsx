import { useCallback, useMemo, useState } from "react";
import { CopyGlyph } from "@/ui/animated-icon";
import { AlertTriangle, ArrowLeft, Check, FileJson, Link2, Upload } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { Input } from "@/ui/input";
import { ScrollArea } from "@/ui/scroll-area";
import {
  FIDELITY_LABEL,
  commitThemeImport,
  exportThemeShadcn,
  previewThemeImport,
  themeIdSlug,
  type ShadcnExport,
  type ThemeImportCandidate,
  type ThemeOrigin,
  type ThemeImportPreview,
  type ThemeImportReport,
} from "@/features/theme/lib/theme-import-api";
import type { ThemeSummary } from "@/features/theme/lib/theme-api";

/**
 * Import a foreign theme, and export an Atlas one.
 *
 * The panel is built around one claim: **the report is the product**. Anyone
 * can paste a VS Code theme and get colours out; what stops the result being
 * read as a faithful port is showing, before anything is written, that 70
 * workbench keys had nowhere to go and half the chrome was derived. So the
 * preview is a required step rather than a convenience, and the three counts
 * (mapped / derived / ignored) sit above the fold with the fidelity verdict.
 *
 * Failure is treated as ordinary: bad JSON, an unknown schema and a theme with
 * no usable colours all come back from Rust as a sentence, and that sentence is
 * what the panel shows. There is no "import failed" state beyond it.
 */

type Source = "paste" | "url" | "file";

interface Props {
  themes: ThemeSummary[];
  onClose: () => void;
  /** Called with the new theme's id — the one Rust saved it under — once it
   *  is on disk. */
  onImported: (id: string) => void;
}

const SOURCES: { id: Source; label: string; icon: typeof Upload }[] = [
  { id: "paste", label: "Paste", icon: FileJson },
  { id: "url", label: "URL", icon: Link2 },
  { id: "file", label: "File", icon: Upload },
];

const PLACEHOLDER = [
  "Paste a shadcn registry item, a globals.css, a Zed theme family,",
  "or a VS Code color theme. The format is detected.",
].join("\n");

export function ThemeImportPanel({ themes, onClose, onImported }: Props) {
  const [mode, setMode] = useState<"import" | "export">("import");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-tab-strip shrink-0 items-center gap-1 border-b border-border bg-background px-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <Icon icon={ArrowLeft} size="sm" />
          Themes
        </Button>
        <div className="ml-auto flex items-center gap-1">
          {(["import", "export"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={mode === value ? "secondary" : "ghost"}
              onClick={() => setMode(value)}
              className="capitalize"
            >
              {value}
            </Button>
          ))}
        </div>
      </div>
      {mode === "import" ? (
        <ImportView themes={themes} onImported={onImported} />
      ) : (
        <ExportView themes={themes} />
      )}
    </div>
  );
}

function ImportView({
  themes,
  onImported,
}: {
  themes: ThemeSummary[];
  onImported: (id: string) => void;
}) {
  const [source, setSource] = useState<Source>("paste");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ThemeImportPreview | null>(null);

  const run = useCallback(async (input: { text?: string; url?: string; path?: string }) => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewThemeImport(input));
    } catch (cause) {
      setPreview(null);
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  // `plugin-dialog` is imported lazily, the way every other file picker in the
  // app does it: in a plain browser the plugin is not loaded at all.
  const chooseFile = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        filters: [{ name: "Theme", extensions: ["json", "jsonc", "css"] }],
      });
      if (typeof picked !== "string") return;
      setPath(picked);
      await run({ path: picked });
    } catch (cause) {
      setError(String(cause));
    }
  }, [run]);

  const submit = () => {
    if (source === "url") return void run({ url });
    if (source === "file") return void (path ? run({ path }) : chooseFile());
    return void run({ text });
  };

  const ready =
    source === "url" ? url.trim().length > 0 : source === "file" || text.trim().length > 0;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center gap-1">
          {SOURCES.map((entry) => (
            <Button
              key={entry.id}
              size="sm"
              variant={source === entry.id ? "secondary" : "ghost"}
              onClick={() => setSource(entry.id)}
            >
              <Icon icon={entry.icon} size="sm" />
              {entry.label}
            </Button>
          ))}
        </div>

        {source === "paste" && (
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            rows={8}
            className={cn(
              "w-full resize-y rounded border border-border bg-panel-input p-2",
              "code text-foreground outline-none placeholder:text-muted-foreground",
              "focus:border-border-strong",
            )}
          />
        )}
        {source === "url" && (
          <div className="flex flex-col gap-1">
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/registry/my-theme.json"
              spellCheck={false}
              size="lg"
            />
            <p className="caption">
              Fetched once, with a ten-second limit. The file is converted and then forgotten —
              Atlas never reads the URL again.
            </p>
          </div>
        )}
        {source === "file" && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void chooseFile()}>
                Choose file…
              </Button>
              {path && <span className="code truncate text-secondary-foreground">{path}</span>}
            </div>
            <p className="caption">
              The only source that can follow a VS Code <span className="code">include</span>, since
              an include names a sibling file.
            </p>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={submit} disabled={busy || !ready}>
            {busy ? "Converting…" : "Convert"}
          </Button>
          {preview && (
            <span className="caption">
              {preview.format} · {preview.origin}
            </span>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive bg-error-muted p-2">
            <Icon icon={AlertTriangle} size="sm" className="mt-px text-error" />
            <p className="text-xs break-words text-foreground">{error}</p>
          </div>
        )}

        {preview?.themes.map((candidate) => (
          <CandidateCard
            key={candidate.id}
            candidate={candidate}
            themes={themes}
            onImported={onImported}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

/**
 * What saving under `id` would collide with. The preview's `existing` answers
 * for the id it proposed; once the user edits the id, the catalog answers for
 * the id Rust will actually save under.
 */
function originOf(
  id: string,
  candidate: ThemeImportCandidate,
  themes: ThemeSummary[],
): ThemeOrigin {
  if (id === candidate.id) return candidate.existing;
  const match = themes.find((theme) => theme.id === id);
  if (!match) return "new";
  return match.builtIn ? "built-in" : "user";
}

function CandidateCard({
  candidate,
  themes,
  onImported,
}: {
  candidate: ThemeImportCandidate;
  themes: ThemeSummary[];
  onImported: (id: string) => void;
}) {
  const [name, setName] = useState(candidate.name);
  const [id, setId] = useState(candidate.id);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedId = useMemo(() => themeIdSlug(id), [id]);
  const existing = originOf(savedId, candidate, themes);

  const save = async () => {
    setSaving(true);
    try {
      // Rust slugs the typed id; the id it saved under is the one to apply.
      const committed = await commitThemeImport(candidate.toml, id, name);
      setSaved(true);
      onImported(committed.id);
      toast.success(`Imported “${name}”`);
    } catch (cause) {
      toast.error(String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="heading truncate text-foreground">{candidate.report.sourceName}</span>
        <FidelityBadge report={candidate.report} />
        {candidate.variants.map((variant) => (
          <Badge key={variant} size="sm" variant="outline" className="capitalize">
            {variant}
          </Badge>
        ))}
        {existing === "built-in" && (
          <Badge size="sm" variant="warning">
            Shadows a built-in
          </Badge>
        )}
        {existing === "user" && (
          <Badge size="sm" variant="warning">
            Replaces an import
          </Badge>
        )}
      </div>

      <Counts report={candidate.report} />

      {candidate.report.summary.map((line) => (
        <p key={line} className="caption">
          {line}
        </p>
      ))}
      {candidate.report.warnings.map((line) => (
        <p key={line} className="flex items-start gap-1.5 text-xs text-warning">
          <Icon icon={AlertTriangle} size="sm" className="mt-px" />
          <span>{line}</span>
        </p>
      ))}

      <IgnoredByCategory report={candidate.report} />
      <KeyLists report={candidate.report} />

      <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-2">
        <Field label="Name" value={name} onChange={setName} className="min-w-40 flex-1" />
        <Field label="Id" value={id} onChange={setId} className="min-w-32 flex-1" />
        <Button size="sm" onClick={() => void save()} disabled={saving || !savedId}>
          {saved && <Icon icon={Check} size="sm" />}
          {saving ? "Saving…" : saved ? "Saved" : "Add theme"}
        </Button>
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="eyebrow text-muted-foreground">{label}</span>
      <Input value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
    </label>
  );
}

function FidelityBadge({ report }: { report: ThemeImportReport }) {
  const variant =
    report.fidelity === "native" ? "success" : report.fidelity === "lossy" ? "warning" : "info";
  return (
    <Badge size="sm" variant={variant}>
      {FIDELITY_LABEL[report.fidelity]}
    </Badge>
  );
}

/** Three numbers, because they are the shape of the whole answer. */
function Counts({ report }: { report: ThemeImportReport }) {
  const items = [
    { label: "mapped", value: report.counts.mapped, hint: "the source said this" },
    { label: "derived", value: report.counts.derived, hint: "Atlas worked this out" },
    { label: "ignored", value: report.counts.ignored, hint: "nowhere to put it" },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((item) => (
        <div key={item.label} className="rounded border border-border-subtle bg-card px-2 py-1.5">
          <div className="text-md font-semibold tabular-nums text-foreground">{item.value}</div>
          <div className="eyebrow text-muted-foreground">{item.label}</div>
          <div className="caption">{item.hint}</div>
        </div>
      ))}
    </div>
  );
}

function IgnoredByCategory({ report }: { report: ThemeImportReport }) {
  const entries = Object.entries(report.counts.ignoredByCategory).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <Details summary={`What was dropped (${entries.length} categories)`}>
      <ul className="flex flex-col gap-1">
        {entries.map(([category, count]) => {
          const reason = report.ignored.find((entry) => entry.category === category)?.reason ?? "";
          return (
            <li key={category} className="flex items-baseline gap-2">
              <span className="w-8 shrink-0 text-right text-xs tabular-nums text-foreground">
                {count}
              </span>
              <span className="text-xs text-secondary-foreground">{category}</span>
              <span className="caption truncate">{reason}</span>
            </li>
          );
        })}
      </ul>
    </Details>
  );
}

function KeyLists({ report }: { report: ThemeImportReport }) {
  return (
    <>
      <Details summary={`Mapped keys (${report.mapped.length})`}>
        <KeyTable rows={report.mapped.map((entry) => [entry.target, entry.source, entry.value])} />
      </Details>
      <Details summary={`Derived keys (${report.derived.length})`}>
        <KeyTable
          rows={report.derived.map((entry) => [entry.target, `from ${entry.from}`, entry.value])}
        />
      </Details>
    </>
  );
}

function KeyTable({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className="flex max-h-64 flex-col gap-0.5 overflow-auto">
      {rows.map(([target, source, value]) => (
        <div key={`${target}:${source}`} className="flex items-center gap-2">
          <Swatch value={value} />
          <span className="code truncate text-foreground">{target}</span>
          <span className="caption ml-auto truncate">{source}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * A colour chip, or nothing. `value` may be a font stack or a shadow as easily
 * as a colour, and a swatch of `"Inter, sans-serif"` is a transparent square
 * that reads as a bug.
 */
function Swatch({ value }: { value: string }) {
  const isColor = /^(#|rgb|hsl|oklch)/i.test(value.trim());
  if (!isColor) return <span className="size-3 shrink-0" />;
  return (
    <span
      className="size-3 shrink-0 rounded-sm border border-border-subtle"
      style={{ backgroundColor: value }}
      title={value}
    />
  );
}

function Details({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="group rounded border border-border-subtle bg-card">
      <summary className="label cursor-pointer select-none px-2 py-1 text-secondary-foreground hover:text-foreground">
        {summary}
      </summary>
      <div className="border-t border-border-subtle p-2">{children}</div>
    </details>
  );
}

function ExportView({ themes }: { themes: ThemeSummary[] }) {
  const ids = useMemo(() => themes.map((theme) => theme.id), [themes]);
  const [selected, setSelected] = useState(ids[0] ?? "");
  const [result, setResult] = useState<ShadcnExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async (id: string) => {
    setSelected(id);
    setError(null);
    try {
      setResult(await exportThemeShadcn(id));
      setCopied(false);
    } catch (cause) {
      setResult(null);
      setError(String(cause));
    }
  };

  // `copyText`, not `navigator.clipboard`: WKWebView's own writeText can
  // resolve without writing, and this copy follows an `await` on the export.
  const copy = async () => {
    if (!result) return;
    const ok = await copyText(result.json);
    setCopied(ok);
    if (ok) toast.success("Registry item copied");
    else toast.error("Could not reach the clipboard");
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-3 p-3">
        <p className="caption">
          Any Atlas theme as a shadcn <span className="code">registry:style</span> item. The base
          tokens cross verbatim; everything above them — palette, editor, terminal, syntax, diff,
          comms, agent chips — has no shadcn equivalent and is dropped.
        </p>
        <div className="flex flex-wrap gap-1">
          {themes.map((theme) => (
            <Button
              key={theme.id}
              size="sm"
              variant={selected === theme.id && result ? "secondary" : "outline"}
              onClick={() => void load(theme.id)}
            >
              {theme.name}
            </Button>
          ))}
        </div>

        {error && <p className="text-xs text-error">{error}</p>}

        {result && (
          <section className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
            <div className="flex items-center gap-1.5">
              <span className="heading text-foreground">{result.name}</span>
              <Badge size="sm" variant="secondary">
                {result.report.exported} tokens
              </Badge>
              <Badge size="sm" variant="warning">
                {result.report.dropped} dropped
              </Badge>
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => void copy()}>
                <CopyGlyph copied={copied} size="sm" />
                {copied ? "Copied" : "Copy JSON"}
              </Button>
            </div>
            {result.report.notes.map((note) => (
              <p key={note} className="caption">
                {note}
              </p>
            ))}
            <pre className="code max-h-72 overflow-auto rounded border border-border-subtle bg-card p-2 text-secondary-foreground">
              {result.json}
            </pre>
          </section>
        )}
      </div>
    </ScrollArea>
  );
}
