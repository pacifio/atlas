/**
 * The theme editor: a panel floating over the live app, which IS the preview.
 * Two colours and the rest derived,
 * an Advanced switch for every slot, a light/dark toggle, draggable and
 * minimisable so the part of the app being judged can be uncovered.
 *
 * What differs is the format underneath. An Atlas theme holds both variants in
 * one file and derives every slot it leaves out (ADR-0022), so there is no
 * "managed" palette to regenerate and nothing to merge: the draft is exactly
 * the values the author set, the preview resolves it the way the app will, and
 * saving writes those values and nothing else. A slot the author never touched
 * keeps improving with Atlas's derivation; one they set stays theirs.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ChevronDown, ChevronUp, Moon, Paintbrush, Sun, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { applyTheme } from "../../apply-theme";
import { saveTheme } from "../../lib/theme-api";
import { themeIdSlug } from "../../lib/theme-import-api";
import {
  ROLE_GROUPS,
  SEED_TOKENS,
  SIMPLE_ROLES,
  type EditorRole,
  type EditorTable,
} from "../../lib/theme-editor-roles";
import type { ThemeEditorSession } from "../../stores/theme-editor-store";
import { repaintTheme, useThemeStore } from "../../stores/theme-store";
import { ColorField } from "./color-field";
import {
  type Theme,
  type ThemeAppearance,
  type ThemeVariant,
  resolveTheme,
  type ThemeKey,
} from "@tryatlas/design/theme";
import { Button, Icon, IconButton, Input, Segmented, Switch } from "@tryatlas/design";

/** The values an author set in one variant — nothing derived is in here. */
type Slots = Record<EditorTable, Record<string, string>>;
type Draft = Record<ThemeAppearance, Slots | null>;

const APPEARANCES = [
  { value: "light", label: "Light", icon: <Icon icon={Sun} size="xs" /> },
  { value: "dark", label: "Dark", icon: <Icon icon={Moon} size="xs" /> },
] as const;

const empty = (): Slots => ({ base: {}, palette: {}, keys: {} });

function slotsOf(variant: ThemeVariant, only?: readonly string[]): Slots {
  const base = only
    ? Object.fromEntries(Object.entries(variant.base).filter(([token]) => only.includes(token)))
    : { ...variant.base };
  if (only) return { ...empty(), base };
  const keys = Object.fromEntries(
    Object.entries(variant.keys).map(([key, value]) => [
      key,
      typeof value === "string" ? value : value.color,
    ]),
  );
  return { base, palette: { ...variant.palette }, keys };
}

function initialDraft(session: ThemeEditorSession, source: Theme): Draft {
  // The other two keep every value the source writes, in both variants.
  if (session.kind !== "create") {
    return {
      light: source.light ? slotsOf(source.light) : null,
      dark: source.dark ? slotsOf(source.dark) : null,
    };
  }
  // `create` keeps only the seeds of the variant on screen, so the new theme
  // is those colours with everything else derived — and has only the variants
  // the author set something in, rather than an untouched copy of the other.
  const half = session.initialAppearance;
  const variant = source[half];
  return {
    light: null,
    dark: null,
    [half]: variant ? slotsOf(variant, SEED_TOKENS) : null,
  };
}

/** For a palette hue the theme leaves unset there is no palette value to show,
 *  so the field shows the colour that hue would steer: what the app uses now. */
const PALETTE_STAND_IN: Record<string, ThemeKey> = {
  red: "terminal.ansi.red",
  orange: "syntax.number",
  yellow: "terminal.ansi.yellow",
  green: "terminal.ansi.green",
  cyan: "terminal.ansi.cyan",
  blue: "terminal.ansi.blue",
  purple: "terminal.ansi.magenta",
  pink: "syntax.escape",
};

const COLOR_BASE_ROLES = new Set(
  ROLE_GROUPS.flatMap((group) => group.roles)
    .filter((role) => role.table === "base")
    .map((role) => role.name),
);

function clampPosition(panel: HTMLElement | null, x: number, y: number) {
  const margin = 8;
  const width = panel?.offsetWidth ?? 0;
  return {
    x: Math.min(Math.max(x, margin), Math.max(margin, window.innerWidth - width - margin)),
    y: Math.min(Math.max(y, margin), Math.max(margin, window.innerHeight - 48)),
  };
}

export function ThemeEditorPanel({
  session,
  source,
  onClose,
}: {
  session: ThemeEditorSession;
  source: Theme;
  onClose: () => void;
}) {
  const editing = session.kind === "edit";
  const themes = useThemeStore.use.themes();
  const { load, reapply } = useThemeStore.use.actions();
  const { updateSettings } = useSettingsStore.use.actions();

  const [name, setName] = useState(() =>
    editing ? source.name : session.kind === "duplicate" ? `${source.name} copy` : "",
  );
  // A duplicate is a derivative, so it starts with the source's credit and
  // licence, which an MIT or Apache theme requires it to keep. A theme made
  // from seeds is new and starts with neither; both matter once it is shared.
  const [author, setAuthor] = useState(() => (session.kind === "create" ? "" : source.author));
  const [license, setLicense] = useState(() => (session.kind === "create" ? "" : source.license));
  const [draft, setDraft] = useState<Draft>(() => initialDraft(session, source));
  const [appearance, setAppearance] = useState<ThemeAppearance>(() =>
    source[session.initialAppearance]
      ? session.initialAppearance
      : session.initialAppearance === "light"
        ? "dark"
        : "light",
  );
  const [advanced, setAdvanced] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null);

  // The draft as a theme. The variant on screen always exists, even before
  // its first value: an empty one resolves to Atlas's defaults, which is what
  // a new variant starts from.
  const draftTheme = useMemo<Theme>(() => {
    const variant = (half: ThemeAppearance) =>
      draft[half] ?? (half === appearance ? empty() : null);
    const light = variant("light");
    const dark = variant("dark");
    return {
      schema: 1,
      id: "theme-editor-draft",
      name,
      author,
      license,
      ...(light ? { light } : {}),
      ...(dark ? { dark } : {}),
    };
  }, [appearance, draft, name, author, license]);

  const resolved = useMemo(() => resolveTheme(draftTheme, appearance), [draftTheme, appearance]);

  // The whole app is the preview. Not cached for the next launch, and the
  // configured theme is painted back when the editor closes, however it does.
  useEffect(() => {
    applyTheme(draftTheme, appearance, {}, { preview: true });
  }, [draftTheme, appearance]);
  useEffect(() => () => repaintTheme(), []);

  useEffect(() => {
    const keepOnScreen = () =>
      setPosition((current) =>
        current ? clampPosition(panelRef.current, current.x, current.y) : current,
      );
    window.addEventListener("resize", keepOnScreen);
    return () => window.removeEventListener("resize", keepOnScreen);
  }, []);

  const written = draft[appearance];

  const setSlot = (table: EditorTable, slot: string, value: string | null) => {
    setError(null);
    setDraft((current) => {
      const slots = current[appearance] ?? empty();
      const nextTable = { ...slots[table] };
      if (value === null) delete nextTable[slot];
      else nextTable[slot] = value;
      return { ...current, [appearance]: { ...slots, [table]: nextTable } };
    });
  };

  const valueOf = (role: EditorRole): string => {
    if (role.table === "base") return resolved.base[role.name] ?? "";
    if (role.table === "keys") return resolved.keys[role.name as ThemeKey] ?? "";
    return resolved.palette[role.name] ?? resolved.keys[PALETTE_STAND_IN[role.name]] ?? "";
  };

  // Set by hand and so deaf to the seeds: what a duplicated built-in starts
  // with, since built-ins pin every colour. Simple mode says so, and offers
  // to let them follow.
  const pinned = Object.keys(written?.base ?? {}).filter(
    (token) => COLOR_BASE_ROLES.has(token) && !(SEED_TOKENS as readonly string[]).includes(token),
  );

  const letThemFollow = () =>
    setDraft((current) => {
      const slots = current[appearance];
      if (!slots) return current;
      const base = Object.fromEntries(
        Object.entries(slots.base).filter(([token]) => !pinned.includes(token)),
      );
      return { ...current, [appearance]: { ...slots, base } };
    });

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name your theme first.");
      return;
    }
    const id = editing ? source.id : themeIdSlug(trimmed);
    if (!id) {
      setError("The name needs at least one letter or digit.");
      return;
    }
    if (!editing && themes.some((theme) => theme.id === id)) {
      setError(`A theme called “${trimmed}” already exists. Pick another name.`);
      return;
    }
    const light = draft.light ?? undefined;
    const dark = draft.dark ?? undefined;
    if (!light && !dark) {
      setError("Set at least one colour first.");
      return;
    }
    const theme: Theme = {
      schema: 1,
      id,
      name: trimmed,
      author: author.trim(),
      license: license.trim(),
      ...(session.kind !== "create" && source.base ? { base: source.base } : {}),
      ...(light ? { light } : {}),
      ...(dark ? { dark } : {}),
    };
    setSaving(true);
    try {
      const saved = await saveTheme(theme);
      await load();
      if (editing) {
        await reapply();
      } else {
        await updateSettings({
          ...(light ? { themeLight: saved.id } : {}),
          ...(dark ? { themeDark: saved.id } : {}),
        });
      }
      toast.success(editing ? `Saved “${trimmed}”` : `Created “${trimmed}”`);
      onClose();
    } catch (cause) {
      setError(String(cause));
      setSaving(false);
    }
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, input")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffset.current = { dx: event.clientX - rect.x, dy: event.clientY - rect.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const offset = dragOffset.current;
    if (!offset) return;
    setPosition(
      clampPosition(panelRef.current, event.clientX - offset.dx, event.clientY - offset.dy),
    );
  };
  const endDrag = () => {
    dragOffset.current = null;
  };

  const field = (role: EditorRole) => (
    <ColorField
      key={`${role.table}.${role.name}`}
      label={role.label}
      description={role.description}
      value={valueOf(role)}
      written={written?.[role.table][role.name] !== undefined}
      onChange={(value) => setSlot(role.table, role.name, value)}
      onReset={() => setSlot(role.table, role.name, null)}
    />
  );

  const needle = query.trim().toLowerCase();
  const groups = ROLE_GROUPS.map((group) => ({
    ...group,
    roles: group.roles.filter(
      (role) =>
        !needle || `${role.label} ${role.name} ${group.title}`.toLowerCase().includes(needle),
    ),
  })).filter((group) => group.roles.length > 0);

  const title = { create: "Create theme", duplicate: "Duplicate theme", edit: "Edit theme" }[
    session.kind
  ];

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={title}
      data-theme-editor-panel
      className={cn(
        "fixed z-modal flex w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden",
        "rounded-lg border border-border bg-popover text-foreground shadow-lg",
        !minimized && "max-h-[min(42rem,calc(100dvh-6rem))]",
        position === null && "right-4 bottom-4",
      )}
      style={position ? { left: position.x, top: position.y } : undefined}
    >
      <div
        className="flex cursor-grab touch-none items-center gap-1 border-b border-border-subtle px-3 py-2 select-none active:cursor-grabbing"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="shrink-0 text-sm font-medium">{title}</h2>
          {!minimized && (
            <p className="truncate text-xs text-muted-foreground">
              {advanced ? "Every colour; unset ones derive" : "Two colours, the rest derived"}
            </p>
          )}
        </div>
        <IconButton
          icon={minimized ? ChevronUp : ChevronDown}
          size="xs"
          label={minimized ? "Expand the theme editor" : "Minimise the theme editor"}
          onClick={() => setMinimized(!minimized)}
        />
        <IconButton icon={X} size="xs" label="Close the theme editor" onClick={onClose} />
      </div>

      {!minimized && (
        <>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
            <label className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
              <span className="text-xs font-medium">Name</span>
              <Input
                autoFocus
                size="sm"
                placeholder="e.g. Aurora"
                value={name}
                disabled={editing}
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setError(null);
                }}
              />
            </label>
            <label className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
              <span className="text-xs font-medium">Author</span>
              <Input
                size="sm"
                placeholder="Who made it"
                value={author}
                onChange={(event) => setAuthor(event.currentTarget.value)}
              />
            </label>
            <label className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
              <span className="text-xs font-medium">Licence</span>
              <Input
                size="sm"
                placeholder="e.g. MIT"
                value={license}
                onChange={(event) => setLicense(event.currentTarget.value)}
              />
            </label>
            {session.kind === "duplicate" && source.author && (
              <p className="text-xs text-muted-foreground">
                If you share it, keep the original credit (“{source.author}”) in Author: most theme
                licences require it.
              </p>
            )}
            {error && (
              <p aria-live="polite" className="text-xs text-error">
                {error}
              </p>
            )}
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
              <span className="text-xs font-medium">Appearance</span>
              <Segmented
                aria-label="Appearance being edited"
                size="sm"
                value={appearance}
                options={APPEARANCES}
                onValueChange={setAppearance}
              />
            </div>
            {!written && (
              <p className="text-xs text-muted-foreground">
                This theme has no {appearance} variant yet. Set a colour to add one.
              </p>
            )}

            <div className="flex items-center gap-3 pt-1">
              <h3 className="text-xs font-medium">Colours</h3>
              {advanced && (
                <Input
                  size="sm"
                  aria-label="Filter colours"
                  placeholder="Filter colours"
                  className="min-w-0 flex-1"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
              )}
              <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-2 text-xs">
                Advanced
                <Switch size="sm" checked={advanced} onCheckedChange={setAdvanced} />
              </label>
            </div>

            {advanced ? (
              <div className="space-y-4">
                {groups.map((group) => (
                  <section key={group.id} className="space-y-1">
                    <h4 className="px-1.5 text-2xs font-medium text-muted-foreground uppercase">
                      {group.title}
                    </h4>
                    <div className="grid gap-0.5">{group.roles.map(field)}</div>
                  </section>
                ))}
                {groups.length === 0 && (
                  <p className="text-xs text-muted-foreground">No colours match.</p>
                )}
              </div>
            ) : (
              <div className="grid gap-0.5">
                {SIMPLE_ROLES.map(field)}
                {pinned.length > 0 && (
                  <div className="mt-2 flex items-start gap-2 rounded-md border border-border-subtle bg-muted px-2.5 py-2">
                    <p className="flex-1 text-xs text-muted-foreground">
                      {pinned.length === 1 ? "1 colour is" : `${pinned.length} colours are`} set by
                      hand and won't follow these two.
                    </p>
                    <Button size="xs" variant="outline" onClick={letThemFollow}>
                      Let them follow
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-3 py-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={!name.trim() || saving} onClick={() => void save()}>
              <Icon icon={Paintbrush} size="sm" />
              {editing ? "Save changes" : "Create theme"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
