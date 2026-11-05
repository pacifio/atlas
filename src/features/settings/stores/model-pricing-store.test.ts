import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  applyPriceOverrides,
  costOf,
  priceFor,
  priceForModel,
  useModelPricingStore,
  type ModelPrice,
} from "./model-pricing-store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const catalogPrice: ModelPrice = {
  input: 10,
  output: 20,
  cacheRead: 3,
  cacheWrite: 4,
  reasoning: true,
  images: true,
  context: 200_000,
};
const override = { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 };
const catalog = {
  "vendor/model-20260101": catalogPrice,
  "model-20260101": catalogPrice,
  model: catalogPrice,
};
const spend = { input: 1_000_000, output: 2_000_000, cacheRead: 3_000_000, cacheWrite: 4_000_000 };

beforeEach(() => {
  vi.clearAllMocks();
  useModelPricingStore.setState({
    catalog: {},
    overrides: {},
    prices: {},
    loaded: false,
    loading: false,
  });
});

describe("model price overrides", () => {
  it("treats object property names as ordinary model IDs", () => {
    const prices = applyPriceOverrides({}, JSON.parse(JSON.stringify({ ["__proto__"]: override })));
    expect(priceForModel(prices, "__proto__")).toEqual(override);
    expect(priceForModel(prices, "constructor")).toBeNull();
  });
  it.each(["vendor/model-20260101", "model-20260101", "model"])(
    "replaces a more specific catalog price using %s",
    (key) => {
      const prices = applyPriceOverrides(catalog, { [key]: override });
      expect(priceForModel(prices, " vendor/model-20260101 ")).toEqual({
        ...catalogPrice,
        ...override,
      });
      expect(priceFor(prices, "vendor", "model-20260101")).toEqual({
        ...catalogPrice,
        ...override,
      });
      expect(costOf(spend, priceForModel(prices, "vendor/model-20260101"))).toBe(7.75);
      expect(catalog["vendor/model-20260101"]).toEqual(catalogPrice);
    },
  );

  it("matches exact, bare and undated overrides in that order", () => {
    const prices = applyPriceOverrides(catalog, {
      model: { ...override, input: 3 },
      "model-20260101": { ...override, input: 2 },
      "vendor/model-20260101": { ...override, input: 1 },
    });
    expect(priceForModel(prices, "vendor/model-20260101")?.input).toBe(1);
    expect(priceForModel(prices, "other/model-20260101")?.input).toBe(2);
    expect(priceForModel(prices, "other/model-20260102")?.input).toBe(3);
  });

  it("prices an override-only model, including context-window and dated variants", () => {
    const prices = applyPriceOverrides({}, { private: override });
    expect(costOf(spend, priceForModel(prices, "vendor/private[1m]-20260101"))).toBe(7.75);
    expect(priceForModel(prices, "private-1234567")).toBeNull();
    expect(priceForModel(prices, "private-preview")).toBeNull();
    expect(priceForModel(prices, "unknown")).toBeNull();
    expect(priceForModel(prices, null)).toBeNull();
  });

  it("accepts a free model and retains catalog prices on an override miss", () => {
    const prices = applyPriceOverrides(catalog, {
      private: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(costOf(spend, priceForModel(prices, "private"))).toBe(0);
    expect(priceForModel(prices, "model")).toEqual(catalogPrice);
    expect(costOf(spend, null)).toBeNull();
  });
});

describe("pricing store", () => {
  it("keeps overrides through loading and refresh, then restores the latest catalog on removal", async () => {
    const actions = useModelPricingStore.getState().actions;
    actions.setOverrides({ model: override });
    expect(costOf(spend, priceForModel(useModelPricingStore.getState().prices, "model"))).toBe(
      7.75,
    );
    vi.mocked(invoke).mockResolvedValueOnce(catalog);
    await actions.load();
    expect(
      priceForModel(useModelPricingStore.getState().prices, "vendor/model-20260101")?.input,
    ).toBe(1);
    const refreshed = { ...catalog, model: { ...catalogPrice, input: 99 } };
    vi.mocked(invoke).mockResolvedValueOnce({ updated: true }).mockResolvedValueOnce(refreshed);
    await actions.refresh();
    expect(priceForModel(useModelPricingStore.getState().prices, "model")?.input).toBe(1);
    actions.setOverrides({});
    expect(useModelPricingStore.getState().prices).toEqual(refreshed);
    expect(invoke).toHaveBeenCalledWith("models_pricing_refresh");
    expect(useModelPricingStore.getState().loading).toBe(false);
  });

  it("keeps override-only models priced after an offline load or refresh", async () => {
    const actions = useModelPricingStore.getState().actions;
    actions.setOverrides({ private: override });
    vi.mocked(invoke).mockRejectedValue(new Error("offline"));
    await actions.load();
    await actions.refresh();
    expect(useModelPricingStore.getState().prices.private).toEqual(override);
    expect(useModelPricingStore.getState().loading).toBe(false);
  });
});
