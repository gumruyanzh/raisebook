/** A quiet "from research" mark beside a value research filled in (R7). */
export function FromResearch({ fields, of }: { fields: readonly string[] | undefined; of: readonly string[] }) {
  if (!fields || !of.some((f) => fields.includes(f))) return null;
  return (
    <span className="t-micro ml-6 whitespace-nowrap text-muted" title="Filled in by research. Check it before you use it; edit it and the mark goes away.">
      from research
    </span>
  );
}
