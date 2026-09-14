import { useState } from "react";

export function ActionButton() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((c) => c + 1)}>
      Count is {count}
    </button>
  );
}
