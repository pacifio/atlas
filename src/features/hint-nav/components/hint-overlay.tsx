import { useCallback, useEffect, useRef, useState } from "react";
import { Kbd } from "@/ui/kbd";
import { useHintStore } from "../stores/hint-store";
import { scanTargets, HINT_OVERLAY_ATTR, type HintTarget } from "../lib/scan-targets";
import { generateLabels } from "../lib/generate-labels";
import { activate } from "../lib/activate-target";
import { matchesAction } from "@/features/keybindings/lib/use-scoped-hotkeys";

/**
 * The trigger (⌘⌥Space by default) — rebindable via Settings → Keybindings.
 * Matching is on `e.code`: on macOS Option+Space emits a non-breaking space,
 * so key-based matching would silently fail.
 */
function isTrigger(e: KeyboardEvent): boolean {
  return matchesAction(e, "hintNav.toggle");
}

/** Robust single-char extraction that survives macOS Option-diacritics and
 *  non-US layouts by preferring the physical key code. */
function charFromEvent(e: KeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) return e.key.toLowerCase();
  return null;
}

export function HintOverlay() {
  const open = useHintStore.use.open();
  const { toggle, close } = useHintStore.use.actions();

  const [targets, setTargets] = useState<HintTarget[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [typed, setTyped] = useState("");

  // Refs so the (capture-phase) key handler always sees the latest values
  // without re-subscribing the listener on every keystroke.
  const targetsRef = useRef(targets);
  const labelsRef = useRef(labels);
  const typedRef = useRef(typed);
  targetsRef.current = targets;
  labelsRef.current = labels;
  typedRef.current = typed;

  const toggleRef = useRef(toggle);
  const closeRef = useRef(close);
  toggleRef.current = toggle;
  closeRef.current = close;

  // Always-on trigger listener — the ONLY steady-state cost of the feature.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTrigger(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return; // ignore auto-repeat while the combo is held
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // Scan + label on open; clear on close.
  useEffect(() => {
    if (!open) {
      setTargets([]);
      setLabels([]);
      setTyped("");
      return;
    }
    const found = scanTargets();
    setTargets(found);
    setLabels(generateLabels(found.length));
    setTyped("");
  }, [open]);

  // Re-measure rects on scroll/resize (rAF-throttled) so badges track the UI.
  const remeasure = useCallback(() => {
    setTargets((prev) => prev.map((t) => ({ el: t.el, rect: t.el.getBoundingClientRect() })));
  }, []);
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        remeasure();
      });
    };
    // capture:true catches scrolls from any inner scroll container (scroll
    // events don't bubble).
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [open, remeasure]);

  // Scroll the scrollable element under the viewport centre (arrow keys).
  const scrollActive = useCallback((dy: number) => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    let node: HTMLElement | null = el as HTMLElement | null;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const scrollable =
        /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
      if (scrollable) {
        node.scrollBy({ top: dy });
        return;
      }
      node = node.parentElement;
    }
    window.scrollBy({ top: dy });
  }, []);

  // Key handling while open. Capture-phase + stopImmediatePropagation so it
  // beats useHotkeys, the terminal's capture handler, and any focused input.
  useEffect(() => {
    if (!open) return;
    const STEP = 120;
    const onKey = (e: KeyboardEvent) => {
      if (isTrigger(e)) return; // handled by the always-on listener
      e.preventDefault();
      e.stopImmediatePropagation();

      if (e.key === "Escape") {
        closeRef.current();
        return;
      }
      if (e.key === "Backspace") {
        setTyped((t) => t.slice(0, -1));
        return;
      }
      if (e.key === "ArrowDown") return scrollActive(STEP);
      if (e.key === "ArrowUp") return scrollActive(-STEP);
      if (e.key === "PageDown") return scrollActive(window.innerHeight * 0.9);
      if (e.key === "PageUp") return scrollActive(-window.innerHeight * 0.9);

      const ch = charFromEvent(e);
      if (!ch) return;

      const next = typedRef.current + ch;
      const matchIdx: number[] = [];
      labelsRef.current.forEach((l, i) => {
        if (l.startsWith(next)) matchIdx.push(i);
      });
      if (matchIdx.length === 0) return; // dead end — ignore the keystroke
      if (matchIdx.length === 1) {
        const t = targetsRef.current[matchIdx[0]];
        closeRef.current();
        // Option held → force focus instead of click.
        if (t) activate(t.el, { focusOnly: e.altKey });
        return;
      }
      setTyped(next);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, scrollActive]);

  if (!open) return null;

  return (
    <div
      {...{ [HINT_OVERLAY_ATTR]: "" }}
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ zIndex: "var(--z-max)" }}
    >
      {targets.map((t, i) => {
        const label = labels[i];
        if (!label) return null;
        const matched = label.startsWith(typed);
        if (typed && !matched) return null; // hide non-matching to cut clutter
        return (
          <span
            key={i}
            className="absolute inline-flex items-center rounded-full px-1.5 font-sans text-[10px] font-semibold uppercase leading-[16px] tracking-wide"
            style={{
              left: Math.max(0, t.rect.left),
              top: Math.max(0, t.rect.top),
              transform: "translate(-2px, -2px)",
              // macOS-native keycap: fully-rounded, dark frosted-glass pill —
              // a darker translucent gradient over a heavy backdrop blur, a
              // hairline border so it reads over any surface, a faint top
              // highlight + bottom shade for the raised feel, and a soft drop
              // shadow lifting it off the page.
              color: "rgba(255,255,255,0.95)",
              background: "linear-gradient(180deg, rgba(18,18,21,0.86) 0%, rgba(8,8,10,0.9) 100%)",
              backdropFilter: "blur(14px) saturate(160%)",
              WebkitBackdropFilter: "blur(14px) saturate(160%)",
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -1px 0 rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.6)",
            }}
          >
            {typed && <span style={{ opacity: 0.4 }}>{label.slice(0, typed.length)}</span>}
            <span>{label.slice(typed.length)}</span>
          </span>
        );
      })}

      {/* Bottom HUD bar — native macOS frosted-glass dock */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
        <div
          className="flex items-center gap-3 rounded-2xl px-3.5 py-2.5"
          style={{
            // Matches the hint keycaps: dark translucent gradient over a heavy
            // backdrop blur, hairline border, faint top highlight + soft drop
            // shadow for the floating native-HUD feel.
            background: "linear-gradient(180deg, rgba(18,18,21,0.86) 0%, rgba(8,8,10,0.9) 100%)",
            backdropFilter: "blur(22px) saturate(170%)",
            WebkitBackdropFilter: "blur(22px) saturate(170%)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1), 0 8px 28px rgba(0,0,0,0.55)",
          }}
        >
          <span className="font-mono text-[12px] text-[var(--text-primary)]">
            {typed ? (
              <span className="tracking-widest">{typed.toUpperCase()}</span>
            ) : (
              <span className="text-[var(--text-tertiary)]">
                {targets.length} targets — type the letters
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 text-[10px] text-[var(--text-tertiary)]">
            <Kbd>⌥</Kbd> focus
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
