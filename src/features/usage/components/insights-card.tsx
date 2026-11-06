import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Lightbulb } from "lucide-react";
import { CAPTION, Card } from "@/components/usage-primitives";
import { cn } from "@/lib/utils";
import type { Insight } from "../lib/derive";

/**
 * One insight at a time (the reference's "Insight" card): the big figure, then the sentence
 * with its lead phrase emphasised, dots + arrows to walk the list. Rule-based, computed from
 * the window — nothing here asks a model anything.
 */
export function InsightsCard({ insights }: { insights: Insight[] }) {
  const [i, setI] = useState(0);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (i >= insights.length) setI(0);
  }, [insights.length, i]);
  const go = (next: number) => {
    if (insights.length === 0) return;
    setVisible(false);
    window.setTimeout(() => {
      setI((next + insights.length) % insights.length);
      setVisible(true);
    }, 140);
  };
  const cur = insights[i] ?? null;
  return (
    <Card index={3} section="insights" className="flex min-h-[172px] flex-col">
      <div className="flex items-center gap-1.5">
        <Lightbulb size={11} className="text-muted-foreground" />
        <span className={CAPTION}>Insight</span>
      </div>
      <div
        className="flex flex-1 flex-col justify-center py-2"
        style={{ opacity: visible ? 1 : 0, transition: "opacity 140ms ease-out" }}
      >
        {cur ? (
          <>
            <div
              className="truncate text-2xl leading-none font-semibold tabular-nums text-foreground"
              title={cur.stat}
            >
              {cur.stat}
            </div>
            <p className="mt-2 text-sm leading-snug">
              <span className="text-foreground">{cur.lead}</span>{" "}
              <span className="text-muted-foreground">{cur.rest}</span>
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Not enough in this window to say anything yet.
          </p>
        )}
      </div>
      {insights.length > 1 && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous insight"
            onClick={() => go(i - 1)}
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground"
          >
            <ChevronLeft size={12} />
          </button>
          <div className="flex items-center gap-1">
            {insights.map((ins, k) => (
              <button
                key={ins.id}
                type="button"
                aria-label={`Insight ${k + 1}`}
                onClick={() => go(k)}
                className={cn(
                  // Width, not scaleX: a 3px capsule squashed sideways loses
                  // its round ends, and three tiny buttons reflowing is cheap.
                  "h-[3px] rounded-full transition-[width,background-color] duration-200",
                  k === i ? "w-5 bg-success" : "w-3 bg-element-active hover:bg-muted-foreground",
                )}
              />
            ))}
          </div>
          <button
            type="button"
            aria-label="Next insight"
            onClick={() => go(i + 1)}
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground"
          >
            <ChevronRight size={12} />
          </button>
        </div>
      )}
    </Card>
  );
}
