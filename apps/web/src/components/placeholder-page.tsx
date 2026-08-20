/**
 * Stands in for screens whose backend arrives in a later phase.
 *
 * Named honestly and stating which phase delivers it, so nobody mistakes an
 * empty screen for a broken one.
 */
export function PlaceholderPage({
  title,
  phase,
  description,
}: {
  title: string;
  phase: string;
  description: string;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
      <h2 className="text-lg font-medium text-slate-900">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">{description}</p>
      <span className="mt-4 inline-block rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
        Arrives in {phase}
      </span>
    </div>
  );
}
