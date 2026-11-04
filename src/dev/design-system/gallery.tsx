import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { useThemeStore } from "@/features/theme/stores/theme-store";
import { BASE_COLOR_TOKENS, LAYOUT_CONSTANTS } from "./tokens";
import {
  describeDerivation,
  DERIVED_VAR_REGISTRY,
  THEME_KEY_REGISTRY,
  type ThemeMode,
} from "@tryatlas/design/theme";

/** Where the primitives and the Foundations scales are reviewed (ADR-0027). */
const STORYBOOK_URL = "https://design.tryatlas.cc";

/**
 * The design-system gallery (decision 21), desktop's half.
 *
 * Dev-only, reached at `localhost:1420/?scenario=design-system`. The
 * primitives and the Foundations scales (type, controls, radius, elevation,
 * z-index, motion, icons) belong to `@tryatlas/design` and are reviewed in its
 * Storybook, under every built-in theme. What only desktop can show is here:
 *
 *  - every colour role as desktop's runtime applier resolved it, for the
 *    ACTIVE theme — which may be a user's imported theme or a theme-editor
 *    preview, neither of which Storybook has;
 *  - the layout utilities desktop defines on top of the package.
 *
 * Values are read back with `getComputedStyle` rather than printed from a
 * table, so a token that stops resolving shows up here as an empty cell
 * instead of a number that is only true in this file.
 */

// ── plumbing ────────────────────────────────────────────────────────────────

/** Re-read on every theme application, so the printed values track the theme. */
function useCssValues(names: readonly string[]): Record<string, string> {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener("atlas:theme-applied", bump);
    return () => window.removeEventListener("atlas:theme-applied", bump);
  }, []);
  return useMemo(() => {
    void tick;
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()]));
  }, [names, tick]);
}

function Section({
  title,
  decision,
  note,
  children,
}: {
  title: string;
  decision: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border-subtle py-8">
      <div className="mb-4 flex items-baseline gap-2">
        <h2 className="heading">{title}</h2>
        <span className="caption">{decision}</span>
      </div>
      {note ? <p className="caption mb-4 max-w-2xl">{note}</p> : null}
      {children}
    </section>
  );
}

function Row({ name, value, children }: { name: string; value?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-1.5">
      <code className="code w-44 shrink-0 text-secondary-foreground">{name}</code>
      <code className="code w-28 shrink-0 text-muted-foreground">{value ?? ""}</code>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// ── colour ──────────────────────────────────────────────────────────────────

function Swatch({
  cssVar,
  label,
  value,
  derivation,
}: {
  cssVar: string;
  label: string;
  value?: string;
  derivation?: string;
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      <div
        className="size-control-md shrink-0 rounded border border-border"
        style={{ background: `var(${cssVar})` }}
      />
      <div className="min-w-0">
        <div className="code truncate text-foreground">{label}</div>
        <div className="caption truncate" title={derivation}>
          {value || "—"}
          {derivation ? ` · ${derivation}` : ""}
        </div>
      </div>
    </div>
  );
}

/**
 * The swatches above read each token as an inline `var()`, which works whether
 * or not Tailwind knows it exists. These are the Tailwind UTILITIES, spelled
 * out as literal class strings so the scanner actually emits them — the only
 * way to see a missing `@theme inline` entry, which is silent everywhere else:
 * `chart-1..5` and all eight `sidebar-*` had no `--color-*` mapping at all, so
 * `bg-sidebar` and `text-chart-1` generated no rule and stock shadcn markup
 * would have rendered transparent the moment PR 3 landed it.
 *
 * A bar here that shows as the page background is an unmapped token.
 */
function UtilityCheck() {
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="eyebrow mb-2">Tailwind utilities</div>
      <div className="flex gap-1">
        <div className="h-control-sm flex-1 rounded bg-chart-1" title="bg-chart-1" />
        <div className="h-control-sm flex-1 rounded bg-chart-2" title="bg-chart-2" />
        <div className="h-control-sm flex-1 rounded bg-chart-3" title="bg-chart-3" />
        <div className="h-control-sm flex-1 rounded bg-chart-4" title="bg-chart-4" />
        <div className="h-control-sm flex-1 rounded bg-chart-5" title="bg-chart-5" />
      </div>
      <div className="mt-1 flex items-center gap-2 rounded border border-sidebar-border bg-sidebar px-2 py-1.5">
        <span className="label text-sidebar-foreground">bg-sidebar</span>
        <span className="rounded bg-sidebar-primary px-1.5 text-sidebar-primary-foreground label">
          primary
        </span>
        <span className="rounded bg-sidebar-accent px-1.5 text-sidebar-accent-foreground label">
          accent
        </span>
        <span className="ml-auto size-control-xs rounded-full ring-2 ring-sidebar-ring" />
      </div>
      <div className="mt-1 font-serif text-muted-foreground caption">font-serif</div>
    </div>
  );
}

const COLOUR_VARS = [
  ...BASE_COLOR_TOKENS.map((token) => `--${token}`),
  ...THEME_KEY_REGISTRY.map((definition) => definition.cssVar as string),
  ...DERIVED_VAR_REGISTRY.map((definition) => definition.cssVar as string),
];

function ColourSections() {
  const values = useCssValues(COLOUR_VARS);
  const groups = useMemo(() => {
    const byPrefix = new Map<string, (typeof THEME_KEY_REGISTRY)[number][]>();
    for (const definition of THEME_KEY_REGISTRY) {
      const prefix = definition.key.split(".")[0];
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), definition]);
    }
    return [...byPrefix.entries()];
  }, []);

  return (
    <>
      <Section
        title="Base tokens"
        decision="decision 2 · shadcn names, verbatim"
        note="The required level of a theme file. Everything else in Atlas derives from these."
      >
        <div className="grid grid-cols-2 gap-x-6 md:grid-cols-4">
          {BASE_COLOR_TOKENS.map((token) => (
            <Swatch key={token} cssVar={`--${token}`} label={token} value={values[`--${token}`]} />
          ))}
        </div>
        <UtilityCheck />
      </Section>

      {groups.map(([prefix, definitions]) => (
        <Section
          key={prefix}
          title={`Theme keys · ${prefix}`}
          decision={`${definitions.length} keys`}
        >
          <div className="grid grid-cols-2 gap-x-6 md:grid-cols-3">
            {definitions.map((definition) => (
              <Swatch
                key={definition.key}
                cssVar={definition.cssVar}
                label={definition.key}
                value={values[definition.cssVar]}
                derivation={describeDerivation(definition)}
              />
            ))}
          </div>
        </Section>
      ))}

      <Section
        title="Derived variables"
        decision={`${DERIVED_VAR_REGISTRY.length} variables`}
        note="Written like a theme key, but no theme may set one: each is a pure transform of a key or a base token, so an author steers it through that."
      >
        <div className="grid grid-cols-2 gap-x-6 md:grid-cols-3">
          {DERIVED_VAR_REGISTRY.map((definition) => (
            <Swatch
              key={definition.name}
              cssVar={definition.cssVar}
              label={definition.name}
              value={values[definition.cssVar]}
              derivation={definition.from ? definition.from : `base.${definition.base}`}
            />
          ))}
        </div>
      </Section>
    </>
  );
}

// ── desktop's own ──────────────────────────────────────────────────────────

const LAYOUT_VARS = LAYOUT_CONSTANTS.map((l) => l.cssVar);

function DesktopSection() {
  const values = useCssValues(LAYOUT_VARS);
  return (
    <Section
      title="Desktop's own"
      decision="src/styles/globals.css"
      note="Utilities desktop defines on top of the package: the one bar every column header shares, the composer's capsule corner and the terminal's font."
    >
      {LAYOUT_CONSTANTS.map((l) => (
        <Row key={l.cssVar} name={l.utility} value={values[l.cssVar]}>
          <div className="h-titlebar w-64 rounded border border-border bg-sidebar" />
        </Row>
      ))}
      <Row name="rounded-composer" value="23px">
        <div className="rounded-composer h-[46px] w-64 border border-border bg-card" />
      </Row>
      <Row name="font-terminal">
        <span className="font-terminal text-xs text-foreground">$ bun run dev</span>
      </Row>
    </Section>
  );
}

function StorybookNote() {
  return (
    <section className="border-t border-border-subtle py-8">
      <p className="body max-w-2xl text-secondary-foreground">
        The primitives and the Foundations scales live in{" "}
        <code className="code">@tryatlas/design</code>. Review them in its Storybook, under every
        built-in theme:{" "}
        <a
          className="inline-flex items-center gap-1 text-foreground underline underline-offset-2"
          href={STORYBOOK_URL}
          target="_blank"
          rel="noreferrer"
        >
          {STORYBOOK_URL.replace("https://", "")}
          <ExternalLink size={12} />
        </a>
      </p>
    </section>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

const MODES: ThemeMode[] = ["system", "dark", "light"];

function Header() {
  const themes = useThemeStore.use.themes();
  const actions = useThemeStore.use.actions();
  const [themeId, setThemeId] = useState("atlas");
  const [mode, setMode] = useState<ThemeMode>("dark");

  useEffect(() => {
    void actions.load();
  }, [actions]);

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    if (current) setThemeId(current);
  }, []);

  const apply = (id: string, nextMode: ThemeMode) => {
    setThemeId(id);
    setMode(nextMode);
    void actions.apply(id, nextMode);
  };

  return (
    <header className="z-titlebar sticky top-0 -mx-8 mb-2 flex items-center gap-3 border-b border-border bg-background px-8 py-3 backdrop-blur-glass">
      <div>
        <div className="heading">Atlas design system · desktop</div>
        <div className="caption">The active theme, as desktop resolved it</div>
      </div>
      <div className="flex-1" />
      <label className="label flex items-center gap-2">
        Theme
        <select
          className="h-control-md rounded border border-border bg-panel-input px-2 text-xs text-foreground"
          value={themeId}
          onChange={(e) => apply(e.target.value, mode)}
        >
          {themes.length === 0 ? <option value={themeId}>{themeId}</option> : null}
          {themes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.name}
            </option>
          ))}
        </select>
      </label>
      <label className="label flex items-center gap-2">
        Mode
        <select
          className="h-control-md rounded border border-border bg-panel-input px-2 text-xs text-foreground"
          value={mode}
          onChange={(e) => apply(themeId, e.target.value as ThemeMode)}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
    </header>
  );
}

export function DesignSystemGallery() {
  return (
    <div className="h-full overflow-y-auto bg-background px-8 pb-24 text-foreground">
      <Header />
      <StorybookNote />
      <ColourSections />
      <DesktopSection />
    </div>
  );
}
