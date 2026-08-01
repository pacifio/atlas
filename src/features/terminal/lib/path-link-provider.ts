import type { Terminal, ILink, ILinkProvider } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { openFileOrReveal } from "@/lib/open-file";
import { splitLinks, normalizeUrl } from "./linkify-paths";

/**
 * xterm link provider that makes URLs and file paths in terminal output
 * ⌘-clickable (VS Code behavior): ⌘-hover underlines, ⌘-click opens. URLs open
 * in the default browser; file paths resolve via Rust (`terminal_resolve_path`:
 * strip `:line:col`, expand `~`, join the shell's live cwd, verify existence)
 * then open in Atlas if supported, else reveal in Finder. Detection is shared
 * with the static-block renderer via `splitLinks`.
 */

// ⌘/Ctrl-held state, shared across all terminals; drives the hover underline.
let metaHeld = false;
let hoveredLink: ILink | null = null;
let listenersInstalled = false;

function decor() {
  return { pointerCursor: metaHeld, underline: metaHeld };
}
function refreshHoverDecor() {
  // `ILink.decorations` is live-tracked by xterm, so mutating it updates the
  // rendered underline immediately as ⌘ is pressed/released while hovering.
  if (hoveredLink) hoveredLink.decorations = decor();
}
function installModListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  const onMod = (e: KeyboardEvent) => {
    const held = e.metaKey || e.ctrlKey;
    if (held !== metaHeld) {
      metaHeld = held;
      refreshHoverDecor();
    }
  };
  window.addEventListener("keydown", onMod, true);
  window.addEventListener("keyup", onMod, true);
  // Clear if focus leaves (so a stuck ⌘ doesn't leave links underlined).
  window.addEventListener("blur", () => {
    if (metaHeld) {
      metaHeld = false;
      refreshHoverDecor();
    }
  });
}

export function createPathLinkProvider(
  term: Terminal,
  terminalId: string,
): ILinkProvider {
  installModListeners();
  return {
    provideLinks(lineNo, callback) {
      const line = term.buffer.active.getLine(lineNo - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const links: ILink[] = [];
      let offset = 0;
      for (const run of splitLinks(text)) {
        const startX = offset;
        const endX = offset + run.text.length;
        offset = endX;
        if (run.kind === "text") continue;
        const raw = run.text;
        const isUrl = run.kind === "url";
        links.push({
          text: raw,
          range: {
            start: { x: startX + 1, y: lineNo },
            end: { x: endX, y: lineNo },
          },
          decorations: decor(),
          activate: (event) => {
            // Require ⌘ (mac) / Ctrl (win/linux) so normal clicks/selection work.
            if (!(event.metaKey || event.ctrlKey)) return;
            if (isUrl) {
              void import("@tauri-apps/plugin-opener")
                .then(({ openUrl }) => openUrl(normalizeUrl(raw)))
                .catch(() => {});
              return;
            }
            void invoke<string | null>("terminal_resolve_path", {
              id: terminalId,
              raw,
            })
              .then((abs) => {
                if (abs) void openFileOrReveal(abs);
              })
              .catch(() => {});
          },
          hover: (_e, _t) => {
            hoveredLink = links.find((l) => l.text === raw) ?? null;
            refreshHoverDecor();
          },
          leave: () => {
            hoveredLink = null;
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}
