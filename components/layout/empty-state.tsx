/**
 * The portal's "nothing here" state (architecture "Process patterns"): a title, exactly one
 * muted sentence, and optionally a call to action. Visually distinct from the skeleton
 * (`loading.tsx`) and from the destructive alert (`error.tsx`) so an empty list is never
 * mistaken for a failed query or a page still loading.
 */
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-6" data-testid="empty-state" role="status">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
      {children}
    </div>
  );
}
