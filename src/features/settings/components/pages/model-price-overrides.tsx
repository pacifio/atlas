import { useState } from "react";
import { Button, Input } from "@tryatlas/design";
import { useScopedSetting } from "../../lib/use-scoped-setting";
import { type ModelPriceOverrides } from "../../stores/model-pricing-store";
import { SettingsGroup, SettingsRow, SettingsSection } from "../layout/settings-layout";

const RATES = [
  ["input", "Input"],
  ["output", "Output"],
  ["cacheRead", "Cache read"],
  ["cacheWrite", "Cache write"],
] as const;

export function ModelPriceOverridesSection() {
  const scoped = useScopedSetting("modelPriceOverrides");
  const [editing, setEditing] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [rates, setRates] = useState({ input: "", output: "", cacheRead: "", cacheWrite: "" });
  const [error, setError] = useState<string | null>(null);

  const clear = () => {
    setEditing(null);
    setModel("");
    setRates({ input: "", output: "", cacheRead: "", cacheWrite: "" });
    setError(null);
  };
  const edit = (id: string, price: ModelPriceOverrides[string]) => {
    setEditing(id);
    setModel(id);
    setRates({
      input: String(price.input),
      output: String(price.output),
      cacheRead: String(price.cacheRead),
      cacheWrite: String(price.cacheWrite),
    });
    setError(null);
  };

  return (
    <SettingsSection title="Cost estimates">
      <SettingsGroup>
        <SettingsRow
          setting="modelPriceOverrides"
          status="Atlas Agent gateway turns are metered against your account cap. These overrides have no effect there."
        >
          <fieldset disabled={scoped.globalOnly} className="flex min-w-0 flex-col gap-4">
            {Object.entries(scoped.value).map(([id, price]) => (
              <div key={id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs" title={id}>
                  {id}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${id}`}
                  onClick={() => edit(id, price)}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${id}`}
                  onClick={() => {
                    const next = { ...scoped.value };
                    delete next[id];
                    scoped.set(next);
                    if (editing === id) clear();
                  }}
                >
                  Remove
                </Button>
              </div>
            ))}
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const id = model.trim();
                if (!id) {
                  setError("Enter a model ID.");
                  return;
                }
                if (id !== editing && Object.prototype.hasOwnProperty.call(scoped.value, id)) {
                  setError("This model already has an override. Edit its existing entry.");
                  return;
                }
                if (
                  RATES.some(
                    ([key]) =>
                      rates[key].trim() === "" ||
                      !Number.isFinite(Number(rates[key])) ||
                      Number(rates[key]) < 0,
                  )
                ) {
                  setError("Enter a nonnegative price for all four token types. Zero is allowed.");
                  return;
                }
                const next = { ...scoped.value };
                if (editing) delete next[editing];
                const price = {
                  input: Number(rates.input),
                  output: Number(rates.output),
                  cacheRead: Number(rates.cacheRead),
                  cacheWrite: Number(rates.cacheWrite),
                };
                scoped.set({ ...next, [id]: price });
                clear();
              }}
            >
              <label className="flex flex-col gap-1 text-xs">
                Model ID
                <Input
                  required
                  value={model}
                  placeholder="provider/model or model"
                  onChange={(event) => setModel(event.target.value)}
                />
              </label>
              <p className="caption">
                USD per million tokens. Names match exactly, then without a provider prefix, then
                without an eight-digit date suffix.
              </p>
              <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
                {RATES.map(([key, label]) => (
                  <label key={key} className="flex flex-col gap-1 text-xs">
                    {label}
                    <Input
                      required
                      type="number"
                      min="0"
                      step="any"
                      value={rates[key]}
                      onChange={(event) => setRates({ ...rates, [key]: event.target.value })}
                    />
                  </label>
                ))}
              </div>
              {error && (
                <p role="alert" className="text-xs text-error">
                  {error}
                </p>
              )}
              <div className="flex gap-2">
                <Button type="submit" size="sm">
                  {editing ? "Save override" : "Add override"}
                </Button>
                {editing && (
                  <Button type="button" variant="ghost" size="sm" onClick={clear}>
                    Cancel
                  </Button>
                )}
              </div>
            </form>
          </fieldset>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
