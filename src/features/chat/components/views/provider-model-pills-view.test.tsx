// @vitest-environment happy-dom
//
// Browsing is not committing: a rail click only browses, and only a row pick
// commits a model. The container's auto-pick rule depends on that split.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ProviderModelPillsView,
  type ProviderModelPillsViewProps,
} from "./provider-model-pills-view";

afterEach(cleanup);

function setup(over: Partial<ProviderModelPillsViewProps> = {}) {
  const props: ProviderModelPillsViewProps = {
    provider: "openai",
    model: "gpt-5",
    viewProvider: "openai",
    providers: [
      { id: "openai", name: "OpenAI", keyed: true },
      { id: "anthropic", name: "Anthropic", keyed: false },
    ],
    hasKey: true,
    models: { pinned: ["gpt-5"], rest: ["gpt-5-mini"] },
    loadingModels: false,
    query: "",
    onQuery: vi.fn(),
    open: true,
    onOpenChange: vi.fn(),
    onBrowse: vi.fn(),
    onPick: vi.fn(),
    onSetUpKey: vi.fn(),
    pricing: { label: () => "$1 / $2", loading: false, onRefresh: vi.fn() },
    ...over,
  };
  render(<ProviderModelPillsView {...props} />);
  return props;
}

describe("ProviderModelPillsView", () => {
  it("a rail click browses and never picks", () => {
    const props = setup();
    // The rail is the first column of buttons inside the popover.
    const rail = document.querySelectorAll(".border-r button");
    expect(rail.length).toBe(2);
    fireEvent.click(rail[1]);
    expect(props.onBrowse).toHaveBeenCalledWith("anthropic");
    expect(props.onPick).not.toHaveBeenCalled();
  });

  it("a row click picks its model", () => {
    const props = setup();
    fireEvent.click(screen.getByText("gpt-5-mini"));
    expect(props.onPick).toHaveBeenCalledWith("gpt-5-mini");
  });

  it("without a key, Set up key in Settings calls onSetUpKey", () => {
    const props = setup({ viewProvider: "anthropic", hasKey: false });
    expect(screen.getByText("No API key for Anthropic")).toBeTruthy();
    fireEvent.click(screen.getByText("Set up key in Settings"));
    expect(props.onSetUpKey).toHaveBeenCalled();
  });
});
