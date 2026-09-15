import { Card } from "./components/Card";
import { Navbar } from "./components/Navbar";
import "./styles/app.css";

export function App() {
  return (
    <main className="app-main">
      <Navbar />
      <Card title="Inspector fixture">
        <p>Nested text inside a card, rendered from another file.</p>
      </Card>
    </main>
  );
}
