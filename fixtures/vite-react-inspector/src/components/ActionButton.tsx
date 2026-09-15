import { useState } from "react";
import "../styles/button.css";

export function ActionButton() {
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      className="action-button primary"
      onClick={() => setCount((c) => c + 1)}
    >
      Count is {count}
    </button>
  );
}
