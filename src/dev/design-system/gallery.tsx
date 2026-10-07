import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy, Plus, Search, Settings, Trash2, X } from "lucide-react";
import {
  describeDerivation,
  DERIVED_VAR_REGISTRY,
  THEME_KEY_REGISTRY,
} from "@/features/theme/theme-key-registry";
import { useThemeStore } from "@/features/theme/stores/theme-store";
import type { ThemeMode } from "@/features/theme/lib/theme-api";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Icon, ICON_SIZES, type IconSize } from "@/ui/icon";
import {
  BellGlyph,
  CopyGlyph,
  MenuGlyph,
  PlusMinusGlyph,
  RailGlyph,
  SendGlyph,
  TrashGlyph,
} from "@/ui/animated-icon";
import { Input } from "@/ui/input";
import { Kbd, KbdCombo } from "@/ui/kbd";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/ui/popover";
import { Hint, Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  BASE_COLOR_TOKENS,
  CONTROL_HEIGHTS,
  DURATIONS,
  EASINGS,
  ELEVATIONS,
  LAYOUT_CONSTANTS,
  RADII,
  TEXT_STYLES,
  TYPE_SCALE,
  Z_LAYERS,
} from "./tokens";

/**
 * The design-system gallery (decision 21).
 *
 * Dev-only, reached at `localhost:1420/?scenario=design-system`. It renders
 * every Foundations token and every `src/ui` primitive against the ACTIVE
 * theme, which makes it the one page a visual review opens: pick a theme in
 * the header and every section below repaints.
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

// ── the rest of the scales ──────────────────────────────────────────────────

const TYPE_VARS = TYPE_SCALE.map((s) => `--text-${s.name}`);
const CONTROL_VARS = [
  ...CONTROL_HEIGHTS.map((c) => c.cssVar),
  ...LAYOUT_CONSTANTS.map((l) => l.cssVar),
];
const RADIUS_VARS = ["--radius", ...RADII.map((r) => r.cssVar)];
const ELEVATION_VARS = ELEVATIONS.map((e) => e.cssVar);
const Z_VARS = Z_LAYERS.map((z) => z.cssVar);
const DURATION_VARS = DURATIONS.map((d) => d.cssVar);

function TypeSection() {
  const values = useCssValues(TYPE_VARS);
  return (
    <>
      <Section
        title="Type scale"
        decision="decision 24"
        note="Nine steps. Half-pixel sizes round up. Only two weights exist: 500 (font-medium) and 600 (font-semibold)."
      >
        {TYPE_SCALE.map((step) => (
          <Row key={step.name} name={step.utility} value={values[`--text-${step.name}`]}>
            <span className={cn(step.utility, "font-medium text-foreground")}>
              Atlas renders dense chrome at {step.px}px
            </span>
          </Row>
        ))}
        <div className="mt-4 flex items-center gap-6">
          <span className="body font-medium">font-medium · 500</span>
          <span className="body font-semibold">font-semibold · 600</span>
        </div>
      </Section>

      <Section
        title="Named text styles"
        decision="decision 24"
        note="Reach for one of these before reaching for a size plus a weight plus a color."
      >
        {TEXT_STYLES.map((style) => (
          <Row key={style.utility} name={style.utility}>
            <div className="flex items-baseline gap-3">
              <span className={style.utility}>The quick brown fox</span>
              <span className="caption">{style.use}</span>
            </div>
          </Row>
        ))}
      </Section>
    </>
  );
}

function ControlHeightSection() {
  const values = useCssValues(CONTROL_VARS);
  return (
    <Section
      title="Control heights"
      decision="decision 25"
      note="Four steps. The heights the audit found at 22, 28 and 30 snap to the nearest one. The titlebar and the center tab strip are named layout constants, not controls."
    >
      {CONTROL_HEIGHTS.map((height) => (
        <Row key={height.name} name={height.utility} value={values[height.cssVar]}>
          <div className="flex items-center gap-3">
            <div className={cn(height.utility, "w-40 rounded border border-border bg-card")} />
            <span className="caption">{height.use}</span>
          </div>
        </Row>
      ))}
      {LAYOUT_CONSTANTS.map((constant) => (
        <Row key={constant.name} name={constant.utility} value={values[constant.cssVar]}>
          <div
            className={cn(constant.utility, "w-40 rounded border border-dashed border-border")}
          />
        </Row>
      ))}
    </Section>
  );
}

function RadiusSection() {
  const values = useCssValues(RADIUS_VARS);
  return (
    <Section
      title="Radius"
      decision="decision 26"
      note={`Derived from the theme's --radius (${values["--radius"] || "—"}): sm = r−4, md = r−2, lg = r, xl = r+4. A theme moves the whole scale by moving one number.`}
    >
      <div className="flex flex-wrap gap-6">
        {RADII.map((radius) => (
          <div key={radius.name} className="w-44">
            <div className={cn(radius.name, "mb-2 h-16 w-full border border-border bg-card")} />
            <div className="code text-secondary-foreground">{radius.name}</div>
            <div className="caption">{values[radius.cssVar] || "—"}</div>
            <div className="caption">{radius.use}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function ElevationSection() {
  const values = useCssValues(ELEVATION_VARS);
  return (
    <Section
      title="Elevation"
      decision="decision 27"
      note="Three levels; the shadow color comes from the theme. inset-highlight is the 1px top edge on raised glass, and it composes with a shadow rather than replacing it."
    >
      <div className="flex flex-wrap gap-6">
        {ELEVATIONS.map((elevation) => (
          <div key={elevation.utility} className="w-56">
            <div
              className={cn(
                elevation.utility,
                "mb-2 flex h-20 items-center justify-center rounded-md bg-card",
              )}
            >
              <span className="code text-secondary-foreground">{elevation.utility}</span>
            </div>
            <div className="caption truncate" title={values[elevation.cssVar]}>
              {values[elevation.cssVar] || "—"}
            </div>
            <div className="caption">{elevation.use}</div>
          </div>
        ))}
        <div className="w-56">
          <div className="inset-highlight mb-2 flex h-20 items-center justify-center rounded-md bg-card">
            <span className="code text-secondary-foreground">inset-highlight</span>
          </div>
          <div className="caption">The top edge, from the `element.highlight` key.</div>
        </div>
        <div className="w-56">
          <div className="backdrop-blur-glass mb-2 flex h-20 items-center justify-center rounded-md border border-border">
            <span className="code text-secondary-foreground">backdrop-blur-glass</span>
          </div>
          <div className="caption">The one glass blur.</div>
        </div>
        <div className="w-56">
          <div className="glass-hud backdrop-blur-glass mb-2 flex h-20 items-center justify-center rounded-lg bg-gradient-to-b from-popover/85 to-card/90">
            <span className="code text-secondary-foreground">glass-hud</span>
          </div>
          <div className="caption">The frosted HUD: hint keycaps, the sign-in dock.</div>
        </div>
        {/* The scrims read against the page, so they sit on it rather than on a
            card — a dim shown over its own fill says nothing. */}
        <div className="w-56">
          <div className="scrim mb-2 flex h-20 items-center justify-center rounded-md">
            {/* ratchet-allow: the scrim below is deliberately theme-invariant black, so its label is deliberately white. */}
            <span className="code text-white">scrim</span>
          </div>
          <div className="caption">
            Dialogs, palettes, a lightbox. Deliberately theme-invariant.
          </div>
        </div>
        <div className="w-56">
          <div className="scrim-soft mb-2 flex h-20 items-center justify-center rounded-md">
            <span className="code text-foreground">scrim-soft</span>
          </div>
          <div className="caption">An in-panel drawer, where the panel carries the depth.</div>
        </div>
      </div>
    </Section>
  );
}

function ZIndexSection() {
  const values = useCssValues(Z_VARS);
  return (
    <Section
      title="Z-index layers"
      decision="decision 28"
      note="popover sits ABOVE modal on purpose, so a menu opened inside a dialog is not clipped behind it. Nothing outside globals.css writes a z-index."
    >
      <div className="flex gap-8">
        <div className="flex-1">
          {Z_LAYERS.map((layer) => (
            <Row key={layer.name} name={layer.utility} value={values[layer.cssVar]}>
              <div
                className="h-1 rounded-full bg-primary"
                style={{ width: `${Math.min(100, Number(values[layer.cssVar] || 0) / 5 + 6)}%` }}
              />
            </Row>
          ))}
        </div>
        <div className="relative h-40 w-64 shrink-0">
          {Z_LAYERS.map((layer, i) => (
            <div
              key={layer.name}
              className={cn(
                layer.utility,
                "absolute flex h-8 w-40 items-center rounded-md border border-border bg-card px-2 shadow-md",
              )}
              style={{ top: i * 14, left: i * 12 }}
            >
              <span className="code text-secondary-foreground">{layer.name}</span>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function MotionSection() {
  const values = useCssValues(DURATION_VARS);
  const [on, setOn] = useState(false);
  return (
    <Section
      title="Motion"
      decision="decision 29"
      note="Four durations and exactly three easing curves. src/ui/tooltip-timing.ts is the model for a component specifying its own motion on top of these."
    >
      <Button size="sm" variant="outline" onClick={() => setOn((v) => !v)} className="mb-4">
        Play
      </Button>
      {DURATIONS.map((duration) => (
        <Row key={duration.name} name={duration.utility} value={values[duration.cssVar]}>
          <div className="h-6 rounded bg-card">
            <div
              className={cn(
                duration.utility,
                "ease-out-strong h-6 w-6 rounded bg-primary transition-transform",
              )}
              style={{ transform: on ? "translateX(220px)" : "translateX(0)" }}
            />
          </div>
        </Row>
      ))}
      {EASINGS.map((easing) => (
        <Row key={easing.name} name={easing.name}>
          <div className="flex items-center gap-3">
            <div className="h-6 flex-1 rounded bg-card">
              <div
                className={cn(
                  easing.name,
                  "duration-slow h-6 w-6 rounded bg-muted-foreground transition-transform",
                )}
                style={{ transform: on ? "translateX(220px)" : "translateX(0)" }}
              />
            </div>
            <span className="caption w-56 shrink-0">{easing.use}</span>
          </div>
        </Row>
      ))}
    </Section>
  );
}

function IconSection() {
  const sizes = Object.keys(ICON_SIZES) as IconSize[];
  return (
    <Section
      title="Icons"
      decision="decision 30"
      note="Five sizes, one stroke width (1.75). The sweep maps the old numbers onto them: 9 → 10, 11 → 12, 13 → 14."
    >
      <div className="flex items-end gap-8">
        {sizes.map((size) => (
          <div key={size} className="flex flex-col items-center gap-2">
            <Icon icon={Search} size={size} className="text-foreground" />
            <span className="code text-secondary-foreground">{size}</span>
            <span className="caption">{ICON_SIZES[size]}px</span>
          </div>
        ))}
        <div className="flex items-center gap-3">
          {[Settings, Plus, Trash2, ChevronRight, Check, Copy, X].map((glyph, i) => (
            <Icon key={i} icon={glyph} size="md" className="text-muted-foreground" />
          ))}
        </div>
      </div>
    </Section>
  );
}

/**
 * The animated glyphs, each wired to the state it is meant to read from. Click
 * every one: these are the only primitives in the gallery whose whole point is
 * the transition, so a static screenshot cannot review them.
 */
function AnimatedIconSection() {
  const [copied, setCopied] = useState(false);
  const [armed, setArmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [rail, setRail] = useState(false);
  const [menu, setMenu] = useState(false);
  const [plus, setPlus] = useState(false);
  const [ringing, setRinging] = useState(false);
  const [muted, setMuted] = useState(false);

  const cell = "flex flex-col items-center gap-2";
  const hit =
    "flex size-control-lg items-center justify-center rounded border border-border text-foreground hover:bg-element-hover";

  return (
    <Section
      title="Animated icons"
      decision="decision 33"
      note="Glyphs that carry a state change. CSS only — no JS animation runtime. Controlled: each takes its state from the caller. Click each one."
    >
      <div className="flex flex-wrap items-end gap-8">
        <div className={cell}>
          <button type="button" className={hit} onClick={() => setCopied((v) => !v)}>
            <CopyGlyph copied={copied} size="lg" />
          </button>
          <span className="code text-secondary-foreground">CopyGlyph</span>
          <span className="caption">draws the check on</span>
        </div>
        <div className={cell}>
          <button type="button" className={hit} onClick={() => setArmed((v) => !v)}>
            <TrashGlyph armed={armed} size="lg" />
          </button>
          <span className="code text-secondary-foreground">TrashGlyph</span>
          <span className="caption">lid hinges open</span>
        </div>
        <div className={cell}>
          <button type="button" className={hit} onClick={() => setSending(true)}>
            <SendGlyph sending={sending} size="lg" onAnimationEnd={() => setSending(false)} />
          </button>
          <span className="code text-secondary-foreground">SendGlyph</span>
          <span className="caption">leaves, next arrives</span>
        </div>
        <div className={cell}>
          <button type="button" className={hit} onClick={() => setRail((v) => !v)}>
            <RailGlyph open={rail} size="lg" />
          </button>
          <span className="code text-secondary-foreground">RailGlyph</span>
          <span className="caption">rail thickens</span>
        </div>
        <div className={cell}>
          <button type="button" className={hit} onClick={() => setMenu((v) => !v)}>
            <MenuGlyph active={menu} size="lg" />
          </button>
          <span className="code text-secondary-foreground">MenuGlyph</span>
          <span className="caption">bars shuffle</span>
        </div>
        <div className={cell}>
          <button type="button" className={hit} onClick={() => setPlus((v) => !v)}>
            <PlusMinusGlyph open={plus} size="lg" />
          </button>
          <span className="code text-secondary-foreground">PlusMinusGlyph</span>
          <span className="caption">plus ↔ minus</span>
        </div>
        <div className={cell}>
          <button
            type="button"
            className={hit}
            onClick={() => {
              setRinging(true);
              setMuted((v) => !v);
            }}
          >
            <BellGlyph
              ringing={ringing}
              muted={muted}
              size="lg"
              onAnimationEnd={() => setRinging(false)}
            />
          </button>
          <span className="code text-secondary-foreground">BellGlyph</span>
          <span className="caption">rings · mute wipes</span>
        </div>
      </div>
    </Section>
  );
}

function StateSection() {
  return (
    <Section
      title="Focus and disabled"
      decision="decision 31"
      note="Tab through the row below: every focusable element draws the same 2px --ring outline on :focus-visible, and nothing draws one on a mouse click. Disabled is opacity-50 plus cursor-not-allowed, everywhere."
    >
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button size="sm">Focusable</Button>
        <Button size="sm" variant="outline">
          Focusable
        </Button>
        <IconButton icon={Settings} label="Settings" size="sm" variant="outline" />
        <Input size="sm" placeholder="Focusable field" className="w-48" />
        <button
          type="button"
          className="focus-ring-none rounded border border-border px-2 py-1 text-xs text-secondary-foreground"
        >
          focus-ring-none (opts out)
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled>
          Disabled
        </Button>
        <Button size="sm" variant="outline" disabled>
          Disabled
        </Button>
        <IconButton icon={Trash2} label="Delete" size="sm" variant="outline" disabled />
        <Input size="sm" placeholder="Disabled field" className="w-48" disabled />
        <span className="disabled-look label">disabled-look (non-control)</span>
      </div>
    </Section>
  );
}

// ── primitives ──────────────────────────────────────────────────────────────

const BUTTON_VARIANTS = [
  "default",
  "destructive",
  "outline",
  "secondary",
  "ghost",
  "link",
] as const;
const BUTTON_SIZES = ["xs", "sm", "md", "lg"] as const;
const BADGE_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "destructive",
  "success",
  "warning",
  "info",
] as const;

function PrimitiveSection() {
  return (
    <>
      <Section
        title="Button"
        decision="decision 32 · src/ui/button.tsx"
        note="Six variants × four sizes, sized on the control heights. Shaped like shadcn's base-style Button so later `shadcn add` output drops in; no `asChild` — it takes Base UI's own `render` prop instead, forwarding to @base-ui/react/button."
      >
        {BUTTON_SIZES.map((size) => (
          <Row key={size} name={`size="${size}"`}>
            <div className="flex flex-wrap items-center gap-2">
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} size={size} variant={variant}>
                  {variant}
                </Button>
              ))}
              <Button size={size} variant="outline">
                <Icon icon={Plus} size="sm" />
                with icon
              </Button>
            </div>
          </Row>
        ))}
        <Row name="render">
          <div className="flex flex-wrap items-center gap-2">
            <Popover>
              <PopoverTrigger
                render={
                  <Button variant="outline" size="sm">
                    Button as a Popover trigger
                  </Button>
                }
              />
              <PopoverContent>
                <PopoverHeader>
                  <PopoverTitle>render composes, not wraps</PopoverTitle>
                  <PopoverDescription>
                    Popover.Trigger clones this Button element and merges its own onClick / aria /
                    ref onto the one &lt;button&gt; Base UI's Button renders — not a button nested
                    inside a button.
                  </PopoverDescription>
                </PopoverHeader>
              </PopoverContent>
            </Popover>
            <span className="caption">
              Same pattern used for real in `src/ui/dialog.tsx`'s close button (below) and
              throughout Popover / DropdownMenu / Dialog in this gallery.
            </span>
          </div>
        </Row>
      </Section>

      <Section
        title="IconButton"
        decision="decision 32 · src/ui/icon-button.tsx"
        note="Square, and its `label` is required — an icon-only control has no visible name. The glyph is one step below the square."
      >
        {BUTTON_SIZES.map((size) => (
          <Row key={size} name={`size="${size}"`}>
            <div className="flex flex-wrap items-center gap-2">
              {(["default", "destructive", "outline", "secondary", "ghost"] as const).map(
                (variant) => (
                  <IconButton
                    key={variant}
                    icon={Settings}
                    label={`${variant} settings`}
                    size={size}
                    variant={variant}
                  />
                ),
              )}
            </div>
          </Row>
        ))}
        <Row name="focusableWhenDisabled">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Hint label="Delete — enabled, for comparison">
                <IconButton icon={Trash2} label="Delete" variant="outline" />
              </Hint>
              <Hint label="Delete — disabled. Native `disabled`, so Tab skips it (Hint wraps it in a span to keep pointer hover working).">
                <IconButton icon={Trash2} label="Delete" variant="outline" disabled />
              </Hint>
              <Hint
                label="Delete — disabled, but focusableWhenDisabled: no native `disabled` attribute, so it stays in the tab order and this hint is reachable by keyboard."
                wrap={false}
              >
                <IconButton
                  icon={Trash2}
                  label="Delete"
                  variant="outline"
                  disabled
                  focusableWhenDisabled
                />
              </Hint>
            </div>
            <span className="caption">
              `focusableWhenDisabled` defaults to false, same as Base UI — most disabled controls in
              Atlas explain nothing and a dead stop in the tab order is worse than skipping them.
              Opt in per call site where, like here, a Hint explains why the control is disabled.
              Tab through the three above: only the third one gets focus.
            </span>
          </div>
        </Row>
      </Section>

      <Section title="Input" decision="decision 32 · src/ui/input.tsx">
        {BUTTON_SIZES.map((size) => (
          <Row key={size} name={`size="${size}"`}>
            <div className="flex flex-wrap items-center gap-2">
              <Input size={size} placeholder="Placeholder" className="w-48" />
              <Input size={size} defaultValue="With a value" className="w-48" />
              <Input size={size} defaultValue="Invalid" aria-invalid className="w-32" />
            </div>
          </Row>
        ))}
      </Section>

      <Section
        title="Badge"
        decision="decision 32 · src/ui/badge.tsx"
        note="Not a control, so not on the control-height scale. Status color comes from the theme's status tokens."
      >
        {(["md", "sm"] as const).map((size) => (
          <Row key={size} name={`size="${size}"`}>
            <div className="flex flex-wrap items-center gap-2">
              {BADGE_VARIANTS.map((variant) => (
                <Badge key={variant} size={size} variant={variant}>
                  {variant}
                </Badge>
              ))}
              <Badge size={size} variant="success">
                <Icon icon={Check} size="xs" />
                with icon
              </Badge>
            </div>
          </Row>
        ))}
      </Section>

      <Section title="Kbd" decision="decision 32 · src/ui/kbd.tsx">
        <Row name={`size="xs"`}>
          <div className="flex items-center gap-3">
            <KbdCombo combo="⌘⇧F" />
            <Kbd>Esc</Kbd>
            <Kbd>⏎</Kbd>
          </div>
        </Row>
        <Row name={`size="sm"`}>
          <div className="flex items-center gap-3">
            <Kbd size="sm">⌘</Kbd>
            <Kbd size="sm">K</Kbd>
          </div>
        </Row>
      </Section>
    </>
  );
}

// ── overlays (decision 16 · the Base UI primitives) ─────────────────────────

const SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * The five Base UI primitives, every variant and state on one page.
 *
 * They are here rather than in `PrimitiveSection` because each one has to be
 * *opened* to be judged: a screenshot of a closed menu says nothing about its
 * entrance, its placement or its focus behaviour. The dialog below deliberately
 * contains a dropdown menu — `z-popover` (200) sits above `z-modal` (110) so a
 * menu inside a dialog escapes it, and this is the one place that ordering is
 * visible without clicking through the real app.
 */
function OverlaySection() {
  const [checked, setChecked] = useState(true);
  const [ctxChecked, setCtxChecked] = useState(false);
  const [density, setDensity] = useState("comfortable");

  return (
    <>
      <Section
        title="Tooltip"
        decision="decision 16 · src/ui/tooltip.tsx"
        note="Timing lives in tooltip-timing.ts, not in Base UI: 300ms before the first one, then instant (and with no entrance) until 300ms has passed with none open. Hover one, then the next, to see the warm path."
      >
        <Row name="Hint">
          <div className="flex flex-wrap items-center gap-2">
            <Hint label="Refresh">
              <IconButton icon={Settings} label="Refresh" />
            </Hint>
            <Hint label="Copy" shortcut={<KbdCombo combo="⌘C" />}>
              <IconButton icon={Copy} label="Copy" />
            </Hint>
            <Hint label="Delete — the control is disabled, so the trigger is a wrapper">
              <IconButton icon={Trash2} label="Delete" disabled />
            </Hint>
          </div>
        </Row>
        <Row name="side">
          <div className="flex flex-wrap items-center gap-2">
            {SIDES.map((side) => (
              <Hint key={side} label={`side="${side}"`} side={side} sideOffset={6}>
                <Button variant="outline" size="sm">
                  {side}
                </Button>
              </Hint>
            ))}
          </div>
        </Row>
        <Row name="composed">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="secondary" size="sm">
                  Tooltip / Trigger / Content
                </Button>
              }
            />
            <TooltipContent side="bottom" sideOffset={6}>
              Rich content, and a <Kbd>⏎</Kbd> inside it
            </TooltipContent>
          </Tooltip>
        </Row>
      </Section>

      <Section
        title="Popover"
        decision="decision 16 · src/ui/popover.tsx"
        note="Portal > Positioner > Popup. side/align/sideOffset/alignOffset are declared on PopoverContent and forwarded to the Positioner — left in ...props they would land on the Popup and positioning would break with no type error."
      >
        <Row name="default">
          <Popover>
            <PopoverTrigger render={<Button variant="outline">Open popover</Button>} />
            <PopoverContent>
              <PopoverHeader>
                <PopoverTitle>Popover title</PopoverTitle>
                <PopoverDescription>
                  Anchored content that is not a list of commands.
                </PopoverDescription>
              </PopoverHeader>
              <div className="flex items-center gap-2 pt-1">
                <Input size="sm" placeholder="Something to type in" />
                <PopoverClose render={<Button size="sm">Done</Button>} />
              </div>
            </PopoverContent>
          </Popover>
        </Row>
        <Row name="side">
          <div className="flex flex-wrap items-center gap-2">
            {SIDES.map((side) => (
              <Popover key={side}>
                <PopoverTrigger
                  render={
                    <Button variant="ghost" size="sm">
                      {side}
                    </Button>
                  }
                />
                <PopoverContent side={side} className="w-56">
                  <PopoverTitle>side=&quot;{side}&quot;</PopoverTitle>
                  <PopoverDescription>
                    It flips when it would leave the viewport.
                  </PopoverDescription>
                </PopoverContent>
              </Popover>
            ))}
          </div>
        </Row>
      </Section>

      <Section
        title="DropdownMenu"
        decision="decision 16 · src/ui/dropdown-menu.tsx"
        note="Base UI has no DropdownMenu — a trigger-anchored menu IS Menu, and the wrapper renames it back. Items take onClick, not onSelect: onSelect stays a valid DOM prop on the div Base UI renders, so it compiles and never fires."
      >
        <Row name="every part">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline">Open menu</Button>} />
            <DropdownMenuContent>
              <DropdownMenuGroup>
                <DropdownMenuLabel>Group label</DropdownMenuLabel>
                <DropdownMenuItem>
                  <Icon icon={Plus} size="sm" />
                  Item with an icon
                  <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem inset>Inset item</DropdownMenuItem>
                <DropdownMenuItem disabled>Disabled item</DropdownMenuItem>
                <DropdownMenuItem variant="destructive">
                  <Icon icon={Trash2} size="sm" />
                  Destructive item
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={checked}
                onCheckedChange={setChecked}
                closeOnClick={false}
              >
                Checkbox item
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup value={density} onValueChange={(v) => setDensity(String(v))}>
                <DropdownMenuRadioItem value="comfortable" closeOnClick={false}>
                  Comfortable
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="compact" closeOnClick={false}>
                  Compact
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Submenu</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem>Nested one</DropdownMenuItem>
                  <DropdownMenuItem>Nested two</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        </Row>
        <Row name="state" value={`checked=${checked} · density=${density}`}>
          <span className="caption">
            Checkbox and radio items keep the menu open: Base UI defaults
            <code className="code"> closeOnClick </code>
            to false on both, where Radix closed on select.
          </span>
        </Row>
      </Section>

      <Section
        title="ContextMenu"
        decision="decision 16 · src/ui/context-menu.tsx"
        note="The same list, opened by right-click at the pointer. The Positioner anchors to the pointer, so it takes no side/align of its own — only the submenu does."
      >
        <Row name="right-click target">
          <ContextMenu>
            <ContextMenuTrigger
              render={
                <div className="flex h-24 w-full max-w-md items-center justify-center rounded-md border border-dashed border-border bg-background">
                  <span className="caption">Right-click anywhere in here</span>
                </div>
              }
            />
            <ContextMenuContent>
              <ContextMenuGroup>
                <ContextMenuLabel>Group label</ContextMenuLabel>
                <ContextMenuItem>
                  <Icon icon={Copy} size="sm" />
                  Copy
                  <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem inset>Inset item</ContextMenuItem>
                <ContextMenuItem disabled>Disabled item</ContextMenuItem>
              </ContextMenuGroup>
              <ContextMenuSeparator />
              <ContextMenuCheckboxItem
                checked={ctxChecked}
                onCheckedChange={setCtxChecked}
                closeOnClick={false}
              >
                Checkbox item
              </ContextMenuCheckboxItem>
              <ContextMenuSeparator />
              <ContextMenuSub>
                <ContextMenuSubTrigger>Submenu</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuItem>Nested one</ContextMenuItem>
                  <ContextMenuItem>Nested two</ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>
            </ContextMenuContent>
          </ContextMenu>
        </Row>
      </Section>

      <Section
        title="Dialog"
        decision="decision 16 · src/ui/dialog.tsx"
        note="A centered modal has no Positioner — the Popup places itself. The scrim is z-overlay (100) and the dialog z-modal (110); the menu inside the second one is z-popover (200), which is why it draws on top instead of behind."
      >
        <Row name="default">
          <div className="flex flex-wrap items-center gap-2">
            <Dialog>
              <DialogTrigger render={<Button>Open dialog</Button>} />
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Dialog title</DialogTitle>
                  <DialogDescription>
                    Escape closes it, focus is trapped inside it, and focus returns to the trigger
                    on close.
                  </DialogDescription>
                </DialogHeader>
                <Input placeholder="First tabbable element — Base UI focuses it on open" />
                <DialogFooter>
                  <DialogClose render={<Button variant="outline">Cancel</Button>} />
                  <DialogClose render={<Button>Save</Button>} />
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog>
              <DialogTrigger render={<Button variant="outline">Dialog with a menu</Button>} />
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Menu inside a dialog</DialogTitle>
                  <DialogDescription>
                    z-popover sits above z-modal on purpose. If this menu ever draws behind the
                    dialog, the layer ordering has regressed.
                  </DialogDescription>
                </DialogHeader>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="secondary">Open menu</Button>} />
                  <DropdownMenuContent>
                    <DropdownMenuItem>
                      <Icon icon={Search} size="sm" />
                      It has to draw on top
                    </DropdownMenuItem>
                    <DropdownMenuItem>
                      <Icon icon={ChevronRight} size="sm" />
                      …and close before the dialog does
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline">Close</Button>} />
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog>
              <DialogTrigger render={<Button variant="ghost">No close button</Button>} />
              <DialogContent showCloseButton={false}>
                <DialogHeader>
                  <DialogTitle>showCloseButton={"{false}"}</DialogTitle>
                  <DialogDescription>Escape and the scrim are the only ways out.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose render={<Button>Done</Button>} />
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </Row>
      </Section>
    </>
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
        <div className="heading">Atlas design system</div>
        <div className="caption">
          Foundations · decisions 17–33 · {THEME_KEY_REGISTRY.length} theme keys
        </div>
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
      <TypeSection />
      <ControlHeightSection />
      <RadiusSection />
      <ElevationSection />
      <ZIndexSection />
      <MotionSection />
      <IconSection />
      <AnimatedIconSection />
      <StateSection />
      <PrimitiveSection />
      <OverlaySection />
      <ColourSections />
    </div>
  );
}
