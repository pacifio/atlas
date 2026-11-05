// Settings → Appearance → Typography: the font pickers' list of installed
// families, `list_font_families`. A plausible Mac: the system families, a few
// popular downloads, and enough of both kinds to scroll and filter. A name the
// browser running the mock doesn't have still lists; it renders in fallback.

import type { FontFamily } from "@/features/settings/lib/fonts-api";
import type { TypedHandlers } from "../types";

const PROPORTIONAL = [
  "American Typewriter",
  "Avenir",
  "Avenir Next",
  "Baskerville",
  "Charter",
  "Futura",
  "Geist",
  "Georgia",
  "Gill Sans",
  "Helvetica",
  "Helvetica Neue",
  "IBM Plex Sans",
  "Inter",
  "Iowan Old Style",
  "Lato",
  "Lucida Grande",
  "New York",
  "Optima",
  "Palatino",
  "SF Pro",
  "SF Pro Rounded",
  "Source Sans 3",
  "Times New Roman",
  "Verdana",
];

const MONOSPACE = [
  "Andale Mono",
  "Berkeley Mono",
  "Cascadia Code",
  "Courier New",
  "Fira Code",
  "Geist Mono",
  "IBM Plex Mono",
  "Iosevka",
  "JetBrains Mono",
  "Menlo",
  "Monaco",
  "SF Mono",
  "Source Code Pro",
];

const FAMILIES: FontFamily[] = [
  ...PROPORTIONAL.map((name) => ({ name, monospace: false })),
  ...MONOSPACE.map((name) => ({ name, monospace: true })),
].sort((a, b) => a.name.localeCompare(b.name));

export interface FontResponses {
  list_font_families: FontFamily[] | null;
}

export const fontHandlers: TypedHandlers<FontResponses> = {
  list_font_families: () => FAMILIES,
};
