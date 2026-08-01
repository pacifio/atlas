import { useEffect, useRef } from "react";

type KeyCombo = {
  key: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
};

function matchKey(e: KeyboardEvent, key: string) {
  const k = key.toLowerCase();
  if (e.key.toLowerCase() === k) return true;
  // Option/Alt on macOS substitutes the typed character (e.g. option+b → "∫"),
  // so fall back to event.code (e.g. "KeyB").
  if (k.length === 1 && /[a-z]/.test(k) && e.code === `Key${key.toUpperCase()}`)
    return true;
  if (k === "[" && e.code === "BracketLeft") return true;
  if (k === "]" && e.code === "BracketRight") return true;
  // Punctuation that Option also rewrites (split-view shortcuts ⌥;/⌥'/⌘\).
  if (k === ";" && e.code === "Semicolon") return true;
  if (k === "'" && e.code === "Quote") return true;
  if (k === "\\" && e.code === "Backslash") return true;
  if (k === "/" && e.code === "Slash") return true;
  return false;
}

export function useHotkeys(
  bindings: Array<{ combo: KeyCombo; action: () => void }>,
) {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      for (const { combo, action } of bindingsRef.current) {
        const metaMatch = combo.meta ? e.metaKey || e.ctrlKey : true;
        const shiftMatch = combo.shift ? e.shiftKey : !e.shiftKey;
        const altMatch = combo.alt ? e.altKey : !e.altKey;
        const keyMatch = matchKey(e, combo.key);

        if (metaMatch && shiftMatch && altMatch && keyMatch) {
          e.preventDefault();
          action();
          return;
        }
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
