import { useEffect, useRef, useState } from "react";
import { Loader2, MessageCircle, Rss } from "lucide-react";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import type { Organisation } from "@/features/organisations/types";

/**
 * What the chat panel shows when the active organisation is local-only.
 *
 * Team chat is org-scoped and every route it uses names a **server** org id, so
 * an organisation with no `remoteId` has nothing to talk to — there is no
 * degraded mode to offer, only the one action that fixes it.
 *
 * Connecting is the org-wide "turn on sync" act, not a chat-specific one, so it
 * reuses `enableSync` rather than introducing a second path to the same state.
 * That action already knows what to do when signed out (open sign-in and return
 * immediately), which is why the spinner below is only armed when signed in.
 */
export function CommsNotConnected({ org }: { org: Organisation | null }) {
  const signedIn = useAuthStore.use.snapshot().status === "signed-in";
  const { enableSync } = useOrgStore.use.actions();
  const [syncing, setSyncing] = useState(false);

  const connect = () => {
    if (!org) return;
    if (!signedIn) {
      // Opens the sign-in dialog and returns at once — a spinner here would
      // hang until the browser round-trip finished somewhere else entirely.
      void enableSync(org.id);
      return;
    }
    setSyncing(true);
    void enableSync(org.id).finally(() => setSyncing(false));
  };

  return (
    <div className="relative flex min-w-0 flex-1 flex-col items-center justify-center gap-2.5 overflow-hidden px-8 text-center">
      <DitherBackdrop />
      <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-bg-elevated text-text-secondary">
        <MessageCircle size={16} />
      </span>
      {/* Text hierarchy is one rung brighter than the chrome's default. This is
          the only content on the panel, so `--text-ghost` (#333) — the rung for
          decoration and disabled state — left the one explanation unreadable
          against the near-black surface. */}
      <div className="relative text-[12px] font-medium text-text-primary">
        {org ? `${org.name} isn't connected` : "No organisation selected"}
      </div>
      <p className="relative max-w-[220px] text-[11px] leading-relaxed text-text-secondary">
        {org
          ? "Team chat needs this organisation synced to your Atlas account."
          : "Select an organisation to use team chat."}
      </p>
      {org && (
        <button
          type="button"
          disabled={syncing}
          onClick={connect}
          // The iOS frosted pill: translucent monochrome fill + backdrop blur
          // softening the dither behind it, hairline top light. Static blur on
          // one element — the vibrant-panel rule bans transform ANIMATION near
          // blur, not a still frosted control (the drop overlay already blurs
          // inside this panel).
          className="relative mt-1 flex h-[30px] items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-4 text-[11.5px] font-medium text-text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-md transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
        >
          {syncing ? (
            <Loader2 size={12} className="shrink-0 animate-spin" />
          ) : (
            <Rss size={12} className="shrink-0" />
          )}
          {syncing ? "Connecting…" : signedIn ? "Connect" : "Sign in to connect"}
        </button>
      )}
    </div>
  );
}

/**
 * A retro ordered-dither field that drifts like slow cloud cover.
 *
 * Canvas, not SVG: a Bayer-thresholded noise field at this size is tens of
 * thousands of dots, which as DOM nodes would dwarf the panel it decorates.
 * No transforms and no compositor animation — each frame is a plain pixel
 * repaint, so the vibrant panel's blend layer sees a still element.
 *
 * The DRIFT is deliberately stepped at ~12fps: ordered dither reads as retro
 * precisely because it snaps, tweening it just looks like noise — and a
 * placeholder screen does not get a 60fps budget. The loop parks entirely
 * while the window is hidden and dies with the component.
 *
 * The look: two octaves of value noise make soft "waves" blown sideways by a
 * slow wind term, a 4×4 Bayer matrix turns intensity into dot density, and a
 * radial falloff hollows out the middle so the copy sits on calm black.
 */
function DitherBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let raf = 0;
    let last = 0;
    const FRAME_MS = 80; // ~12fps — the retro step IS the aesthetic
    const CELL = 4;

    const draw = (t: number) => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const { clientWidth: w, clientHeight: h } = parent;
      if (w === 0 || h === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const bw = Math.ceil(w * dpr);
      const bh = Math.ceil(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "rgba(255,255,255,0.16)";

      // Wind: mostly sideways, a little lift, plus a slow phase evolution so
      // shapes morph rather than only translate.
      const wx = t * 0.012;
      const wy = t * 0.003;
      const phase = t * 0.0004;
      const noise = (x: number, y: number) => {
        const a = Math.sin(x * 0.012 + Math.sin(y * 0.009 + phase) * 2.1);
        const b = Math.sin(y * 0.011 - Math.cos(x * 0.007 - phase) * 1.7);
        const c = Math.sin((x + y) * 0.004 + 1.3 + phase * 2);
        return (a + b + c) / 3; // -1..1
      };
      const bayer = [
        [0, 8, 2, 10],
        [12, 4, 14, 6],
        [3, 11, 1, 9],
        [15, 7, 13, 5],
      ];
      const cx = w / 2;
      const cy = h / 2;
      const maxR = Math.hypot(cx, cy);

      for (let gy = 0; gy < h / CELL; gy++) {
        for (let gx = 0; gx < w / CELL; gx++) {
          const x = gx * CELL;
          const y = gy * CELL;
          let v = (noise(x + wx, y + wy) + 1) / 2;
          const r = Math.hypot(x - cx, y - cy) / maxR;
          v *= Math.min(1, Math.max(0, (r - 0.22) / 0.55));
          if (v * 16 > bayer[gy % 4][gx % 4]) {
            ctx.fillRect(x, y, 1.5, 1.5);
          }
        }
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      // Step gate: repaint only when a frame's worth of drift has accrued.
      if (now - last < FRAME_MS) return;
      last = now;
      draw(now);
    };

    const start = () => {
      if (!raf && document.visibilityState === "visible") {
        raf = requestAnimationFrame(tick);
      }
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    draw(0);
    start();
    document.addEventListener("visibilitychange", onVisibility);
    const parent = canvas.parentElement;
    const ro = parent ? new ResizeObserver(() => draw(last)) : null;
    if (parent && ro) ro.observe(parent);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      ro?.disconnect();
    };
  }, []);

  return (
    <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
  );
}
