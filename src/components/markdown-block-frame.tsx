// A table or fenced code block in rendered markdown, with a collapse button
// under its left edge and a copy button under its right.
//
//   - A table collapses to one line per cell, each cut off with an ellipsis;
//     the button shows only when collapsing would cut something.
//   - A code block collapses to its first lines; the button shows only when
//     the block is taller than that.
//   - Copy: a table as Markdown or CSV (`markdown-table-copy.ts`), a code
//     block as its text.
//
// Both start open. The frame is a `data-collapsed` attribute and CSS
// (`.atlas-md-block` in `globals.css`), so collapsing re-renders nothing below.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Maximize2, Minimize2 } from "lucide-react";

import { copyText } from "@/lib/clipboard";
import { tableToCsv, tableToMarkdown } from "@/lib/markdown-table-copy";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { Hint, Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

/** A collapsed code block's height; past it, the button appears. Matches
 *  `.atlas-md-block[data-kind="code"][data-collapsed="true"] pre` in CSS. */
const CODE_COLLAPSED_PX = 192;

/** Whether collapsing would cut any cell short: measured with the frame
 *  collapsed for a moment, and put back before the browser paints. */
function wouldClipCells(frame: HTMLElement): boolean {
  const table = frame.querySelector("table");
  if (!table) return false;
  const previous = frame.dataset.collapsed;
  frame.dataset.collapsed = "true";
  try {
    for (const row of table.rows) {
      for (const cell of row.cells) if (cell.scrollWidth > cell.clientWidth + 1) return true;
    }
    return false;
  } finally {
    frame.dataset.collapsed = previous ?? "false";
  }
}

function canCollapse(frame: HTMLElement, kind: "table" | "code"): boolean {
  if (kind === "table") return wouldClipCells(frame);
  const pre = frame.querySelector("pre");
  return !!pre && pre.scrollHeight > CODE_COLLAPSED_PX + 16;
}

export function MarkdownBlockFrame({
  kind,
  children,
}: {
  kind: "table" | "code";
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [collapsible, setCollapsible] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  // Measured after every render and on every resize: a column can narrow
  // until a cell clips without this block rendering again.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame) setCollapsible(collapsed || canCollapse(frame, kind));
  });
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setCollapsible((was) =>
        frame.dataset.collapsed === "true" ? was : canCollapse(frame, kind),
      );
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [kind]);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copy = (format: "markdown" | "csv" | "code") => {
    const frame = frameRef.current;
    if (!frame) return;
    let text = "";
    if (format === "code") text = frame.querySelector("pre")?.textContent?.replace(/\n$/, "") ?? "";
    else {
      const table = frame.querySelector("table");
      if (!table) return;
      text = format === "markdown" ? tableToMarkdown(table) : tableToCsv(table);
    }
    void copyText(text).then((ok) => {
      if (!ok) return;
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      setCopied(true);
      copiedTimer.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimer.current = null;
      }, 1200);
    });
  };

  const noun = kind === "table" ? "table" : "code";
  const collapseLabel = collapsed ? `Expand ${noun}` : `Collapse ${noun}`;
  const copyLabel = copied ? "Copied" : kind === "table" ? "Copy table" : "Copy code";

  return (
    <div
      ref={frameRef}
      className="atlas-md-block"
      data-kind={kind}
      data-collapsed={collapsed ? "true" : "false"}
    >
      {children}
      <div className="atlas-md-block__bar">
        {collapsible ? (
          <Hint label={collapseLabel} side="top">
            <IconButton
              icon={collapsed ? Maximize2 : Minimize2}
              label={collapseLabel}
              size="xs"
              onClick={() => setCollapsed((value) => !value)}
            />
          </Hint>
        ) : (
          <span />
        )}
        {kind === "table" ? (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger
                    render={<IconButton icon={copied ? Check : Copy} label={copyLabel} size="xs" />}
                  />
                }
              />
              <TooltipContent side="top">{copyLabel}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" side="top">
              <DropdownMenuItem onClick={() => copy("markdown")}>Copy as Markdown</DropdownMenuItem>
              <DropdownMenuItem onClick={() => copy("csv")}>Copy as CSV</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Hint label={copyLabel} side="top">
            <IconButton
              icon={copied ? Check : Copy}
              label={copyLabel}
              size="xs"
              onClick={() => copy("code")}
            />
          </Hint>
        )}
      </div>
    </div>
  );
}
