import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Separator primitive without a dependency (the shadcn CLI is broken in this repo; the Radix
 * one would add a package for a single rule). `decorative` (default) hides it from assistive
 * tech; pass `decorative={false}` for a semantic `separator`.
 */
const Separator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical"; decorative?: boolean }
>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <div
    ref={ref}
    role={decorative ? "none" : "separator"}
    aria-orientation={decorative ? undefined : orientation}
    className={cn("shrink-0 bg-border", orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]", className)}
    {...props}
  />
));
Separator.displayName = "Separator";

export { Separator };
