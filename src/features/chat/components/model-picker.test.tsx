// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ModelPicker, searchScore, type PickerAgent } from "./model-picker";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import type { SessionModeInfo } from "@/types/agents";
import { isMac } from "@/lib/platform";
import { displayLabel, parseCombo } from "@/features/keybindings/lib/combo";

// The settings store subscribes to `config.toml` changes over Tauri events at
// import; there is no Tauri here.
vi.mock("@/features/settings/lib/atlas-config-api", () => ({
  updateSettings: vi.fn(),
  resetConfig: vi.fn(),
  onConfigChanged: () => Promise.resolve(() => {}),
  onConfigError: () => Promise.resolve(() => {}),
}));

const NATIVE_MODELS: SessionModeInfo[] = [
  { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic", is_new: true },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
  { id: "claude-3-7", name: "Claude Sonnet 3.7", provider: "anthropic", legacy: true },
  { id: "claude-3-5", name: "Claude Haiku 3.5", provider: "anthropic", legacy: true },
  { id: "gpt-5", name: "GPT-5", provider: "openai", description: "Strong at refactors" },
];

const CLAUDE_MODELS: SessionModeInfo[] = [
  { id: "default", name: "Default", description: "Recommended for most work" },
  { id: "opus", name: "Opus 5.5" },
];

const agentsWith = (native = NATIVE_MODELS, claude = CLAUDE_MODELS): PickerAgent[] => [
  { agentType: "atlas-agent", label: "Atlas Agent", models: native },
  { agentType: "claude-code", label: "Claude Code", models: claude },
  { agentType: "codex", label: "Codex", models: [] },
];

/** Settings writes go to `config.toml` through Rust; here they land in the
 *  store directly, which is all the picker reads. */
function stubSettingsWrites(favoriteModels: string[] = []) {
  useSettingsStore.setState((s) => ({
    settings: { ...s.settings, favoriteModels },
    actions: {
      ...s.actions,
      updateSettings: (patch) =>
        useSettingsStore.setState((st) => ({ settings: { ...st.settings, ...patch } })),
    },
  }));
}

type OnPick = (agentType: string, modelId: string | null) => void;

function picker(onPick: OnPick, currentModel: string, agents: PickerAgent[], addView?: string) {
  return (
    <ModelPicker
      agents={agents}
      currentAgent="atlas-agent"
      currentModel={currentModel}
      onPick={onPick}
      addView={addView}
    />
  );
}

function renderPicker(
  onPick = vi.fn<OnPick>(),
  currentModel = "claude-sonnet-4",
  agents = agentsWith(),
  addView?: string,
) {
  const r = render(picker(onPick, currentModel, agents, addView));
  return {
    onPick,
    rerender: (a: PickerAgent[], cur = currentModel) => r.rerender(picker(onPick, cur, a)),
  };
}

const input = () => screen.getByRole("combobox");
const rows = () =>
  screen.queryAllByRole("option").map((o) => o.querySelector(".label")?.textContent);
/** The row the combobox points at — what Enter would pick. */
const highlighted = () => {
  const id = input().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.querySelector(".label")?.textContent : null;
};
const railButtons = () =>
  within(screen.getByRole("toolbar", { name: "Agents" })).getAllByRole("button");
const pressed = () =>
  railButtons()
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.getAttribute("aria-label"));
const key = (k: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(document.activeElement ?? input(), { key: k, code: k, ...init });
/** A `cmd+…` chord as this platform types it. */
const chord = (k: string, code: string, shift = false) =>
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: k,
    code,
    shiftKey: shift,
    metaKey: isMac,
    ctrlKey: !isMac,
  });
const jump = (n: number) => chord(String(n), `Digit${n}`);
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const headings = () =>
  Array.from(screen.getByRole("listbox").querySelectorAll(":scope > [role=presentation]"))
    .filter((el) => !el.querySelector("[role=option]"))
    .map((el) => el.querySelector("span.truncate")?.textContent);
/** Each row's caption line, as read (marks carry their own <title>). */
const captions = () =>
  screen.queryAllByRole("option").map((o) =>
    Array.from(o.querySelectorAll(".caption > span"))
      .map((s) => s.textContent)
      .join(""),
  );

describe("ModelPicker", () => {
  beforeEach(() => stubSettingsWrites());
  afterEach(cleanup);

  it("builds the rail from the agents, marks the current one, and opens on it", () => {
    renderPicker();
    expect(railButtons().map((t) => t.getAttribute("aria-label"))).toEqual([
      "Pinned",
      "Atlas Agent (current)",
      "Claude Code",
      "Codex",
    ]);
    expect(pressed()).toEqual(["Atlas Agent (current)"]);
  });

  it("heads the agent's models by provider only when it stated more than one", () => {
    renderPicker();
    expect(headings()).toEqual(["Claude", "OpenAI"]);
    expect(rows()).toEqual(["Claude Opus 5", "Claude Sonnet 4", "GPT-5", "Legacy models"]);
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(headings()).toEqual([]);
    expect(rows()).toEqual(["Default", "Opus 5.5"]);
  });

  it("shows a model's description under its name, and no repeated agent caption", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(captions()).toEqual(["Recommended for most work", ""]);
  });

  describe("across agents", () => {
    it("picks another agent's model with its agent", () => {
      const { onPick } = renderPicker();
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
      fireEvent.click(screen.getByText("Opus 5.5"));
      expect(onPick).toHaveBeenCalledWith("claude-code", "opus");
    });

    it("offers a switch for an agent with no models yet, by button and by Enter", () => {
      const { onPick } = renderPicker();
      fireEvent.click(screen.getByRole("button", { name: "Codex" }));
      expect(rows()).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: /Switch to Codex/ }));
      expect(onPick).toHaveBeenLastCalledWith("codex", null);
      onPick.mockClear();
      act(() => input().focus());
      key("Enter");
      expect(onPick).toHaveBeenCalledWith("codex", null);
    });

    it("checks the current model only on the current agent", () => {
      renderPicker(vi.fn(), "default", agentsWith([{ id: "default", name: "Default" }]));
      expect(screen.getAllByLabelText("Current")).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
      expect(screen.queryAllByLabelText("Current")).toHaveLength(0);
    });

    it("renders the add view from the rail's trailing entry", () => {
      renderPicker(vi.fn(), "claude-sonnet-4", agentsWith(), "Install more");
      fireEvent.click(screen.getByRole("button", { name: "Add agents" }));
      expect(screen.getByText("Install more")).toBeTruthy();
    });
  });

  describe("favorites", () => {
    it("pins an agent's starred models on top of its view", () => {
      stubSettingsWrites(["atlas-agent:gpt-5"]);
      renderPicker();
      // One provider left: not headed by it, but set apart from the pinned.
      expect(headings()).toEqual(["Pinned", "All models"]);
      expect(rows()[0]).toBe("GPT-5");
    });

    it("lists every agent's favorites, headed by agent", () => {
      stubSettingsWrites(["claude-code:opus", "atlas-agent:gpt-5"]);
      const { onPick } = renderPicker();
      fireEvent.click(screen.getByRole("button", { name: "Pinned" }));
      expect(headings()).toEqual(["Atlas Agent", "Claude Code"]);
      expect(rows()).toEqual(["GPT-5", "Opus 5.5"]);
      jump(2);
      expect(onPick).toHaveBeenCalledWith("claude-code", "opus");
    });

    it("stars into settings with the agent in the key", () => {
      renderPicker();
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
      fireEvent.mouseMove(screen.getAllByRole("option")[1]!.parentElement!);
      fireEvent.click(screen.getByRole("button", { name: "Pin" }));
      expect(useSettingsStore.getState().settings.favoriteModels).toEqual(["claude-code:opus"]);
    });

    it("says so when the favorites view is empty", () => {
      renderPicker();
      fireEvent.click(screen.getByRole("button", { name: "Pinned" }));
      expect(screen.getByText("Nothing pinned yet")).toBeTruthy();
    });
  });

  describe("accessibility", () => {
    it("is a list-autocomplete combobox pointing at the highlighted option", () => {
      renderPicker();
      expect(input().getAttribute("aria-autocomplete")).toBe("list");
      expect(input().getAttribute("aria-expanded")).toBe("true");
      const listbox = screen.getByRole("listbox");
      expect(input().getAttribute("aria-controls")).toBe(listbox.id);
      expect(highlighted()).toBe("Claude Sonnet 4");
    });

    it("nests nothing interactive inside an option", () => {
      renderPicker();
      for (const option of screen.getAllByRole("option")) {
        expect(option.querySelector("button, a, input, [tabindex]")).toBeNull();
      }
      // The highlighted row's star is still a real button, beside its option.
      expect(screen.getAllByRole("button", { name: "Pin" })).toHaveLength(1);
    });

    it("renders the rail as pressed toggle buttons, not tabs without panels", () => {
      renderPicker();
      expect(screen.queryByRole("tab")).toBeNull();
      expect(screen.queryByRole("tablist")).toBeNull();
    });

    it("collapses aria-expanded and drops the active descendant when nothing matches", () => {
      renderPicker();
      type("zzz");
      expect(input().getAttribute("aria-expanded")).toBe("false");
      expect(input().getAttribute("aria-activedescendant")).toBeNull();
    });
  });

  describe("trailing slot", () => {
    it("shows each row's jump chord, and the star in its place only under the highlight", () => {
      renderPicker();
      const label = (n: number) => displayLabel(parseCombo(`cmd+${n}`)!);
      const slot = (i: number) => {
        const row = screen.getAllByRole("option")[i]!.parentElement!;
        return {
          kbd: row.querySelector("kbd")?.textContent,
          star: !!within(row).queryByRole("button"),
        };
      };
      // Row 2 (Claude Sonnet 4) is highlighted: star, no chord.
      expect(slot(0)).toEqual({ kbd: label(1), star: false });
      expect(slot(1)).toEqual({ kbd: undefined, star: true });
      expect(slot(2)).toEqual({ kbd: label(3), star: false });
    });
  });

  describe("keyboard", () => {
    it("moves with the arrows and wraps at both ends", () => {
      renderPicker();
      expect(highlighted()).toBe("Claude Sonnet 4");
      key("ArrowDown");
      expect(highlighted()).toBe("GPT-5");
      key("ArrowDown");
      expect(highlighted()).toBe("Legacy models");
      key("ArrowDown");
      expect(highlighted()).toBe("Claude Opus 5");
      key("ArrowUp");
      expect(highlighted()).toBe("Legacy models");
    });

    it("picks the highlighted model on Enter", () => {
      const { onPick } = renderPicker();
      key("ArrowUp");
      key("Enter");
      expect(onPick).toHaveBeenCalledWith("atlas-agent", "claude-opus-5");
    });

    it("ignores Enter and the arrows while an IME is composing", () => {
      const { onPick } = renderPicker();
      key("ArrowDown", { isComposing: true });
      expect(highlighted()).toBe("Claude Sonnet 4");
      key("Enter", { isComposing: true });
      key("Enter", { keyCode: 229 });
      expect(onPick).not.toHaveBeenCalled();
    });

    it("steps through the rail with ⌘⇧↑ / ⌘⇧↓, wrapping", () => {
      renderPicker();
      chord("ArrowDown", "ArrowDown", true);
      expect(pressed()).toEqual(["Claude Code"]);
      expect(highlighted()).toBe("Default");
      chord("ArrowDown", "ArrowDown", true);
      chord("ArrowDown", "ArrowDown", true);
      expect(pressed()).toEqual(["Pinned"]);
      chord("ArrowUp", "ArrowUp", true);
      expect(pressed()).toEqual(["Codex"]);
    });

    it("moves to the rail with ← on an empty query or ⇧⇥, along it with ↑/↓, and back with →", () => {
      renderPicker();
      key("ArrowLeft");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Atlas Agent (current)");
      // One tab stop: only the shown entry is in the tab order.
      expect(railButtons().filter((b) => b.tabIndex === 0)).toHaveLength(1);
      key("ArrowDown");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Claude Code");
      key("ArrowUp");
      key("ArrowUp");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Pinned");
      key("ArrowRight");
      expect(document.activeElement).toBe(input());
      key("Tab", { shiftKey: true });
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Atlas Agent (current)");
    });

    it("keeps ← for the caret once there is a query", () => {
      renderPicker();
      type("cl");
      key("ArrowLeft");
      expect(document.activeElement).toBe(input());
    });

    it("stars the highlighted row with its registered chord", () => {
      renderPicker();
      chord("s", "KeyS", true);
      expect(useSettingsStore.getState().settings.favoriteModels).toEqual([
        "atlas-agent:claude-sonnet-4",
      ]);
      chord("s", "KeyS", true);
      expect(useSettingsStore.getState().settings.favoriteModels).toEqual([]);
    });

    it("picks the Nth model row by its registered chord, skipping the Legacy toggle", () => {
      const { onPick } = renderPicker();
      key("ArrowDown");
      key("ArrowDown");
      key("Enter"); // open the fold
      expect(rows()).toEqual([
        "Claude Opus 5",
        "Claude Sonnet 4",
        "GPT-5",
        "Legacy models",
        "Claude Sonnet 3.7",
        "Claude Haiku 3.5",
      ]);
      jump(2);
      expect(onPick).toHaveBeenLastCalledWith("atlas-agent", "claude-sonnet-4");
      // Row 5 on screen, but the FOURTH model.
      jump(4);
      expect(onPick).toHaveBeenLastCalledWith("atlas-agent", "claude-3-7");
      jump(9);
      expect(onPick).toHaveBeenCalledTimes(2);
    });

    it("answers its chords only while focus is inside it", () => {
      const first = vi.fn<OnPick>();
      const second = vi.fn<OnPick>();
      render(
        <>
          {picker(first, "claude-sonnet-4", agentsWith())}
          {picker(second, "claude-sonnet-4", agentsWith())}
        </>,
      );
      const [a] = screen.getAllByRole("combobox");
      act(() => a!.focus());
      jump(1);
      expect(first).toHaveBeenCalledWith("atlas-agent", "claude-opus-5");
      expect(second).not.toHaveBeenCalled();
      act(() => (document.activeElement as HTMLElement).blur());
      jump(1);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
    });
  });

  describe("highlight", () => {
    it("highlights the best match when searching, not the current model", () => {
      renderPicker();
      type("claude");
      expect(highlighted()).toBe("Claude Opus 5");
      type("");
      expect(highlighted()).toBe("Claude Sonnet 4");
    });

    it("stays on the same model when starring reorders the list", () => {
      renderPicker();
      key("ArrowDown"); // GPT-5
      chord("s", "KeyS", true);
      expect(rows()[0]).toBe("GPT-5");
      expect(highlighted()).toBe("GPT-5");
    });

    it("follows its model through a refreshed list, and clamps when it leaves", () => {
      const { rerender } = renderPicker();
      key("ArrowUp"); // Claude Opus 5
      const refreshed = [
        { id: "claude-x", name: "Claude X", provider: "anthropic" },
        ...NATIVE_MODELS,
      ];
      rerender(agentsWith(refreshed));
      expect(highlighted()).toBe("Claude Opus 5");
      rerender(agentsWith(refreshed.filter((m) => m.id !== "claude-opus-5")));
      expect(highlighted()).toBe("Claude Sonnet 4");
    });

    it("highlights the current model when its list arrives after open", () => {
      const { rerender } = renderPicker(vi.fn(), "gpt-5", agentsWith([]));
      expect(screen.getByText("No models")).toBeTruthy();
      rerender(agentsWith());
      expect(pressed()).toEqual(["Atlas Agent (current)"]);
      expect(highlighted()).toBe("GPT-5");
    });

    it("scrolls the list for the keyboard, not under the mouse, and never an ancestor", () => {
      const intoView = vi.fn();
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = intoView;
      onTestFinished(() => {
        Element.prototype.scrollIntoView = original;
      });
      renderPicker();
      const list = screen.getByRole("listbox");
      const scrollTo = vi.fn();
      Object.defineProperty(list, "scrollTop", { get: () => 0, set: scrollTo });
      fireEvent.mouseMove(screen.getAllByRole("option")[0]!.parentElement!);
      expect(highlighted()).toBe("Claude Opus 5");
      expect(scrollTo).not.toHaveBeenCalled();
      key("ArrowDown");
      expect(scrollTo).toHaveBeenCalled();
      // `scrollIntoView` would also scroll the composer's menu surface.
      expect(intoView).not.toHaveBeenCalled();
    });
  });

  describe("legacy fold", () => {
    it("folds legacy models under a toggle that names how many", () => {
      renderPicker();
      expect(screen.getByText("2 models")).toBeTruthy();
      expect(rows()).not.toContain("Claude Sonnet 3.7");
    });

    it("opens the fold when the current model is legacy", () => {
      renderPicker(vi.fn(), "claude-3-7");
      expect(rows()).toContain("Claude Sonnet 3.7");
      expect(highlighted()).toBe("Claude Sonnet 3.7");
    });

    it("opens the fold when the current model becomes a legacy one later", () => {
      const { rerender } = renderPicker();
      expect(rows()).not.toContain("Claude Haiku 3.5");
      rerender(agentsWith(), "claude-3-5");
      expect(rows()).toContain("Claude Haiku 3.5");
    });
  });

  describe("search", () => {
    it("searches every agent's models, names the agent, and hides the rail while it does", () => {
      const { onPick } = renderPicker();
      type("opus");
      expect(rows()).toEqual(["Opus 5.5", "Claude Opus 5"]);
      expect(screen.queryByRole("toolbar")).toBeNull();
      // The agent's mark carries its name too; the caption ends with it.
      expect(captions().map((c) => c.endsWith("Claude Code"))).toEqual([true, false]);
      expect(captions()[1]).toMatch(/Atlas Agent$/);
      key("Enter");
      expect(onPick).toHaveBeenCalledWith("claude-code", "opus");
    });

    it("matches the agent and the stated provider", () => {
      renderPicker();
      type("openai");
      expect(rows()).toEqual(["GPT-5"]);
      type("claude code");
      expect(rows()).toEqual(["Default", "Opus 5.5"]);
    });

    it("matches the description, below name and id matches", () => {
      renderPicker();
      type("refactors");
      expect(rows()).toEqual(["GPT-5"]);
    });

    it("says so when nothing matches", () => {
      renderPicker();
      type("zzz");
      expect(screen.getByText("No models match “zzz”")).toBeTruthy();
    });
  });

  it("scores name above id above description above source", () => {
    const m: SessionModeInfo = {
      id: "acme-fast",
      name: "Rocket",
      description: "quick helper",
      provider: "Claude",
    };
    const score = (q: string) => searchScore(m, "Claude", q);
    expect(score("rocket")).toBeLessThan(score("acme")!);
    expect(score("acme")).toBeLessThan(score("quick")!);
    expect(score("quick")).toBeLessThan(score("claude")!);
    expect(score("nope")).toBeNull();
  });

  it("draws no NEW badge, even for a model the agent marks new", () => {
    renderPicker();
    expect(screen.queryByText("New")).toBeNull();
  });

  it("puts the description on its own line, clamped to two", () => {
    renderPicker();
    const caption = screen.getByText("Strong at refactors").closest("p")!;
    expect(caption.className).toContain("line-clamp-2");
    expect(caption.previousElementSibling?.querySelector(".label")?.textContent).toBe("GPT-5");
  });
});
