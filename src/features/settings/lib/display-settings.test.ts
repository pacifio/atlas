// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { timeFormat, setTimeFormat } from "@/lib/format-time";
import { DEFAULT_SETTINGS } from "./app-settings";
import {
  appliedTerminalFont,
  appliedTerminalFontSize,
  applyDisplaySettings,
  displaySettingsChanged,
} from "./display-settings";

const root = document.documentElement;

afterEach(() => {
  root.removeAttribute("style");
  setTimeFormat("system");
});

describe("applyDisplaySettings", () => {
  it("writes the defaults without setting either font, so every fallback applies", () => {
    applyDisplaySettings(DEFAULT_SETTINGS);
    expect(root.style.getPropertyValue("--atlas-ui-font")).toBe("");
    expect(root.style.getPropertyValue("--atlas-code-font")).toBe("");
    expect(root.style.getPropertyValue("--atlas-editor-font-size")).toBe("13px");
    expect(root.dataset.chatWidth).toBe("normal");
    expect(root.dataset.wordWrap).toBe("on");
    expect(root.dataset.diffPalette).toBe("theme");
  });

  it("applies the user's choices, and clears a font set back to empty", () => {
    applyDisplaySettings({
      ...DEFAULT_SETTINGS,
      codeFontFamily: "JetBrains Mono",
      terminalFontSize: 15,
      chatWidth: "full",
      wordWrap: false,
      diffPalette: "blue-orange",
      timeFormat: "24h",
    });
    // The terminal follows the code font until it has its own.
    expect(appliedTerminalFont()).toBe("JetBrains Mono");
    expect(appliedTerminalFontSize()).toBe(15);
    expect(root.dataset.chatWidth).toBe("full");
    expect(root.dataset.wordWrap).toBe("off");
    expect(root.dataset.diffPalette).toBe("blue-orange");
    expect(timeFormat()).toBe("24h");

    applyDisplaySettings({
      ...DEFAULT_SETTINGS,
      codeFontFamily: "Menlo",
      terminalFontFamily: "Iosevka",
    });
    expect(appliedTerminalFont()).toBe("Iosevka");

    applyDisplaySettings(DEFAULT_SETTINGS);
    expect(appliedTerminalFont()).toBe("");
  });
});

describe("displaySettingsChanged", () => {
  it("ignores settings it does not apply", () => {
    expect(
      displaySettingsChanged({ ...DEFAULT_SETTINGS, enterToSend: false }, DEFAULT_SETTINGS),
    ).toBe(false);
    expect(
      displaySettingsChanged({ ...DEFAULT_SETTINGS, chatWidth: "wide" }, DEFAULT_SETTINGS),
    ).toBe(true);
  });
});
