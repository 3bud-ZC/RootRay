import { Card } from "./components/Card";
import { Navbar } from "./components/Navbar";

export function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem" }}>
      <Navbar />
      <Card title="Inspector fixture">
        <p>Nested text inside a card, rendered from another file.</p>
      </Card>
    </main>
  );
}
