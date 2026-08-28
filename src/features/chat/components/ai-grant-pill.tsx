import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "@/features/auth/stores/auth-store";

/**
 * The native agent's no-grant setup state (spec D15a, acceptance bar item 14).
 *
 * A signed-in user whose organisation has no AI grant is not having a failure,
 * they are having a **setup problem** — the gateway's own words. Shown as an
 * error it reads as something broken, and they go hunting for a switch to flip.
 * There is no such switch; an admin has to grant it, so the pill says that.
 *
 * A pill in the existing floating row rather than a disabled composer,
 * deliberately: the agent switcher lives *inside* the composer, so disabling it
 * on one agent's readiness traps the user on the agent that cannot run
 * (ADR-0002, and the trap `ChatComposer` already documents). Atlas Agent stays
 * selectable and everything else keeps working.
 */
type Entitlement =
  | { state: "entitled"; models: string[] }
  | { state: "noGrant"; message: string }
  | { state: "unknown"; reason: string };

export function AiGrantPill() {
  const signedIn = useAuthStore((s) => s.snapshot.status === "signed-in");
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);

  useEffect(() => {
    if (!signedIn) {
      setEntitlement(null);
      return;
    }
    let live = true;
    invoke<Entitlement>("native_agent_entitlement")
      .then((result) => {
        if (live) setEntitlement(result);
      })
      // A probe that fails tells us nothing about the grant, and "we could not
      // find out" must never render as "you do not have access".
      .catch(() => {
        if (live) setEntitlement(null);
      });
    return () => {
      live = false;
    };
  }, [signedIn]);

  if (entitlement?.state !== "noGrant") return null;

  return (
    <div
      data-testid="ai-grant-pill"
      className="atlas-pill-in inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[11px] leading-none font-medium text-[var(--text-secondary)]"
      title={entitlement.message}
    >
      <ShieldAlert size={12} className="text-[var(--text-tertiary)]" />
      <span className="text-[var(--text-primary)]">{entitlement.message}</span>
    </div>
  );
}
