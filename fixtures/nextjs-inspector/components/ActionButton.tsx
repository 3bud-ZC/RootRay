"use client";

import { useState } from "react";
import styles from "./ActionButton.module.css";

export function ActionButton() {
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      className={styles.actionButton}
      onClick={() => setCount((c) => c + 1)}
    >
      Count is {count}
    </button>
  );
}
