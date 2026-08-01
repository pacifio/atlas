import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProjectUsage } from "@/features/chat/lib/claude-api";
import { fmtTokens, fmtCost, fmtDate } from "../lib/usage-format";

/**
 * Full per-session usage table in a centered modal (same shape as the
 * git tool-output dialog). Shows every session with its token/cost
 * breakdown; columns are fixed-width + numeric so nothing overlaps.
 */
export function UsageModal({
  open,
  onOpenChange,
  data,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: ProjectUsage;
}) {
  const { totals, sessions } = data;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[80vh] w-[820px] max-w-[92vw] flex-col overflow-hidden rounded-md",
            "border border-border-default bg-bg-elevated shadow-[var(--shadow-overlay)] animate-scale-in",
          )}
        >
          <div className="flex items-center gap-3 border-b border-border-default px-4 py-2.5">
            <Dialog.Title className="text-[13px] font-semibold text-text-primary">
              Project Usage
            </Dialog.Title>
            <span className="text-[11px] font-mono text-text-tertiary">
              {totals.session_count} sessions · {fmtCost(totals.total_cost_usd)}
            </span>
            <Dialog.Close
              className="ml-auto flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
              aria-label="Close"
            >
              <X size={13} />
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-auto hide-scrollbar">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-bg-elevated">
                <tr className="text-text-tertiary border-b border-border-default">
                  <Th className="text-left w-[34%]">Session</Th>
                  <Th className="text-left">Model</Th>
                  <Th className="text-right">Input</Th>
                  <Th className="text-right">Output</Th>
                  <Th className="text-right">Cache</Th>
                  <Th className="text-right">Reqs</Th>
                  <Th className="text-right">Cost</Th>
                  <Th className="text-right">Updated</Th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr
                    key={s.session_id}
                    className="border-b border-border-subtle hover:bg-bg-hover"
                  >
                    <Td className="text-left max-w-0">
                      <span className="block truncate text-text-secondary">
                        {s.preview || s.session_id.slice(0, 8)}
                      </span>
                    </Td>
                    <Td className="text-left text-text-tertiary truncate">
                      {(s.model ?? "—").replace(/^claude-/, "")}
                    </Td>
                    <Td className="text-right font-mono tabular-nums">
                      {fmtTokens(s.input_tokens)}
                    </Td>
                    <Td className="text-right font-mono tabular-nums">
                      {fmtTokens(s.output_tokens)}
                    </Td>
                    <Td className="text-right font-mono tabular-nums">
                      {fmtTokens(s.cache_creation_tokens + s.cache_read_tokens)}
                    </Td>
                    <Td className="text-right font-mono tabular-nums">
                      {s.request_count}
                    </Td>
                    <Td className="text-right font-mono tabular-nums text-text-primary">
                      {fmtCost(s.total_cost_usd)}
                    </Td>
                    <Td className="text-right text-text-tertiary">
                      {fmtDate(s.last_modified)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Th({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <th
      className={cn(
        "px-3 py-1.5 font-medium uppercase tracking-wider text-[9px]",
        className,
      )}
    >
      {children}
    </th>
  );
}
function Td({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <td className={cn("px-3 py-1.5 text-text-secondary", className)}>
      {children}
    </td>
  );
}
