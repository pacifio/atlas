import { useEffect } from "react";

import {
  costOf,
  priceForModel,
  useModelPricingStore,
  type TokenSpend,
} from "@/features/settings/stores/model-pricing-store";
import { useBranchPullRequest } from "@/features/security/components/ship-overview-card";

import type { SessionDetail as Detail } from "../types";
import { useOpenSignal, type RowComments } from "../lib/session-detail-context";
import { SessionMastheadView } from "./views/session-masthead-view";

/**
 * Title, identity pills, and the four numbers worth leading with.
 *
 * The rhythm is deliberate and even: the same 22px sits between the title and
 * the pills as between the pills and the grid, and the 56px above the title
 * matches the 56px below the grid — so the header reads as one block with air
 * around it rather than three rows that happen to be stacked. Export is not
 * here; it lives in the header dock with the tab's other actions.
 */
export function Masthead({
  detail,
  comments,
  projectPath,
}: {
  detail: Detail;
  comments: RowComments | null;
  projectPath: string;
}) {
  const openSignal = useOpenSignal(detail.summary.id);
  const s = detail.summary;
  const branch = s.branches[0];
  const pr = useBranchPullRequest(projectPath, branch ?? "");

  // Pricing is cached by Rust and refreshed in the background; a consumer has
  // to ask for it once. Cheap and idempotent — `load` is stable and the store
  // is shared, so opening ten Sessions reads the cache once.
  const prices = useModelPricingStore.use.prices();
  const { load: loadPrices } = useModelPricingStore.use.actions();
  useEffect(() => {
    void loadPrices();
  }, [loadPrices]);

  const spend: TokenSpend = {
    input: s.inputTokens,
    output: s.outputTokens,
    cacheWrite: s.cacheCreationTokens,
    cacheRead: s.cacheReadTokens,
  };
  const spent = spend.input + spend.output + spend.cacheWrite + spend.cacheRead;
  const cost = spent > 0 ? costOf(spend, priceForModel(prices, s.model)) : null;

  return (
    <SessionMastheadView
      detail={detail}
      comments={comments}
      projectPath={projectPath}
      openSignal={openSignal}
      pr={pr}
      cost={cost}
      spent={spent}
    />
  );
}
