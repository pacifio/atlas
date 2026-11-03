import { useEffect, useRef, useState } from "react";

import { captureSlugAvailable } from "../lib/capture-api";
import type { SlugState } from "../lib/capture-flow";

/**
 * Debounced three-state Slug availability.
 *
 * `unknown` is deliberately distinct from `taken`: telling a developer their
 * name is gone when the network merely blinked is a lie they will act on — so
 * it reads as "couldn't check" with a retry, and it never blocks submitting.
 */
export function useSlugAvailability(projectPath: string, orgId: string, slug: string): SlugState {
  const [state, setState] = useState<SlugState>({ kind: "idle" });
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const trimmed = slug.trim();
    if (!orgId || !trimmed) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "checking" });
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      captureSlugAvailable(projectPath, orgId, trimmed)
        .then((availability) => {
          if (mine !== seq.current) return;
          if (availability === "available") setState({ kind: "available" });
          else if (availability === "taken") setState({ kind: "taken" });
          else setState({ kind: "unknown", retry: () => setNonce((n) => n + 1) });
        })
        .catch(() => {
          if (mine === seq.current) {
            setState({ kind: "unknown", retry: () => setNonce((n) => n + 1) });
          }
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [projectPath, orgId, slug, nonce]);

  return state;
}
