import { Cpu } from "lucide-react";
import { AgentIcons } from "@/components/agent-icons";
import {
  modelVendorColor,
  modelVendorOf,
  type ModelVendor,
} from "@/features/agents/lib/agent-brand";
import { cn } from "@/lib/utils";

/**
 * A model's vendor, as a mark: the vendor's agent glyph where Atlas has one
 * (Claude, Codex, Cursor, Kilo), a dot in the vendor's hue where it does not
 * (Gemini, the open-weights family), and a neutral chip glyph for a model
 * nobody recognises.
 *
 * The hues are the constants in `agent-brand.ts`, not theme keys, so nothing
 * here reads a resolved colour and no theme subscription is needed.
 */

const GLYPH: Partial<Record<ModelVendor, typeof AgentIcons.Claude>> = {
  claude: AgentIcons.Claude,
  codex: AgentIcons.Codex,
  cursor: AgentIcons.Cursor,
  kilo: AgentIcons.Kilo,
};

export function ModelVendorMark({ model, className }: { model: string; className?: string }) {
  const vendor = modelVendorOf(model);
  const Glyph = vendor ? GLYPH[vendor] : undefined;
  return (
    <span
      aria-hidden
      data-vendor={vendor ?? "unknown"}
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
    >
      {vendor === null ? (
        <Cpu className="size-3 text-muted-foreground" />
      ) : Glyph ? (
        <Glyph className="size-3" title="" style={{ color: modelVendorColor(vendor) }} />
      ) : (
        <span className="size-1.5 rounded-full" style={{ background: modelVendorColor(vendor) }} />
      )}
    </span>
  );
}

/**
 * A model name in its vendor's tint: the mark, then the name. A known vendor
 * wears its hue at a tenth for the fill (the usage tables' tint); an unknown
 * model falls back to the themeable `agent.chip.background` under muted text.
 */
export function ModelChip({
  model,
  label,
  className,
}: {
  model: string;
  label: string;
  className?: string;
}) {
  const vendor = modelVendorOf(model);
  const hue = vendor ? modelVendorColor(vendor) : null;
  return (
    <span
      data-slot="model-chip"
      className={cn(
        "inline-flex h-control-xs max-w-full items-center gap-1 rounded-full px-1.5 text-2xs font-medium",
        hue === null && "bg-(--agent-chip-background) text-muted-foreground",
        className,
      )}
      style={
        hue === null
          ? undefined
          : { color: hue, background: `color-mix(in oklab, ${hue} 10%, transparent)` }
      }
    >
      <ModelVendorMark model={model} />
      <span className="truncate">{label}</span>
    </span>
  );
}
