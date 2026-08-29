import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { CommandSuggestions, type Suggestion } from "./command-suggestions";
import { parseToken, applyCompletion, type TokenInfo } from "../lib/command-completion";

export interface CommandInputHandle {
  focus: () => void;
}

interface CommandInputProps {
  onSubmit: (cmd: string) => void;
  onInterrupt: () => void;
  /** Live cwd (OSC-7) used to resolve path completions. */
  cwd?: string;
  /** A command is currently running — the composer feeds its stdin (answering
   *  interactive prompts like create-next-app) instead of composing a command. */
  busy?: boolean;
  /** The running command put the tty in RAW mode — it is a TUI doing its own
   *  key handling (an agent login picker, say), not a program reading lines.
   *  Every keystroke is forwarded as it is typed instead of being buffered
   *  until Enter. Only meaningful together with `busy`. */
  rawMode?: boolean;
  /** DECCKM is on — arrows must be sent as SS3, not CSI. */
  appCursorKeys?: boolean;
  /** Send raw bytes to the PTY (for forwarding nav keys to a running prompt). */
  writeRaw?: (data: number[]) => void;
}

const ARROW_FINAL: Record<string, number> = {
  ArrowUp: 0x41,
  ArrowDown: 0x42,
  ArrowRight: 0x43,
  ArrowLeft: 0x44,
};

/** Arrow key → escape sequence, in the form the app asked for (see DECCKM). */
function arrowBytes(key: string, appCursorKeys: boolean): number[] | null {
  const final = ARROW_FINAL[key];
  return final ? [0x1b, appCursorKeys ? 0x4f : 0x5b, final] : null;
}

// Non-arrow keys a running interactive prompt expects (arrows come from
// `arrowBytes`, which has to account for DECCKM).
const KEY_BYTES: Record<string, number[]> = {
  Escape: [0x1b],
  Tab: [0x09],
};

const encoder = new TextEncoder();

/**
 * A keystroke as the bytes a real terminal would send, or `null` for keys that
 * should be left to the browser.
 *
 * ENTER IS CR (0x0d), NOT LF. A terminal sends CR; the line discipline turns it
 * into LF for programs reading lines (ICRNL), so CR is right in both modes —
 * but a raw-mode TUI gets the byte untranslated, and the keypress decoders
 * these CLIs are built on (Node's readline layer, under Ink and @clack) call
 * `\r` "return" and only submit on that. Sending LF was invisible to them.
 */
function rawKeyBytes(
  e: KeyboardEvent<HTMLTextAreaElement>,
  appCursorKeys: boolean,
): number[] | null {
  const k = e.key;
  const arrow = arrowBytes(k, appCursorKeys);
  if (arrow) return arrow;
  switch (k) {
    case "Enter":
      return [0x0d];
    case "Tab":
      return e.shiftKey ? [0x1b, 0x5b, 0x5a] : [0x09];
    case "Escape":
      return [0x1b];
    // The tty's erase character is DEL, not BS — sending 0x08 leaves the
    // typed character on screen in most prompts.
    case "Backspace":
      return [0x7f];
    case "Delete":
      return [0x1b, 0x5b, 0x33, 0x7e];
    case "Home":
      return [0x1b, 0x5b, 0x48];
    case "End":
      return [0x1b, 0x5b, 0x46];
    case "PageUp":
      return [0x1b, 0x5b, 0x35, 0x7e];
    case "PageDown":
      return [0x1b, 0x5b, 0x36, 0x7e];
  }
  if (k.length !== 1) return null; // Shift/Meta/F-keys/dead keys — not ours
  if (e.ctrlKey) {
    const c = k.toLowerCase().charCodeAt(0);
    return c >= 0x61 && c <= 0x7a ? [c - 0x60] : null;
  }
  if (e.metaKey) return null; // ⌘C/⌘V stay with the webview
  const bytes = Array.from(encoder.encode(k));
  return e.altKey ? [0x1b, ...bytes] : bytes;
}

interface RawPathCompletion {
  name: string;
  is_dir: boolean;
}

/** An active Tab-completion cycle: the original token + the match set being
 *  cycled through. `replacedEnd` tracks where the currently-inserted match ends
 *  so the next Tab replaces it (not the original token). */
interface CycleState {
  info: TokenInfo;
  matches: Suggestion[];
  index: number;
  replacedEnd: number;
}

export const CommandInput = forwardRef<CommandInputHandle, CommandInputProps>(function CommandInput(
  { onSubmit, onInterrupt, cwd, busy, rawMode, appCursorKeys, writeRaw },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  // Command history + a cursor into it (-1 = the live, un-submitted line).
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef<number>(-1);

  // ── Autocomplete state ────────────────────────────────────────────────
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const cmdListRef = useRef<string[] | null>(null); // $PATH commands, fetched once
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cycleRef = useRef<CycleState | null>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useImperativeHandle(ref, () => ({ focus: () => taRef.current?.focus() }), []);

  // Auto-grow the textarea with its content (multi-line via Shift+Enter).
  const resize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);
  useLayoutEffect(resize, [value, resize]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    let lastW = -1;
    const ro = new ResizeObserver(() => {
      if (ta.clientWidth !== lastW) {
        lastW = ta.clientWidth;
        resize();
      }
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [resize]);

  const setText = (text: string) => {
    setValue(text);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) ta.setSelectionRange(text.length, text.length);
    });
  };

  const closeSuggest = useCallback(() => {
    cycleRef.current = null;
    setOpen(false);
    setSuggestions([]);
    setActiveIndex(0);
  }, []);

  const ensureCmdList = useCallback(async () => {
    if (cmdListRef.current) return;
    try {
      cmdListRef.current = await invoke<string[]>("terminal_list_commands");
    } catch {
      cmdListRef.current = [];
    }
  }, []);

  // Command-name suggestions: history-used names first, then $PATH/builtins.
  const commandSuggestions = useCallback((prefix: string): Suggestion[] => {
    const p = prefix.toLowerCase();
    const seen = new Set<string>();
    const out: Suggestion[] = [];
    for (const line of [...historyRef.current].reverse()) {
      const first = line.trim().split(/\s+/)[0];
      if (first && first.toLowerCase().startsWith(p) && !seen.has(first)) {
        seen.add(first);
        out.push({ name: first, kind: "command" });
      }
    }
    for (const c of cmdListRef.current ?? []) {
      if (out.length >= 50) break;
      if (c.toLowerCase().startsWith(p) && !seen.has(c)) {
        seen.add(c);
        out.push({ name: c, kind: "command" });
      }
    }
    return out.slice(0, 50);
  }, []);

  const computeItems = useCallback(
    async (info: TokenInfo): Promise<Suggestion[]> => {
      if (info.kind === "command") {
        if (info.prefix.length < 1) return [];
        await ensureCmdList();
        return commandSuggestions(info.prefix);
      }
      if (info.token.length < 1) return [];
      try {
        const res = await invoke<RawPathCompletion[]>("terminal_path_complete", {
          cwd: cwdRef.current ?? "~",
          token: info.token,
        });
        return res.map((e) => ({
          name: e.name,
          kind: e.is_dir ? "dir" : "file",
        }));
      } catch {
        return [];
      }
    },
    [ensureCmdList, commandSuggestions],
  );

  // Passive suggestions as the user types (no insertion). Ends any Tab cycle.
  const recompute = useCallback(async () => {
    cycleRef.current = null;
    const ta = taRef.current;
    if (!ta) return closeSuggest();
    const v0 = ta.value;
    const info = parseToken(v0, ta.selectionStart ?? v0.length);
    if (!info) return closeSuggest();
    const items = await computeItems(info);
    if (taRef.current?.value !== v0) return; // stale — a newer recompute runs
    setSuggestions(items);
    setActiveIndex(0);
    setOpen(items.length > 0);
  }, [computeItems, closeSuggest]);

  const scheduleRecompute = useCallback(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void recompute(), 120);
  }, [recompute]);

  // Insert (or replace) the current token with the cycle's active match,
  // WITHOUT a trailing space — so further Tab cycles cleanly.
  const applyCycle = useCallback(() => {
    const c = cycleRef.current;
    const ta = taRef.current;
    if (!c || !ta) return;
    const m = c.matches[c.index];
    const repl =
      c.info.kind === "command"
        ? m.name
        : c.info.dirPart + m.name.replace(/ /g, "\\ ") + (m.kind === "dir" ? "/" : "");
    const v = ta.value;
    const next = v.slice(0, c.info.start) + repl + v.slice(c.replacedEnd);
    c.replacedEnd = c.info.start + repl.length;
    setValue(next);
    setActiveIndex(c.index);
    const end = c.replacedEnd;
    requestAnimationFrame(() => taRef.current?.setSelectionRange(end, end));
  }, []);

  // Finalize a selection (single match or mouse click): insert with a
  // trailing space (file/command) or `/` (dir, keep the picker open to drill in).
  const finalize = useCallback(
    (info: TokenInfo, end: number, s: Suggestion) => {
      const ta = taRef.current;
      if (!ta) return;
      const { next, caret, keepOpen } = applyCompletion(
        ta.value,
        info,
        s.name,
        s.kind === "dir",
        end,
      );
      cycleRef.current = null;
      setValue(next);
      requestAnimationFrame(() => {
        taRef.current?.setSelectionRange(caret, caret);
        if (keepOpen) void recompute();
        else closeSuggest();
      });
    },
    [recompute, closeSuggest],
  );

  // Mouse click on a row.
  const handleSelect = useCallback(
    (s: Suggestion) => {
      const ta = taRef.current;
      if (!ta) return;
      const c = cycleRef.current;
      const info = c?.info ?? parseToken(ta.value, ta.selectionStart ?? ta.value.length);
      if (!info) return closeSuggest();
      finalize(info, c?.replacedEnd ?? info.caret, s);
    },
    [finalize, closeSuggest],
  );

  const startCycle = useCallback(
    async (dir: 1 | -1) => {
      const ta = taRef.current;
      if (!ta) return;
      const v0 = ta.value;
      const info = parseToken(v0, ta.selectionStart ?? v0.length);
      if (!info) return closeSuggest();
      const items = await computeItems(info);
      if (taRef.current?.value !== v0) return;
      if (items.length === 0) return closeSuggest();
      if (items.length === 1) return finalize(info, info.caret, items[0]);
      const index = dir > 0 ? 0 : items.length - 1;
      cycleRef.current = {
        info,
        matches: items,
        index,
        replacedEnd: info.caret,
      };
      setSuggestions(items);
      setOpen(true);
      applyCycle();
    },
    [computeItems, closeSuggest, finalize, applyCycle],
  );

  const cycleTab = useCallback(
    (dir: 1 | -1) => {
      const c = cycleRef.current;
      if (c) {
        c.index = (c.index + dir + c.matches.length) % c.matches.length;
        applyCycle();
      } else {
        void startCycle(dir);
      }
    },
    [applyCycle, startCycle],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;

    // While a command runs, the composer feeds the running process's stdin so
    // interactive prompts (create-next-app, etc.) work. Navigation keys are
    // forwarded raw to the PTY; typed text is sent as a line on Enter.
    if (busy && writeRaw) {
      if (e.key === "c" && e.ctrlKey && ta.selectionStart === ta.selectionEnd) {
        e.preventDefault();
        onInterrupt();
        return;
      }

      // A raw-mode TUI does its own key handling and echoes what it wants: it
      // needs every keystroke AS IT HAPPENS, not a line on Enter. Buffering
      // here is what made single-key answers (y/n, space-to-toggle), live text
      // fields and Backspace do nothing at all.
      if (rawMode) {
        const raw = rawKeyBytes(e, !!appCursorKeys);
        if (!raw) return;
        e.preventDefault();
        if (open) closeSuggest();
        writeRaw(raw);
        return;
      }

      const bytes = arrowBytes(e.key, !!appCursorKeys) ?? KEY_BYTES[e.key];
      if (bytes && (e.key !== "Tab" || !value)) {
        // Forward nav keys (and Tab only when there's nothing typed, so Tab can
        // still answer a prompt's default). Esc closes any open suggestion first.
        if (e.key === "Escape" && open) {
          e.preventDefault();
          closeSuggest();
          return;
        }
        e.preventDefault();
        writeRaw(bytes);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // Send the typed answer straight to the process's stdin ("" → just a
        // newline = confirm the default). NOT through `onSubmit` — this is
        // stdin, not a shell command, so it skips clear/sudo command handling.
        // CR, not LF: see `rawKeyBytes`. ICRNL converts it for a cooked reader.
        writeRaw([...encoder.encode(value), 0x0d]);
        setValue("");
        closeSuggest();
        return;
      }
      // Other keys: let the textarea handle them (typing the answer).
      return;
    }

    // Tab drives completion cycling (Shift+Tab cycles backward). Never inserts
    // a literal tab.
    if (e.key === "Tab") {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === "Escape" && open) {
      e.preventDefault();
      closeSuggest();
      return;
    }

    // Enter ALWAYS runs the command (the cycled/typed text in `value`).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const cmd = value;
      onSubmit(cmd);
      if (cmd.trim()) historyRef.current.push(cmd);
      histIdxRef.current = -1;
      setValue("");
      closeSuggest();
      return;
    }

    if (e.key === "c" && e.ctrlKey && ta.selectionStart === ta.selectionEnd) {
      e.preventDefault();
      onInterrupt();
      return;
    }

    // ↑/↓ cycle the suggestion picker WHILE it's open (matches Tab/Shift+Tab);
    // once closed they fall through to history — terminal muscle memory.
    if (e.key === "ArrowUp" && open) {
      e.preventDefault();
      cycleTab(-1);
      return;
    }
    if (e.key === "ArrowDown" && open) {
      e.preventDefault();
      cycleTab(1);
      return;
    }
    if (e.key === "ArrowUp") {
      const onFirstLine = !value.slice(0, ta.selectionStart).includes("\n");
      if (!onFirstLine) return;
      const h = historyRef.current;
      if (!h.length) return;
      e.preventDefault();
      closeSuggest();
      histIdxRef.current =
        histIdxRef.current < 0 ? h.length - 1 : Math.max(0, histIdxRef.current - 1);
      setText(h[histIdxRef.current]);
      return;
    }
    if (e.key === "ArrowDown") {
      const onLastLine = !value.slice(ta.selectionStart).includes("\n");
      if (!onLastLine) return;
      if (histIdxRef.current < 0) return;
      e.preventDefault();
      closeSuggest();
      const h = historyRef.current;
      histIdxRef.current += 1;
      if (histIdxRef.current >= h.length) {
        histIdxRef.current = -1;
        setText("");
      } else {
        setText(h[histIdxRef.current]);
      }
      return;
    }
  };

  return (
    <>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          // No shell completions while feeding a running prompt.
          if (!busy) scheduleRecompute();
        }}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          // Keystrokes bypass the textarea in raw mode, so a paste has to be
          // forwarded too — device-code logins exist to have a code pasted
          // into them. Newlines become CR, the same as pressing Enter.
          if (!busy || !rawMode || !writeRaw) return;
          e.preventDefault();
          const text = e.clipboardData.getData("text");
          if (text) writeRaw(Array.from(encoder.encode(text.replace(/\r?\n/g, "\r"))));
        }}
        onBlur={closeSuggest}
        rows={1}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={
          busy
            ? rawMode
              ? "Interactive prompt — keys go straight to it…"
              : "Type a response, then press Enter…"
            : "Run a command…"
        }
        // `min-w-0` lets the textarea actually shrink inside the flex row on
        // narrow panes; the nowrap placeholder clips instead of wrapping onto
        // multiple lines (textarea placeholders wrap by default).
        className="min-w-0 flex-1 resize-none overflow-hidden border-none bg-transparent p-0 text-[13px] leading-[18px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] placeholder:[white-space:nowrap]"
        style={{
          fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)',
        }}
      />
      <CommandSuggestions
        open={open}
        items={suggestions}
        activeIndex={activeIndex}
        anchorEl={taRef.current}
        onSelect={handleSelect}
        onClose={closeSuggest}
      />
    </>
  );
});
