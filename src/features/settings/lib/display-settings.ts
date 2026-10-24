//! Display settings that apply without a React re-render: fonts, the chat
//! column's width, code wrapping in chats, the diff palette, and the clock
//! (`timeFormat`, handed to `lib/format-time.ts`).
//!
//! Each one is written onto `<html>` as a custom property or a data attribute,
//! and the stylesheets read it (`tokens.css`, `globals.css`). Nothing here
//! re-renders React, so a change recolours or reflows at once, and every
//! surface that styles itself through those rules follows without being told.
//! The terminal's xterm (the alt screen) is the exception: it takes its font
//! as a number, so it subscribes to the settings store itself
//! (`terminal-session.ts`).

import { setTimeFormat } from "@/lib/format-time";
import type { AppSettings } from "./app-settings";

export type DisplaySettings = Pick<
  AppSettings,
  | "uiFontFamily"
  | "codeFontFamily"
  | "composerFontFamily"
  | "terminalFontFamily"
  | "editorFontSize"
  | "terminalFontSize"
  | "chatWidth"
  | "wordWrap"
  | "diffPalette"
  | "timeFormat"
>;

/** Set a custom property and its flag attribute, or remove both so every
 *  stylesheet fallback applies. */
function setFont(root: HTMLElement, name: string, flag: string, value: string): void {
  if (value.trim()) {
    root.style.setProperty(name, value.trim());
    root.setAttribute(flag, "");
  } else {
    root.style.removeProperty(name);
    root.removeAttribute(flag);
  }
}

export function applyDisplaySettings(settings: DisplaySettings, root = document.documentElement) {
  // Unset when empty, so every site keeps the font chain it has always had.
  setFont(root, "--atlas-ui-font", "data-ui-font", settings.uiFontFamily);
  setFont(root, "--atlas-code-font", "data-code-font", settings.codeFontFamily);
  setFont(root, "--atlas-composer-font", "data-composer-font", settings.composerFontFamily);
  setFont(root, "--atlas-terminal-font", "data-terminal-font", settings.terminalFontFamily);
  root.style.setProperty("--atlas-editor-font-size", `${settings.editorFontSize}px`);
  root.style.setProperty("--atlas-terminal-font-size", `${settings.terminalFontSize}px`);
  root.dataset.chatWidth = settings.chatWidth;
  root.dataset.wordWrap = settings.wordWrap ? "on" : "off";
  root.dataset.diffPalette = settings.diffPalette;
  setTimeFormat(settings.timeFormat);
  window.dispatchEvent(new CustomEvent(DISPLAY_SETTINGS_APPLIED));
}

/** Fired on `window` after every apply, for what can't read CSS (xterm). */
export const DISPLAY_SETTINGS_APPLIED = "atlas:display-settings-applied";

/** The applied terminal font size, in pixels, read back off `<html>`. */
export function appliedTerminalFontSize(root = document.documentElement): number {
  const px = Number.parseFloat(root.style.getPropertyValue("--atlas-terminal-font-size"));
  return Number.isFinite(px) && px > 0 ? px : 13;
}

/** The terminal's applied font family: its own, else the code font's, else
 *  the theme's mono stack — the same chain `font-terminal` resolves in CSS,
 *  so xterm (which takes a family string, not a stylesheet) draws in the font
 *  the rest of the terminal does. */
export function appliedTerminalFont(root = document.documentElement): string {
  return (
    root.style.getPropertyValue("--atlas-terminal-font").trim() ||
    root.style.getPropertyValue("--atlas-code-font").trim() ||
    getComputedStyle(root).getPropertyValue("--font-mono").trim()
  );
}

export function displaySettingsChanged(next: AppSettings, previous: AppSettings): boolean {
  return (
    next.uiFontFamily !== previous.uiFontFamily ||
    next.codeFontFamily !== previous.codeFontFamily ||
    next.composerFontFamily !== previous.composerFontFamily ||
    next.terminalFontFamily !== previous.terminalFontFamily ||
    next.editorFontSize !== previous.editorFontSize ||
    next.terminalFontSize !== previous.terminalFontSize ||
    next.chatWidth !== previous.chatWidth ||
    next.wordWrap !== previous.wordWrap ||
    next.diffPalette !== previous.diffPalette ||
    next.timeFormat !== previous.timeFormat
  );
}
