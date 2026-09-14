import type { ReactNode } from "react";
import { ActionButton } from "./ActionButton";

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ border: "1px solid #ccc", borderRadius: 8, padding: "1rem", marginTop: "1rem" }}>
      <h2>{title}</h2>
      {children}
      <input placeholder="Type here" />
      <ActionButton />
    </section>
  );
}
