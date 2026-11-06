import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The shared vocabulary of every usage surface — the composer's Usage popup
 * and the org-wide Usage tab draw the same cards, captions, bars and pills so
 * the two read as one system. Moved out of `usage-popup.tsx` unchanged.
 */

export const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Eases a number to `target` over `ms`, rAF-driven. Snaps under reduced motion. */
export function useCountUp(target: number, ms = 220): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  const from = useRef(value);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const begin = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) * (1 - t) * (1 - t);
      const v = begin + (target - begin) * eased;
      setValue(v);
      from.current = v;
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** True after mount — bars transition from 0 on first paint. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(prefersReducedMotion());
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return mounted;
}

export const CAPTION =
  "text-2xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]";
export const VALUE = "text-xs tabular-nums text-[var(--foreground)]";

/** One staggered section card; `index` drives the `atlas-usage-in` delay. */
export function Card({
  index,
  section,
  children,
  className,
}: {
  index: number;
  section: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      data-section={section}
      className={cn(
        "atlas-usage-in rounded-lg border border-element-selected bg-[var(--card)] px-2.5 py-2",
        className,
      )}
      style={{ "--i": index } as CSSProperties}
    >
      {children}
    </section>
  );
}

export function StatusPill({ status, label }: { status: "ok" | "warn" | "full"; label?: string }) {
  const tone =
    status === "full"
      ? "border-error/40 text-error"
      : status === "warn"
        ? "border-warning/40 text-warning"
        : "border-element-active text-[var(--secondary-foreground)]";
  return (
    <span
      className={cn(
        "inline-flex h-4 items-center rounded-full border px-1.5 text-3xs font-medium uppercase tracking-wider",
        tone,
      )}
    >
      {label ?? (status === "full" ? "Full" : status === "warn" ? "Warn" : "OK")}
    </span>
  );
}

export function Bar({
  frac,
  mounted,
  color = "var(--secondary-foreground)",
}: {
  frac: number;
  mounted: boolean;
  color?: string;
}) {
  return (
    <span className="block h-[3px] w-full overflow-hidden rounded-full bg-element-selected">
      <span
        className="block h-full rounded-full"
        style={{
          width: `${mounted ? Math.max(2, frac * 100) : 0}%`,
          background: color,
          transition: "width 220ms cubic-bezier(0.32,0.72,0,1)",
        }}
      />
    </span>
  );
}

/** The "est." chip beside any cost that came from the price map, not the provider. */
export function EstTag() {
  return (
    <span className="rounded-full border border-element-active px-1 text-3xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
      est.
    </span>
  );
}
