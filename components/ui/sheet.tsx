"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/*
 * A dependency-free side sheet with the shadcn API surface (`Sheet`, `SheetTrigger`,
 * `SheetContent side=…`, `SheetHeader`, `SheetTitle`, `SheetDescription`, `SheetClose`). The
 * shadcn recipe wraps `@radix-ui/react-dialog`, which is not installed and whose CLI is broken in
 * this repo — same rule as `dialog.tsx` / `tooltip.tsx` / `popover.tsx`: no new package. Built
 * on the native `<dialog>` element in the top layer: `showModal()` gives focus trapping, the
 * backdrop, Escape and `aria-modal` for free. The panel is pinned to one edge (`m-0` + an auto
 * margin on the far side, full `dvh` height) instead of the centred `Dialog`.
 *
 * `Sheet` holds the open state in context (nothing in the DOM), `SheetTrigger` opens it,
 * `SheetContent` is the `<dialog>`, `SheetClose` closes it. Story 7.1 uses it for the phone nav.
 */

type SheetContextValue = { open: boolean; onOpenChange: (open: boolean) => void };
const SheetContext = React.createContext<SheetContextValue | null>(null);

function useSheet(component: string): SheetContextValue {
  const ctx = React.useContext(SheetContext);
  if (!ctx) throw new Error(`${component} must be rendered inside <Sheet>`);
  return ctx;
}

type SheetProps = { open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode };

function Sheet({ open, onOpenChange, children }: SheetProps) {
  const value = React.useMemo(() => ({ open, onOpenChange }), [open, onOpenChange]);
  return <SheetContext.Provider value={value}>{children}</SheetContext.Provider>;
}

type SheetTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean };

const SheetTrigger = React.forwardRef<HTMLButtonElement, SheetTriggerProps>(({ asChild = false, onClick, ...props }, ref) => {
  const { open, onOpenChange } = useSheet("SheetTrigger");
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : "button"}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (!event.defaultPrevented) onOpenChange(true);
      }}
      {...props}
    />
  );
});
SheetTrigger.displayName = "SheetTrigger";

type Side = "left" | "right";

const SIDE_CLASS: Record<Side, string> = {
  // `m-0` cancels the top layer's auto centring; the auto margin on the far side pins the panel to its edge
  left: "mr-auto border-r",
  right: "ml-auto border-l",
};

type SheetContentProps = Omit<React.DialogHTMLAttributes<HTMLDialogElement>, "open"> & {
  side?: Side;
  /** Escape / backdrop close the sheet (default true). */
  dismissible?: boolean;
};

const SheetContent = React.forwardRef<HTMLDialogElement, SheetContentProps>(
  ({ side = "left", dismissible = true, className, children, ...props }, forwardedRef) => {
    const { open, onOpenChange } = useSheet("SheetContent");
    const ref = React.useRef<HTMLDialogElement>(null);
    React.useImperativeHandle(forwardedRef, () => ref.current as HTMLDialogElement);

    React.useEffect(() => {
      const el = ref.current;
      if (!el) return;
      if (open && !el.open) el.showModal();
      else if (!open && el.open) el.close();
    }, [open]);

    return (
      <dialog
        ref={ref}
        className={cn(
          // no `display` utility here: it would override the UA's `dialog:not([open]) { display: none }`
          "m-0 h-dvh max-h-none w-3/4 max-w-sm bg-background p-0 text-foreground shadow-lg backdrop:bg-black/50",
          SIDE_CLASS[side],
          className,
        )}
        onCancel={(event) => {
          if (!dismissible) event.preventDefault();
        }}
        onClose={() => onOpenChange(false)}
        onClick={(event) => {
          // a click on the backdrop lands on the <dialog> itself, a click inside on a descendant
          if (dismissible && event.target === event.currentTarget) onOpenChange(false);
        }}
        {...props}
      >
        <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">{children}</div>
        <SheetClose
          className="absolute right-4 top-4 inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Close menu"
        >
          <X className="size-4" aria-hidden />
        </SheetClose>
      </dialog>
    );
  },
);
SheetContent.displayName = "SheetContent";

const SheetClose = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(({ onClick, ...props }, ref) => {
  const { onOpenChange } = useSheet("SheetClose");
  return (
    <button
      ref={ref}
      type="button"
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onOpenChange(false);
      }}
      {...props}
    />
  );
});
SheetClose.displayName = "SheetClose";

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 pr-11 text-left", className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />;
}

function SheetDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger };
