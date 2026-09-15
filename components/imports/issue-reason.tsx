import { reasonCopy } from "@/lib/import-reasons";

/** Reason code → the human sentence from `lib/import-reasons.ts`; an unknown code shows verbatim in monospace. */
export function IssueReason({ code }: { code: string }) {
  const { known, text } = reasonCopy(code);
  return known ? <span>{text}</span> : <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{text}</code>;
}
