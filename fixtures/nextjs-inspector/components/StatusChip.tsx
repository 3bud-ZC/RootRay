"use client";

export function StatusChip({ label }: { label: string }) {
  return <span className="rounded bg-slate-100 px-2 py-1 text-sm">{label}</span>;
}
