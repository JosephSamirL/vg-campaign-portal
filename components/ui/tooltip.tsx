import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

/*
 * Tooltip primitive with no new dependency. The shadcn CLI is broken in this repo and the
 * Radix tooltip needs a client boundary, a provider and a package; this one is pure CSS
 * (`group-hover` / `group-focus-within`), so it renders inside server components, needs no
 * JavaScript, and its content is in the markup — a reader (or a test) can always find the
 * caption. The API mirrors the shadcn/Radix one (`TooltipProvider`, `asChild`, `side`,
 * `align`) so callers written against it compile unchanged; `TooltipProvider` is a no-op.
 * The trigger is keyboard-focusable so the content also opens on Tab.
 */

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

const SIDE: Record<Side, string> = {
  bottom: "top-full mt-1",
  top: "bottom-full mb-1",
  right: "left-full ml-1",
  left: "right-full mr-1",
};

const ALIGN: Record<"x" | "y", Record<Align, string>> = {
  // for top / bottom placement
  x: { start: "left-0", center: "left-1/2 -translate-x-1/2", end: "right-0" },
  // for left / right placement
  y: { start: "top-0", center: "top-1/2 -translate-y-1/2", end: "bottom-0" },
};

function TooltipProvider({ children }: { children: React.ReactNode; delayDuration?: number; skipDelayDuration?: number }) {
  return <>{children}</>;
}

type TooltipProps = React.HTMLAttributes<HTMLSpanElement> & { open?: boolean; defaultOpen?: boolean; delayDuration?: number };

const Tooltip = React.forwardRef<HTMLSpanElement, TooltipProps>(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ({ className, open, defaultOpen, delayDuration, ...props }, ref) => (
    <span ref={ref} className={cn("group/tooltip relative inline-flex", className)} {...props} />
  ),
);
Tooltip.displayName = "Tooltip";

type TooltipTriggerProps = React.HTMLAttributes<HTMLSpanElement> & { asChild?: boolean };

const TooltipTrigger = React.forwardRef<HTMLSpanElement, TooltipTriggerProps>(({ asChild = false, className, ...props }, ref) => {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp
      ref={ref}
      tabIndex={0}
      data-state="closed"
      className={cn(
        "rounded-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        !asChild && "cursor-help underline decoration-dotted underline-offset-4",
        className,
      )}
      {...props}
    />
  );
});
TooltipTrigger.displayName = "TooltipTrigger";

type TooltipContentProps = React.HTMLAttributes<HTMLSpanElement> & { side?: Side; align?: Align; sideOffset?: number };

const TooltipContent = React.forwardRef<HTMLSpanElement, TooltipContentProps>(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ({ className, side = "bottom", align = "start", sideOffset, ...props }, ref) => (
    <span
      ref={ref}
      role="tooltip"
      className={cn(
        "pointer-events-none absolute z-50 hidden w-72 max-w-[80vw] whitespace-normal rounded-md border bg-popover px-3 py-2 text-left text-xs font-normal text-popover-foreground shadow-md group-focus-within/tooltip:block group-hover/tooltip:block",
        SIDE[side],
        side === "top" || side === "bottom" ? ALIGN.x[align] : ALIGN.y[align],
        className,
      )}
      {...props}
    />
  ),
);
TooltipContent.displayName = "TooltipContent";

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
