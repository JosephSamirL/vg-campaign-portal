import { Info } from "lucide-react";
import { MetricCaption } from "@/components/metrics/metric-caption";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import type { ContactRow, MetricRule } from "@/lib/queries/contacts";

function Unknown() {
  return <span className="text-muted-foreground">unknown</span>;
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

type Props = { rows: ContactRow[]; contactableRule: MetricRule | null };

/**
 * One page of contacts, exactly as `v_contacts` returned it — `contactable` is the view's
 * column (D-4/D-5), never recomputed here. A null status or consent is rendered as the word
 * "unknown" (muted), not as a blank that could be mistaken for "no". The "Contactable" header
 * carries the rule text (`MetricCaption`, Story 3.2 — `rule_text` from `metric_rules`, D-5) in
 * a popover that opens on hover and on tap (AC3). The `Table` primitive wraps the table in its
 * own `overflow-x-auto` container (AC7); the `min-w-[960px]` keeps nine columns readable and makes
 * the container — never the page — the thing that scrolls at 400 px (Story 7.1).
 */
export function ContactsTable({ rows, contactableRule }: Props) {
  return (
    <Table data-testid="contacts-table" className="min-w-[960px]">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Phone</TableHead>
          <TableHead>Country</TableHead>
          <TableHead>City</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Consent</TableHead>
          <TableHead>
            <span className="inline-flex items-center gap-1">
              Contactable
              <Popover>
                <PopoverTrigger aria-label="How contactable is counted">
                  <Info className="h-3.5 w-3.5" aria-hidden />
                </PopoverTrigger>
                <PopoverContent className="w-80">
                  {contactableRule ? (
                    <MetricCaption rule={contactableRule} showAlternative />
                  ) : (
                    // The rule row could not be read: say so — never a hard-coded rule (D-5).
                    <p className="text-xs text-muted-foreground" data-testid="contactable-rule-missing">
                      The rule text could not be loaded. Reload the page to try again.
                    </p>
                  )}
                </PopoverContent>
              </Popover>
            </span>
          </TableHead>
          <TableHead>Signed up</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id ?? row.external_id ?? row.email ?? undefined}>
            <TableCell className="whitespace-nowrap font-medium">{row.full_name || <Dash />}</TableCell>
            <TableCell className="whitespace-nowrap">{row.email || <Dash />}</TableCell>
            <TableCell className="whitespace-nowrap tabular-nums">{row.phone || <Dash />}</TableCell>
            <TableCell>{row.country || <Dash />}</TableCell>
            <TableCell className="whitespace-nowrap">{row.city || <Dash />}</TableCell>
            <TableCell data-testid="status">{row.status === null ? <Unknown /> : row.status}</TableCell>
            <TableCell data-testid="consent">
              {row.consent_marketing === null ? <Unknown /> : row.consent_marketing ? "Yes" : "No"}
            </TableCell>
            <TableCell>
              {row.contactable === null ? (
                <Unknown />
              ) : (
                <Badge variant={row.contactable ? "default" : "outline"} data-testid="contactable">
                  {row.contactable ? "Yes" : "No"}
                </Badge>
              )}
            </TableCell>
            <TableCell className="whitespace-nowrap tabular-nums">{formatDate(row.signup_at)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
