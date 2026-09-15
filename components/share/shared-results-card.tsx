import { renderRuleText } from "@/components/metrics/metric-caption";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { Json } from "@/lib/database.types";
import { formatDateTime, formatInt, formatPercent } from "@/lib/format";

/**
 * The one campaign's aggregates as `get_shared_results` returned them (Story 5.3, AC4). Props are
 * the RPC row and nothing else: this component never calls Supabase, so the same card can sit on
 * the owner's page later. Every field it prints is listed below by name — an `id`, `brand_id`,
 * `campaign_id` or `spend` that somehow reached the props would never render. Rates are the
 * view's numbers as-is (`open_rate` may exceed 100 %; its caption says so) and `null` is a dash,
 * never a zero. Captions come from `data.captions` (the `metric_rules` text, D-5) beside each rate.
 */

/** The `ok` row, as the RPC declares it — every column nullable because the RPC's own type is looser than the generated one. */
export type SharedResultsRow = {
  campaign_name: string | null;
  channel: string | null;
  sent_at: string | null;
  reported_sent: number | null;
  reported_delivered: number | null;
  reported_bounced: number | null;
  reported_opens: number | null;
  reported_clicks: number | null;
  delivered_rate: number | null;
  bounce_rate: number | null;
  open_rate: number | null;
  click_rate: number | null;
  unsubscribe_rate: number | null;
  captions: Json | null;
};

const COUNTS = [
  ["reported_sent", "Sent"],
  ["reported_delivered", "Delivered"],
  ["reported_bounced", "Bounced"],
  ["reported_opens", "Opens"],
  ["reported_clicks", "Clicks"],
] as const;

const RATES = [
  ["delivered_rate", "Delivered rate"],
  ["bounce_rate", "Bounce rate"],
  ["open_rate", "Open rate"],
  ["click_rate", "Click rate"],
  ["unsubscribe_rate", "Unsubscribe rate"],
] as const;

/** `captions` is `jsonb`; only string values under known keys are used, anything else is ignored. */
function captionsOf(json: Json | null | undefined): Record<string, string> {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(json)) if (typeof value === "string") out[key] = value;
  return out;
}

function count(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? formatInt(value) : "—";
}

export function SharedResultsCard({ data }: { data: SharedResultsRow }) {
  const captions = captionsOf(data.captions);
  const source = captions.source ?? "as reported by the source";

  return (
    <Card data-testid="shared-results-card">
      <CardHeader>
        <CardTitle className="text-2xl">{data.campaign_name ?? "—"}</CardTitle>
        <CardDescription>
          <span data-testid="shared-channel">{data.channel ?? "—"}</span>
          {" · sent "}
          <time dateTime={data.sent_at ?? undefined}>{formatDateTime(data.sent_at)}</time>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
          {COUNTS.map(([key, label]) => (
            <div key={key} className="flex flex-col gap-1" data-testid={`count-${key}`}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-xl font-semibold tabular-nums">{count(data[key])}</dd>
            </div>
          ))}
        </dl>
        <dl className="grid gap-4 sm:grid-cols-2">
          {RATES.map(([key, label]) => (
            <div key={key} className="flex flex-col gap-1 rounded-lg border p-3" data-testid={`rate-${key}`}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-xl font-semibold tabular-nums">{formatPercent(data[key])}</dd>
              {captions[key] && (
                <dd className="text-xs leading-relaxed text-muted-foreground">{renderRuleText(captions[key])}</dd>
              )}
            </div>
          ))}
        </dl>
      </CardContent>
      <CardFooter>
        <p className="text-xs text-muted-foreground" data-testid="shared-source">
          {source}
        </p>
      </CardFooter>
    </Card>
  );
}
