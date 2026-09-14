import type { CoreErrorPayload } from "./types.js";

/** Type guard for errors surfaced by native commands. */
export function isCoreError(value: unknown): value is CoreErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof (value as CoreErrorPayload).code === "string" &&
    typeof (value as CoreErrorPayload).message === "string"
  );
}

/** Extracts a human-readable message from any thrown value. */
export function errorMessage(value: unknown): string {
  if (isCoreError(value)) return value.message;
  if (value instanceof Error) return value.message;
  return String(value);
}
