// Recharts theming for the AMOLED-black Mission Control dashboard. Recharts
// takes color PROPS (not CSS classes), so we expose concrete hex values that
// match the design tokens + a deterministic per-project palette.

export const CHART = {
  grid: "rgba(255,255,255,0.06)",
  axis: "#777777", // --text-tertiary
  tickFont: 11,
  tooltipBg: "#0f0f0f", // --bg-elevated
  tooltipBorder: "#1e1e1e", // --border-default
} as const;

// Muted, desaturated tones that sit quietly on Atlas's AMOLED-black monochrome
// theme (NO bright orange / saturated hues). Faint hue separation only.
export const AGENT_COLOR = {
  // One colour for every Atlas agent: the dashboard folds them into one
  // series rather than growing a column per agent (issue #17).
  agents: "#b9b1a6", // warm gray
  gpt: "#93a3ad", // muted slate
  gemini: "#9aa6c0", // muted periwinkle-gray
  byok: "#a89fb0", // muted mauve-gray
  input: "#c9c9cf", // light gray
  output: "#7f8088", // mid gray
} as const;

// Per-project palette: low-saturation grays with a whisper of hue so adjacent
// projects stay distinguishable without breaking the monochrome feel. Cycles.
const PROJECT_PALETTE = [
  "#cfcfd4", // light gray
  "#9aa3ad", // slate
  "#a8b0a3", // sage-gray
  "#b3aa9e", // warm gray
  "#a39fb0", // mauve-gray
  "#8f96a0", // cool gray
  "#bdb6ab", // sand-gray
  "#9bb0aa", // muted teal-gray
  "#b0a6b3", // dusty lilac-gray
  "#878d92", // graphite
] as const;

export function projectColor(index: number): string {
  return PROJECT_PALETTE[index % PROJECT_PALETTE.length];
}

/** Build a stable path→color map preserving project order. */
export function projectColorMap(paths: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  paths.forEach((p, i) => {
    map[p] = projectColor(i);
  });
  return map;
}
