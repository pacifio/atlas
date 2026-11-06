import { cn } from "@/lib/utils";

/** "Step 2 of 3" as dots: First run and every Tip's card. */
export function StepDots({ count, step }: { count: number; step: number }) {
  if (count < 2) return <span />;
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={cn(
            "size-1.5 rounded-full",
            i === step ? "bg-foreground" : "bg-muted-foreground/40",
          )}
        />
      ))}
    </span>
  );
}
