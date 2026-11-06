/**
 * The built-in themes as Rust serialises them, typed once.
 *
 * `builtin-themes.json` is written by `cargo run -p atlas-theme --example
 * generate_builtins`. A JSON import's inferred type is the union of its
 * objects, and TypeScript widens a key only some themes set to `?: undefined`
 * on the rest, which no `Record<string, …>` accepts. So the cast goes through
 * `unknown` here, and every reader imports this instead of the JSON.
 */
import json from "./builtin-themes.json";
import type { Theme } from "@tryatlas/design/theme";

export const BUILTIN_THEMES = json as unknown as Theme[];
