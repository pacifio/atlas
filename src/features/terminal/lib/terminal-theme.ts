/**
 * The terminal palette, from the active theme.
 *
 * Two renderers draw terminal output and they must agree, because a block
 * scrolls off into history while the alt screen is live:
 *
 *  - the BLOCK renderer (`line-emulator.ts`) emits React inline styles, so it
 *    can name `var(--terminal-ansi-red)` and recolour with no work at
 *    all when the applier rewrites `:root`;
 *  - the alt-screen SURFACE is xterm, whose `ITheme` is 19 concrete strings
 *    handed to a WebGL renderer — a `var()` would arrive as literal text.
 *
 * So this module is the xterm half: resolved values (decision 14) plus an
 * `applyTerminalTheme` that pushes a new palette into a terminal that already
 * exists. `terminal-session.ts` subscribes every live xterm to
 * `atlas:theme-applied`, so switching theme recolours the running vim rather
 * than the next one.
 */
import type { ITheme } from "@xterm/xterm";
import { withAlpha } from "@/features/theme/color";
import { alphaOf, themeColor, themeDerived } from "@/features/theme/theme-values";

/** Build an xterm `ITheme` from the active theme's `terminal.*` keys. */
export function terminalTheme(): ITheme {
  const selection = themeDerived("terminal.selection");
  return {
    background: themeColor("terminal.background"),
    foreground: themeColor("terminal.foreground"),
    cursor: themeColor("terminal.cursor"),
    // The glyph UNDER a block cursor. The terminal background is the only
    // value guaranteed to contrast with the cursor itself.
    cursorAccent: themeColor("terminal.background"),
    selectionBackground: selection,
    // Same tint, weaker, for a selection the terminal no longer owns — xterm
    // falls back to a hardcoded grey when this is absent.
    selectionInactiveBackground: withAlpha(selection, alphaOf(selection) * 0.5),
    black: themeColor("terminal.ansi.black"),
    red: themeColor("terminal.ansi.red"),
    green: themeColor("terminal.ansi.green"),
    yellow: themeColor("terminal.ansi.yellow"),
    blue: themeColor("terminal.ansi.blue"),
    magenta: themeColor("terminal.ansi.magenta"),
    cyan: themeColor("terminal.ansi.cyan"),
    white: themeColor("terminal.ansi.white"),
    brightBlack: themeColor("terminal.ansi.bright_black"),
    brightRed: themeColor("terminal.ansi.bright_red"),
    brightGreen: themeColor("terminal.ansi.bright_green"),
    brightYellow: themeColor("terminal.ansi.bright_yellow"),
    brightBlue: themeColor("terminal.ansi.bright_blue"),
    brightMagenta: themeColor("terminal.ansi.bright_magenta"),
    brightCyan: themeColor("terminal.ansi.bright_cyan"),
    brightWhite: themeColor("terminal.ansi.bright_white"),
  };
}
