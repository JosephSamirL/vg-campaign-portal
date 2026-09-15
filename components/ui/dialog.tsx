"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/*
 * A dependency-free modal dialog (the shadcn recipe wraps `@radix-ui/react-dialog`; the shadcn
 * CLI is broken in this repo and the package is not installed — same story as tooltip/popover).
 * Built on the native `<dialog>` element: `showModal()` gives focus trapping, the backdrop, Escape
 * and `aria-modal` for free. The API mirrors the shadcn one (`Dialog` with `open`/`onOpenChange`,
 * `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`) so callers
 * written against it compile unchanged. `dismissible={false}` keeps Escape and a backdrop click
 * from closing it — the send confirm dialog uses that while a request is in flight.
 */

type DialogProps = Omit<React.DialogHTMLAttributes<HTMLDialogElement>, "open"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dismissible?: boolean;
};

function Dialog({ open, onOpenChange, dismissible = true, className, children, ...props }: DialogProps) {
  const ref = React.useRef<HTMLDialogElement>(null);

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
        "m-auto w-full max-w-lg rounded-lg border bg-background p-0 text-foreground shadow-lg backdrop:bg-black/50",
        className,
      )}
      onCancel={(event) => {
        // Escape: the browser fires `cancel` first; preventing it keeps the dialog open
        if (!dismissible) event.preventDefault();
      }}
      onClose={() => onOpenChange(false)}
      onClick={(event) => {
        // a click on the backdrop lands on the <dialog> itself, a click inside on a descendant
        if (dismissible && event.target === event.currentTarget) onOpenChange(false);
      }}
      {...props}
    >
      {children}
    </dialog>
  );
}

function DialogContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-4 p-6", className)} {...props} />;
}

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 text-left", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle };
