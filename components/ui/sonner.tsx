"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/*
 * A dependency-free toaster with Sonner's call shape (`toast.success("…")`, `<Toaster />` mounted
 * once in a layout). The shadcn recipe wraps the `sonner` package, which is not installed (same
 * story as tooltip/popover/dialog). D-12: toasts announce outcomes — the portal only ever toasts a
 * success (an expected failure is an inline <Alert> where it happened), so this is deliberately
 * small: a module-level store, `useSyncExternalStore`, one `role="status"` region, auto-dismiss.
 */

export type Toast = { id: number; kind: "success" | "info"; message: string };

const DEFAULT_DURATION_MS = 4000;

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function push(kind: Toast["kind"], message: string, durationMs = DEFAULT_DURATION_MS): number {
  const id = nextId++;
  toasts = [...toasts, { id, kind, message }];
  emit();
  if (typeof window !== "undefined") window.setTimeout(() => dismiss(id), durationMs);
  return id;
}

export function dismiss(id: number) {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

type ToastOptions = { duration?: number };

/** Sonner's call shape: `toast("…")` is the neutral toast, `toast.success` / `toast.info` the marked ones. */
export const toast = Object.assign((message: string, options?: ToastOptions) => push("info", message, options?.duration), {
  success: (message: string, options?: ToastOptions) => push("success", message, options?.duration),
  info: (message: string, options?: ToastOptions) => push("info", message, options?.duration),
  dismiss,
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: Toast[] = [];

/** Mount once (the portal layout). Renders nothing until a toast is pushed. */
function Toaster({ className }: { className?: string }) {
  const items = React.useSyncExternalStore(
    subscribe,
    () => toasts,
    () => EMPTY,
  );
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("pointer-events-none fixed bottom-4 right-4 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2", className)}
      data-testid="toaster"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-start justify-between gap-3 rounded-md border bg-background px-4 py-3 text-sm shadow-lg"
          data-toast={t.kind}
        >
          <span>{t.message}</span>
          <button type="button" aria-label="Dismiss" className="text-muted-foreground hover:text-foreground" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export { Toaster };
