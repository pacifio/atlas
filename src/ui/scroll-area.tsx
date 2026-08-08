import { cn } from "@/lib/utils";
import { forwardRef } from "react";

interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {}

const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div ref={ref} className={cn("overflow-auto", className)} {...props}>
        {children}
      </div>
    );
  },
);
ScrollArea.displayName = "ScrollArea";

export { ScrollArea };
