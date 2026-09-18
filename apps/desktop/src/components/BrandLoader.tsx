/**
 * Branded indeterminate indicator: mascot + scanning ray.
 * For genuine longer operations only (analyze, server start, preview
 * connect). The global prefers-reduced-motion rule freezes the sweep.
 */
export function BrandLoader({ label }: { label?: string }) {
  return (
    <output className="brand-loader" aria-label={label ?? "Loading"}>
      <img className="brand-loader-img brand-img" src="/brand/mascot.png" alt="" />
      <span className="brand-loader-track" aria-hidden />
      {label && <span className="brand-loader-label">{label}</span>}
    </output>
  );
}
