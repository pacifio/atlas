import { forwardRef, useState } from "react";
import { Eye, EyeOff, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * SecretInput — a masked text field with reveal + copy affordances. Modular
 * primitive: used by the BYOK provider panel today, but kept generic so any
 * "enter / inspect a secret" surface can reuse it.
 *
 * Controlled like a normal input via `value`/`onChange`. `onSubmit` fires on
 * Enter. `copyable` enables the inline copy button (copies the current value).
 */
export interface SecretInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "onSubmit"
> {
  value: string;
  onValueChange?: (next: string) => void;
  onSubmit?: () => void;
  copyable?: boolean;
  /** Start revealed (default: masked). */
  defaultRevealed?: boolean;
}

export const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(
  function SecretInput(
    {
      value,
      onValueChange,
      onSubmit,
      copyable = false,
      defaultRevealed = false,
      className,
      onChange,
      onKeyDown,
      ...rest
    },
    ref,
  ) {
    const [revealed, setRevealed] = useState(defaultRevealed);
    const [copied, setCopied] = useState(false);

    const copy = async () => {
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      } catch {
        /* clipboard blocked — silently ignore */
      }
    };

    return (
      <div
        className={cn(
          "group flex items-center gap-1 rounded-md border border-border-default bg-bg-elevated",
          "px-2 h-8 transition-colors focus-within:border-accent",
          className,
        )}
      >
        <input
          ref={ref}
          type={revealed ? "text" : "password"}
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          className={cn(
            "flex-1 min-w-0 bg-transparent outline-none text-[11px]",
            "text-text-primary placeholder:text-text-tertiary font-mono",
          )}
          onChange={(e) => {
            onValueChange?.(e.target.value);
            onChange?.(e);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit?.();
            onKeyDown?.(e);
          }}
          {...rest}
        />
        {copyable && (
          <IconBtn
            label={copied ? "Copied" : "Copy"}
            onClick={() => void copy()}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </IconBtn>
        )}
        <IconBtn
          label={revealed ? "Hide" : "Reveal"}
          onClick={() => setRevealed((r) => !r)}
        >
          {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
        </IconBtn>
      </div>
    );
  },
);

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="shrink-0 grid place-items-center h-6 w-6 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
    >
      {children}
    </button>
  );
}
