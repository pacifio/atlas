import { X } from "lucide-react";
import { Hint, Icon } from "@tryatlas/design";

import { cn } from "@/lib/utils";
import { AccountAvatarView } from "@/features/auth/components/views/account-avatar-view";

/** Split pasted/typed text on the separators people actually use between
 *  addresses — commas, semicolons, and any whitespace including newlines. */
export function splitEmails(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Drop repeats, case-insensitively, keeping the first spelling. */
export function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const key = e.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Deliberately loose. The server is the authority on deliverability; this only
 *  catches the shapes that are obviously not an address, so a chip turns red
 *  before a round trip rather than instead of one. */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Gmail-style recipient input: committed addresses become chips, the rest is a
 * free-typing draft. Commits on comma / semicolon / Enter / Tab / blur / paste,
 * and Backspace on an empty draft eats the last chip.
 *
 * The draft is owned by the PARENT so that pressing Invite with a half-typed
 * address still sends it — the most common way to lose an invite is a field
 * that only counts what you remembered to press comma after.
 */
export function EmailChipsInput({
  emails,
  draft,
  onEmailsChange,
  onDraftChange,
  onSubmit,
}: {
  emails: string[];
  draft: string;
  onEmailsChange: (next: string[]) => void;
  onDraftChange: (next: string) => void;
  onSubmit: () => void;
}) {
  const commit = (raw: string) => {
    const next = dedupe([...emails, ...splitEmails(raw)]);
    onEmailsChange(next);
    onDraftChange("");
  };

  return (
    <div
      // FIXED height, never `min-h` + wrap: the bar must not grow the moment a
      // chip appears. Overflowing chips scroll sideways instead.
      className="hide-scrollbar flex h-control-md min-w-0 flex-1 cursor-text items-center gap-1 overflow-x-auto rounded-md border border-border bg-card px-1.5 focus-within:border-border-strong"
      onClick={(e) => {
        // Clicking the padding should focus the field, like a real input.
        const input = e.currentTarget.querySelector("input");
        input?.focus();
      }}
    >
      {emails.map((email) => {
        const valid = isEmail(email);
        return (
          <span
            key={email}
            className={cn(
              // h-5 + a 14px avatar keeps the chip inside the field.
              "inline-flex h-5 max-w-[220px] shrink-0 items-center gap-1 rounded-full border pr-1 pl-0.5 text-xs",
              valid ? "border-border bg-background text-foreground" : "border-error text-error",
            )}
          >
            <AccountAvatarView name="" email={email} src={null} size={14} />
            {/* The title sits on the text rather than the chip, so it doesn't
                open over the remove button's own tooltip. */}
            <span className="truncate" title={valid ? email : "Not a valid email address"}>
              {email}
            </span>
            <Hint label="Remove">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEmailsChange(emails.filter((x) => x !== email));
                }}
                className="shrink-0 cursor-pointer rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                aria-label={`Remove ${email}`}
              >
                <Icon icon={X} size="xs" />
              </button>
            </Hint>
          </span>
        );
      })}
      <input
        value={draft}
        onChange={(e) => {
          // Typing a separator commits, so pasting "a@b.com," lands as a chip.
          if (/[,;]/.test(e.target.value)) commit(e.target.value);
          else onDraftChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (draft.trim()) commit(draft);
            else onSubmit();
            return;
          }
          if (e.key === "Tab" && draft.trim()) {
            e.preventDefault();
            commit(draft);
            return;
          }
          if (e.key === "Backspace" && !draft && emails.length > 0) {
            onEmailsChange(emails.slice(0, -1));
          }
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (!/[,;\s]/.test(text)) return; // a single address — let it type
          e.preventDefault();
          commit(draft + text);
        }}
        onBlur={() => draft.trim() && commit(draft)}
        placeholder={emails.length === 0 ? "teammate@company.com, …" : ""}
        aria-label="Invite by email"
        className="h-full min-w-[120px] flex-1 shrink-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
