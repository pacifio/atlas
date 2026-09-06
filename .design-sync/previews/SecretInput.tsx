import { SecretInput } from "atlas";

export const Empty = () => (
  <div className="w-[260px]">
    <SecretInput placeholder="sk-ant-…" aria-label="Anthropic API key" />
  </div>
);

export const Filled = () => (
  <div className="w-[260px]">
    <SecretInput defaultValue="sk-ant-api03-7Qw2f9xK" aria-label="Anthropic API key" />
  </div>
);

export const Labelled = () => (
  <div className="flex w-[260px] flex-col gap-1.5">
    <label className="text-[11px] text-[var(--text-tertiary)]">OpenAI API key</label>
    <SecretInput defaultValue="sk-proj-4Lm8Zt1RcQ" aria-label="OpenAI API key" />
    <span className="text-[10.5px] text-[var(--text-muted)]">
      Written to your shell profile as an export line — Atlas stores no keys.
    </span>
  </div>
);

export const Disabled = () => (
  <div className="w-[260px]">
    <SecretInput defaultValue="sk-ant-api03-7Qw2f9xK" disabled aria-label="Disabled key" />
  </div>
);
