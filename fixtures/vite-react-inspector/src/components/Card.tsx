import type { ReactNode } from "react";
import { ActionButton } from "./ActionButton";
import "../styles/card.css";

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2 className="card-title">{title}</h2>
      {children}
      <input className="card-input" placeholder="Type here" />
      <ActionButton />
      <ActionButton />
    </section>
  );
}
