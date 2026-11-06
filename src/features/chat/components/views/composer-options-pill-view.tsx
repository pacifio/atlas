import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { Spinner } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import type { AcpConfigOption } from "../../lib/acp-config-options";
import { composerPillClass, composerPillLabelClass } from "../../lib/composer-pill-class";

/**
 * The agent-options pill, drawn from props. `composer-options-pill.tsx` owns
 * the store reads, the cache, the settle backstop and the dropup; this file
 * draws the trigger and what goes inside the dropup.
 *
 * - `loading`: nothing is known about this agent yet (spinner, disabled).
 * - `options`: the agent advertises knobs; the panel lists them.
 * - `default`: it advertises none; the panel says so in one line.
 */

export type ComposerOptionsState = "loading" | "options" | "default";

const TITLE: Record<ComposerOptionsState, string> = {
  loading: "Loading the options this agent offers…",
  options: "Agent options — knobs this agent advertises",
  default: "Agent loaded with default configuration",
};

export function ComposerOptionsTriggerView({
  state,
  open,
  onToggle,
}: {
  state: ComposerOptionsState;
  open: boolean;
  onToggle: () => void;
}) {
  const loading = state === "loading";
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      aria-busy={loading}
      className={composerPillClass(open, { disabled: loading })}
      title={TITLE[state]}
    >
      {/* Updates in place: agent switches are keyboard-driven (⌥/), so the
          content swaps without animation. */}
      <span className="flex items-center">
        {loading ? (
          <Spinner size="xs" label="" />
        ) : (
          <SlidersHorizontal size={11} className="shrink-0 text-muted-foreground" />
        )}
        {/* While loading the label is "Options", not "Default": "Default" is a
            settled answer, and pairing it with a spinner would state a verdict
            we do not have yet. Thanks to the cache this only happens once per
            agent, ever. */}
        <span className={composerPillLabelClass("early")}>
          {state === "default" ? "Default" : "Options"}
        </span>
        {/* Kept in the layout while loading, just invisible: letting it pop in
            would change the pill's width at the same moment as the label and
            nudge the plan pill sideways. */}
        <ChevronDown
          size={10}
          className={cn("ml-0.5 shrink-0 text-muted-foreground", loading && "opacity-0")}
        />
      </span>
    </button>
  );
}

function Row({
  name,
  description,
  active,
  selected,
  onClick,
}: {
  name: string;
  description: string | null;
  active: boolean;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors",
        selected ? "bg-element-selected" : "hover:bg-element-hover",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          {name}
          {active && <Check size={11} className="text-primary" />}
        </span>
        {description && <span className="caption mt-0.5 block">{description}</span>}
      </span>
    </button>
  );
}

export function ComposerOptionsPanelView({
  options,
  onPick,
}: {
  options: AcpConfigOption[];
  /** A pick sets the knob and closes the dropup; booleans pass the new value. */
  onPick: (optionId: string, value: string | boolean) => void;
}) {
  if (options.length === 0) {
    return (
      <div className="px-3 py-2.5">
        <div className="text-xs font-medium text-foreground">Default</div>
        <p className="caption mt-0.5">Agent loaded with default configuration.</p>
      </div>
    );
  }
  return (
    // Capped: the panel is bottom-anchored and grows upward, so an
    // uncapped knob list (an agent may advertise a select with dozens of
    // choices) clips its TOP — the FIRST knob — off-screen.
    <div className="hide-scrollbar max-h-[300px] overflow-y-auto p-1">
      {options.map((opt) =>
        opt.kind === "boolean" ? (
          // The whole row is the one control: a click toggles the knob and
          // closes the dropup. The package `Switch` is itself a control, so it
          // cannot sit inside this button as an indicator; the check stays.
          <Row
            key={opt.id}
            name={opt.name}
            description={opt.description}
            active={opt.value}
            onClick={() => onPick(opt.id, !opt.value)}
          />
        ) : (
          <div key={opt.id}>
            <div className="eyebrow px-2 pt-1.5 pb-0.5">{opt.name}</div>
            {opt.choices.map((c) => {
              const active = c.id === opt.currentValue;
              return (
                <Row
                  key={c.id}
                  name={c.name}
                  description={c.description}
                  active={active}
                  selected={active}
                  onClick={() => onPick(opt.id, c.id)}
                />
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}
