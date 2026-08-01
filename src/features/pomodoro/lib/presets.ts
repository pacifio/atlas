import type { PresetId } from "./pomodoro-types";

export interface Preset {
  id: PresetId;
  label: string;
  sub: string;
  focusMin: number;
  breakMin: number;
}

export const PRESETS: Preset[] = [
  { id: "25-5", label: "Classic", sub: "25 / 5", focusMin: 25, breakMin: 5 },
  { id: "50-10", label: "Deep", sub: "50 / 10", focusMin: 50, breakMin: 10 },
  {
    id: "90-15",
    label: "Ultradian",
    sub: "90 / 15",
    focusMin: 90,
    breakMin: 15,
  },
  {
    id: "custom",
    label: "Custom",
    sub: "pick your own",
    focusMin: 25,
    breakMin: 5,
  },
];

export function presetById(id: PresetId): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
