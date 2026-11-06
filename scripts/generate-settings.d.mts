/**
 * Types for `generate-settings.mjs`, which is plain Node ESM so it can run
 * with no build step. Only the surface `tests/settings-registry.test.ts`
 * imports is declared.
 */

/** A numeric value kept as its source lexeme, so `1.0` stays `1.0`. */
export interface NumberLexeme {
  number: string;
}

/** One `[[setting]]` entry of `src-tauri/settings-registry.toml`. */
export interface SettingSource {
  key: string;
  type: string;
  status: string;
  page: string;
  section: string;
  title: string;
  summary: string;
  doc: string;
  validation: string;
  default?: boolean | string | string[] | NumberLexeme;
  values?: string[];
  min?: NumberLexeme;
  max?: NumberLexeme;
  platforms?: string[];
  applies?: string;
  set_in?: string;
  ts_type?: string;
  ts_import?: string;
  ts_default?: string;
}

/** One `[[page]]` entry. */
export interface PageSource {
  id: string;
  title: string;
  description: string;
}

export interface RegistrySource {
  pages: PageSource[];
  settings: SettingSource[];
}

export interface RenderedOutput {
  path: string;
  content: string;
}

export const OUTPUTS: {
  rust: string;
  registry: string;
  json: string;
  docs: string;
};
export const TYPES: string[];
export const STATUSES: string[];
export function readSource(text?: string): RegistrySource;
export function renderAll(source?: RegistrySource): RenderedOutput[];
export function staleOutputs(source?: RegistrySource): RenderedOutput[];
export function tomlLiteral(setting: SettingSource): string | null;
export function configComment(setting: SettingSource): string;
