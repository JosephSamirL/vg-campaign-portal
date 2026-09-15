"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A small dependency-free popover (the shadcn recipe wraps `@radix-ui/react-popover`; the
 * shadcn CLI is broken in this repo and the package is not installed, so this is hand-written
 * in the same shape). Opens on hover with a mouse and on tap/click on touch — a tap must not be
 * lost to the emulated mouseenter, so hover is keyed on `pointerType === "mouse"`. A click pins
 * it open until the next click, Escape, or a click outside.
 */

type PopoverContextValue = {
  open: boolean;
  toggle: () => void;
  contentId: string;
};

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

function usePopover(component: string): PopoverContextValue {
  const ctx = React.useContext(PopoverContext);
  if (!ctx) throw new Error(`${component} must be used inside <Popover>`);
  return ctx;
}

function Popover({ className, children, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  const [open, setOpen] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const contentId = React.useId();
  const ref = React.useRef<HTMLSpanElement>(null);

  const close = React.useCallback(() => {
    setPinned(false);
    setOpen(false);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const toggle = React.useCallback(() => {
    if (pinned) close();
    else {
      setPinned(true);
      setOpen(true);
    }
  }, [pinned, close]);

  return (
    <PopoverContext.Provider value={{ open, toggle, contentId }}>
      <span
        ref={ref}
        className={cn("relative inline-flex", className)}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse" && !pinned) setOpen(true);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse" && !pinned) setOpen(false);
        }}
        {...props}
      >
        {children}
      </span>
    </PopoverContext.Provider>
  );
}

const PopoverTrigger = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, onClick, ...props }, ref) => {
    const { open, toggle, contentId } = usePopover("PopoverTrigger");
    return (
      <button
        ref={ref}
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        data-state={open ? "open" : "closed"}
        className={cn(
          "inline-flex items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
        onClick={(e) => {
          onClick?.(e);
          if (!e.defaultPrevented) toggle();
        }}
        {...props}
      />
    );
  },
);
PopoverTrigger.displayName = "PopoverTrigger";

const PopoverContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { open, contentId } = usePopover("PopoverContent");
    // Always in the DOM (server-rendered, toggled with `hidden`): the text is there for
    // assistive tech and for a no-JS read; `pt-1` (not a margin) keeps the pointer inside the
    // wrapper while moving from the trigger onto the content.
    return (
      <div className="absolute left-0 top-full z-50 pt-1" hidden={!open}>
        <div
          ref={ref}
          id={contentId}
          role="dialog"
          data-state={open ? "open" : "closed"}
          className={cn(
            "w-72 rounded-md border bg-popover p-3 text-sm font-normal text-popover-foreground shadow-md outline-none",
            className,
          )}
          {...props}
        />
      </div>
    );
  },
);
PopoverContent.displayName = "PopoverContent";

export { Popover, PopoverTrigger, PopoverContent };
