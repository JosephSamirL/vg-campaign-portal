import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatInt, formatUtcDate } from "@/lib/format";

export type SignupsChartProps = {
  label: string;
  days: { day: string; signups: number }[];
  window_start: string;
  window_end: string;
  future_dated_count: number;
  last_signup_at: string | null;
  caption: React.ReactNode;
};

// Plot geometry (SVG user units). 30 slots; bars are thinner than the slot so the gaps read.
const SLOT = 20;
const BAR = 14;
const PLOT_H = 120;
const PAD_TOP = 8;
const PAD_LEFT = 36;
const AXIS_H = 20;
const WIDTH = PAD_LEFT + SLOT * 30;
const HEIGHT = PAD_TOP + PLOT_H + AXIS_H;

/**
 * Signups per UTC day over the view's 30-day window, as an inline SVG bar chart — no charting
 * library (one series, thirty bars: a dependency would cost more bundle than it saves). Bar
 * height ∝ `signups / max(1, max)`; a `<title>` per bar is the hover/screen-reader label; x
 * labels every fifth day as `dd MMM` in UTC (PRD §5). Dates come straight from the view:
 * the window label prints `window_start`/`window_end` as-is with "(UTC)" so nobody's locale
 * shifts a day. An all-zero window renders the empty-but-real sentence instead of thirty
 * invisible bars (AC4) — muted, never an alert.
 */
export function SignupsChart({ label, days, window_start, window_end, future_dated_count, last_signup_at, caption }: SignupsChartProps) {
  const total = days.reduce((sum, d) => sum + d.signups, 0);
  const max = Math.max(1, ...days.map((d) => d.signups));

  return (
    <Card data-testid="signups-chart" data-state={total === 0 ? "empty" : "ok"}>
      <CardHeader className="flex flex-col gap-1 p-4 pb-2 sm:flex-row sm:items-baseline sm:justify-between">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <span className="text-xs tabular-nums text-muted-foreground" data-testid="chart-window">
          {window_start} – {window_end} (UTC)
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-4 pt-0">
        {total === 0 ? (
          <p className="py-6 text-sm text-muted-foreground" role="status" data-testid="chart-empty">
            {`0 signups in the last 30 days — ${last_signup_at ? `last signup ${formatDate(last_signup_at)}` : "no signups on record"}`}
          </p>
        ) : (
          // `w-full min-w-0`: the SVG scales to the card at 400 px instead of forcing a page-wide scroll
          // (Story 7.1, AC1); the axis text would shrink below legibility there, so it is hidden below `sm`
          // — every bar keeps its `<title>` and the `aria-label` carries the totals.
          <div className="w-full min-w-0" data-testid="chart-box">
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              className="h-auto w-full"
              role="img"
              aria-label={`${formatInt(total)} signups between ${window_start} and ${window_end} (UTC), busiest day ${formatInt(max)}`}
            >
              {/* recessive baseline + max tick */}
              <line x1={PAD_LEFT} x2={WIDTH} y1={PAD_TOP + PLOT_H} y2={PAD_TOP + PLOT_H} className="stroke-border" strokeWidth={1} />
              <line x1={PAD_LEFT} x2={WIDTH} y1={PAD_TOP} y2={PAD_TOP} className="stroke-border" strokeWidth={1} strokeDasharray="2 3" />
              <text x={PAD_LEFT - 6} y={PAD_TOP + 4} textAnchor="end" className="hidden fill-muted-foreground text-[10px] sm:block" data-axis="y">
                {formatInt(max)}
              </text>
              <text x={PAD_LEFT - 6} y={PAD_TOP + PLOT_H} textAnchor="end" className="hidden fill-muted-foreground text-[10px] sm:block" data-axis="y">
                0
              </text>
              {days.map((d, i) => {
                const h = (PLOT_H * d.signups) / max;
                const x = PAD_LEFT + i * SLOT + (SLOT - BAR) / 2;
                return (
                  <g key={d.day}>
                    <rect
                      data-day={d.day}
                      x={x}
                      y={PAD_TOP + PLOT_H - h}
                      width={BAR}
                      height={h}
                      rx={h > 0 ? 2 : 0}
                      className="fill-chart-1"
                    >
                      <title>{`${d.day}: ${d.signups}`}</title>
                    </rect>
                    {i % 5 === 0 && (
                      <text x={x + BAR / 2} y={HEIGHT - 6} textAnchor="middle" className="hidden fill-muted-foreground text-[10px] sm:block" data-axis="x">
                        {formatUtcDate(d.day)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        )}
        {future_dated_count > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="future-dated">
            {`${formatInt(future_dated_count)} future-dated signups excluded`}
          </p>
        )}
        {caption}
      </CardContent>
    </Card>
  );
}
