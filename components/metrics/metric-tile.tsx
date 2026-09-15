import { RetryAlert } from "@/components/layout/retry-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatInt } from "@/lib/format";

export type MetricTileProps = { label: string; caption: React.ReactNode } & (
  | { state: "ok"; value: number }
  | { state: "empty"; value: number; sentence: string }
  | { state: "error"; message: string }
);

/**
 * One headline number with its rule underneath. Three visually distinct states (D-12): a
 * number; a number with a muted sentence that proves the query ran; a destructive alert with
 * Retry and NO number — a failed query is never rendered as `0`.
 */
export function MetricTile(props: MetricTileProps) {
  const { label, caption } = props;
  return (
    <Card data-testid="metric-tile" data-state={props.state} className="flex flex-col">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2 p-4 pt-0">
        {props.state === "error" ? (
          <RetryAlert title={`${label} could not be read`} message={props.message} />
        ) : (
          <>
            <p className="text-3xl font-semibold tabular-nums tracking-tight" data-testid="metric-value">
              {formatInt(props.value)}
            </p>
            {props.state === "empty" && (
              <p className="text-sm text-muted-foreground" role="status">
                {props.sentence}
              </p>
            )}
            {caption}
          </>
        )}
      </CardContent>
    </Card>
  );
}
