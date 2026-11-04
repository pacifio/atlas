/**
 * Four fonts, each with a sample of where it shows: the interface, the
 * composer, code, and the terminal. The composer follows the interface font
 * and the terminal the code font until each is given its own.
 *
 * The samples read the same custom properties the app does
 * (`display-settings.ts`), so each one changes the moment its setting saves,
 * and is the font you will actually get — fallbacks included.
 *
 * A picker left on its default follows the active theme's font when the theme
 * names one (a tweakcn import usually does), else Atlas's own; the default
 * item says which, so "Default" never hides where a font came from.
 */

import { Select } from "@/ui/select";
import { appearanceForMode } from "@/features/theme/apply-theme";
import { themeIdFor, useThemeStore } from "@/features/theme/stores/theme-store";
import { useSettingsStore } from "../../stores/settings-store";
import { parseFontValue } from "../../lib/fonts-api";
import type { AppSettings } from "../../lib/app-settings";
import { settingMeta } from "../../lib/settings-sections";
import { useScopedSetting } from "../../lib/use-scoped-setting";
import { SettingsGroup, SettingsRow, SettingsSection } from "../layout/settings-layout";
import { FontPicker } from "./font-picker";

/** Atlas's own defaults, for when neither the setting nor the theme names a
 *  font: Geist and Geist Mono, which `@tryatlas/design` bundles (its
 *  `tokens.css`), so they render offline on every platform. */
const DEFAULT_SANS = '"Geist Variable", -apple-system, system-ui, sans-serif';
const DEFAULT_MONO =
  '"Geist Mono Variable", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
// What the app renders with: setting, then theme, then default (`globals.css`).
const UI_FONT = "var(--font-sans)";
const COMPOSER_FONT = `var(--atlas-composer-font, ${UI_FONT})`;
const CODE_FONT = "var(--font-mono)";
const TERMINAL_FONT = `var(--atlas-terminal-font, ${CODE_FONT})`;

type ThemeFontToken = "font-sans" | "font-mono";

/** The active theme's own font stack for `token`, if it names one. */
function useThemeFont(token: ThemeFontToken): string | undefined {
  const themeMode = useSettingsStore((s) => s.settings.themeMode);
  const light = useSettingsStore((s) => s.settings.themeLight);
  const dark = useSettingsStore((s) => s.settings.themeDark);
  const theme = useThemeStore((s) => s.loaded[themeIdFor({ light, dark }, themeMode)]);
  if (!theme) return undefined;
  // A one-variant theme answers both appearances, as `resolveTheme` does.
  const variant =
    appearanceForMode(themeMode) === "light"
      ? (theme.light ?? theme.dark)
      : (theme.dark ?? theme.light);
  return variant?.base[token]?.trim() || undefined;
}

/** The default item for a font that can come from the theme. */
function useDefaultFont(token: ThemeFontToken, ownLabel: string, ownFamily: string) {
  const stack = useThemeFont(token);
  if (!stack) return { label: ownLabel, family: ownFamily, themeFamily: undefined };
  const parsed = parseFontValue(stack);
  const first =
    parsed.kind === "family" ? parsed.family : parsed.kind === "list" ? parsed.families[0] : "";
  return {
    label: `From theme: ${first || stack}`,
    family: `${stack}, ${ownFamily}`,
    themeFamily: first || undefined,
  };
}

type FontKey = "uiFontFamily" | "composerFontFamily" | "codeFontFamily" | "terminalFontFamily";
type SizeKey = "editorFontSize" | "terminalFontSize";

export function TypographySection() {
  return (
    <SettingsSection title="Typography">
      <SettingsGroup>
        <SettingsRow
          setting="uiFontFamily"
          control={
            <FontControl
              setting="uiFontFamily"
              themeToken="font-sans"
              defaultLabel="Geist"
              fallback={DEFAULT_SANS}
            />
          }
        >
          <Sample font={UI_FONT}>
            <p className="text-sm text-foreground">Review the open pull requests</p>
            <p className="text-xs text-muted-foreground">
              Three need you · the build on main passed 4 minutes ago
            </p>
          </Sample>
        </SettingsRow>

        <SettingsRow
          setting="composerFontFamily"
          control={
            <FontControl
              setting="composerFontFamily"
              defaultLabel="Same as interface"
              fallback={UI_FONT}
            />
          }
        >
          <Sample font={COMPOSER_FONT}>
            <p className="text-sm text-foreground">
              Fix the flaky test in <span className="text-primary">@auth.test.ts</span> and tell me
              what was racing.
            </p>
          </Sample>
        </SettingsRow>

        <SettingsRow
          setting="codeFontFamily"
          control={
            <FontControl
              setting="codeFontFamily"
              size="editorFontSize"
              themeToken="font-mono"
              defaultLabel="Geist Mono"
              fallback={DEFAULT_MONO}
              monospace
            />
          }
        >
          <CodeSample />
        </SettingsRow>

        <SettingsRow
          setting="terminalFontFamily"
          control={
            <FontControl
              setting="terminalFontFamily"
              size="terminalFontSize"
              defaultLabel="Same as code"
              fallback={CODE_FONT}
              monospace
            />
          }
        >
          <TerminalSample />
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}

function FontControl({
  setting,
  size,
  themeToken,
  defaultLabel,
  fallback,
  monospace,
}: {
  setting: FontKey;
  size?: SizeKey;
  /** The theme font this setting's default follows; none for the two that
   *  follow another setting instead. */
  themeToken?: ThemeFontToken;
  defaultLabel: string;
  fallback: string;
  monospace?: boolean;
}) {
  const scoped = useScopedSetting(setting);
  const fromTheme = useDefaultFont(themeToken ?? "font-sans", defaultLabel, fallback);
  const shown = themeToken
    ? fromTheme
    : { label: defaultLabel, family: fallback, themeFamily: undefined };
  return (
    <>
      <FontPicker
        value={scoped.value as string}
        onChange={(next) => scoped.set(next as AppSettings[FontKey])}
        defaultLabel={shown.label}
        defaultFamily={shown.family}
        themeFamily={shown.themeFamily}
        monospace={monospace}
        label={settingMeta(setting).title}
      />
      {size && <SizeSelect setting={size} />}
    </>
  );
}

/** Font size in pixels, as a short list rather than a stepper: it sits beside
 *  a font picker, the way a type menu pairs the two. */
function SizeSelect({ setting }: { setting: SizeKey }) {
  const scoped = useScopedSetting(setting);
  const { min = 8, max = 32 } = settingMeta(setting);
  const options = Array.from({ length: max - min + 1 }, (_, i) => {
    const px = String(min + i);
    return { value: px, label: `${px} px` };
  });
  return (
    <Select
      value={String(scoped.value)}
      options={options}
      aria-label={settingMeta(setting).title}
      onValueChange={(next) => scoped.set(Number(next))}
      className="w-20"
    />
  );
}

function Sample({ font, children }: { font: string; children: React.ReactNode }) {
  return (
    <div
      aria-hidden
      className="flex flex-col gap-0.5 rounded-md border border-border-subtle bg-background px-3 py-2.5"
      style={{ fontFamily: font }}
    >
      {children}
    </div>
  );
}

function CodeSample() {
  const editorFontSize = useScopedSetting("editorFontSize").value as number;
  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-md border border-border-subtle"
      style={{
        fontFamily: CODE_FONT,
        fontSize: editorFontSize, // ratchet-allow: the sample IS the editor size setting, previewed at its value
        backgroundColor: "var(--editor-background)",
        color: "var(--editor-foreground)",
        lineHeight: 1.6,
      }}
    >
      <pre className="px-3 py-2.5">
        <span style={{ color: "var(--syntax-keyword)" }}>export function</span>{" "}
        <span style={{ color: "var(--syntax-function)" }}>formatUser</span>(user: User) {"{"}
        {"\n"}
        {"  "}
        <span style={{ color: "var(--syntax-keyword)" }}>return</span>{" "}
        <span style={{ color: "var(--syntax-string)" }}>{"`${user.name} <${user.email}>`"}</span>;
        {"\n"}
        {"}"} <span style={{ color: "var(--syntax-comment)" }}>{"// 0O 1lI {}[] => !== ->"}</span>
      </pre>
    </div>
  );
}

function TerminalSample() {
  const terminalFontSize = useScopedSetting("terminalFontSize").value as number;
  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-md border border-border-subtle"
      style={{
        fontFamily: TERMINAL_FONT,
        fontSize: terminalFontSize, // ratchet-allow: the sample IS the terminal size setting, previewed at its value
        backgroundColor: "var(--terminal-background)",
        color: "var(--terminal-foreground)",
        lineHeight: 1.5,
      }}
    >
      <pre className="px-3 py-2.5">
        <span style={{ color: "var(--terminal-ansi-green)" }}>~/atlas</span>{" "}
        <span style={{ color: "var(--terminal-ansi-blue)" }}>main</span> ❯ bun test
        {"\n"}
        <span style={{ color: "var(--terminal-ansi-green)" }}>✓</span> 412 passed{"  "}
        <span style={{ color: "var(--terminal-ansi-yellow)" }}>2 skipped</span>
        {"  "}
        <span style={{ color: "var(--terminal-ansi-red)" }}>0 failed</span>
      </pre>
    </div>
  );
}
