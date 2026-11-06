/**
 * Types for `generate-theme-keys.mjs`, which is plain Node ESM so it can run
 * with no build step. Only the surface `tests/theme-key-registry.test.ts`
 * imports is declared.
 */

/** One `[[key]]` entry of `keys.toml` (desktop's copy, `crates/atlas-theme/keys.toml`). */
export interface ThemeKeySource {
  name: string;
  group: string;
  description: string;
  /** First derivation source: one of the eight palette hues. */
  palette?: string;
  /** Second derivation source: a shadcn base token. */
  base?: string;
  /** `alpha` | `lighten` | `toward_background`; absent for a plain alias. */
  op?: string;
  /** The operation's parameter, kept as the source lexeme. */
  amount?: string;
  dark: string;
  light: string;
  note?: string;
}

/** One `[[derived]]` entry: a colour Atlas writes but no theme may set. */
export interface DerivedVarSource {
  name: string;
  description: string;
  /** The settable key this transforms; absent when `base` is set. */
  from?: string;
  /** The shadcn base token this transforms; absent when `from` is set. */
  base?: string;
  op: string;
  amount: string;
}

export interface ThemeKeyGroup {
  name: string;
  description: string;
}

export const OUTPUTS: {
  keyList: string;
  baseRules: string;
  schema: string;
  docs: string;
  builtins: string;
};

/** The installed `@tryatlas/design`'s root directory. */
export function packageRoot(): string;

/** Every file copied from the package, as `[from, to]` (package-relative, repo-relative). */
export function packageCopies(): [string, string][];

/** Committed theme files the package no longer ships. */
export function strayThemes(): string[];

/** Parses and validates the source; throws with every problem it found. */
export function readSource(): {
  groups: ThemeKeyGroup[];
  keys: ThemeKeySource[];
  derived: DerivedVarSource[];
};

/** The generated files that no longer match the source. */
export function staleOutputs(): { path: string; hint: string }[];

export function cssVar(name: string): string;

/** The one-line hover text carried into `theme-keys.txt` and the schema. */
export function keyDescription(key: ThemeKeySource): string;
