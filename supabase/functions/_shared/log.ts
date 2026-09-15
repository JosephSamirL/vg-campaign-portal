/**
 * One JSON line per step (architecture NFR-7: Edge Function logs are part of the observability surface).
 * Shape: { fn, send_id, step, ok, ms, ...extra } — never the provider key, never a recipient address.
 */
export type LogFields = {
  fn: string;
  send_id: string | null;
  step: string;
  ok: boolean;
  ms: number;
  [key: string]: unknown;
};

export function logStep(fields: LogFields): void {
  console.log(JSON.stringify(fields));
}

/** A stopwatch for `ms`: `const t = stopwatch(); … t()` → elapsed milliseconds (integer). */
export function stopwatch(): () => number {
  const started = performance.now();
  return () => Math.round(performance.now() - started);
}
