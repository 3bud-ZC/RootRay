/**
 * React fiber introspection — a best-effort *hint layer* only.
 *
 * React 19 removed `_debugSource`; `_debugOwner`/`_debugStack` still exist
 * in development builds but are private and volatile. Everything here is
 * feature-detected, depth-capped and failure-silent: a changed fiber shape
 * degrades to `undefined`, never an exception inside the inspected app.
 *
 * This never fabricates source locations — it can only enrich a selection
 * with a component name when DOM instrumentation did not carry one.
 */

/** React attaches one of these own-keys to every DOM node it renders. */
const FIBER_KEY = /^__reactFiber\$|^__reactContainer\$/;
const MAX_DEPTH = 64;
const MAX_NAME = 128;

type AnyFiber = {
  type?: unknown;
  _debugOwner?: unknown;
  return?: unknown;
  [key: string]: unknown;
};

function fiberOf(el: Element): AnyFiber | null {
  try {
    const key = Object.keys(el).find((k) => FIBER_KEY.test(k));
    if (!key) return null;
    const f = (el as unknown as Record<string, unknown>)[key];
    return f && typeof f === "object" ? (f as AnyFiber) : null;
  } catch {
    return null;
  }
}

function typeName(t: unknown): string | undefined {
  if (typeof t === "function") {
    const f = t as { displayName?: unknown; name?: unknown };
    const n = f.displayName ?? f.name;
    return typeof n === "string" && n.length > 0 ? n.slice(0, MAX_NAME) : undefined;
  }
  if (t && typeof t === "object") {
    // forwardRef / memo wrappers expose displayName on the wrapper.
    const n = (t as { displayName?: unknown }).displayName;
    if (typeof n === "string" && n.length > 0) return n.slice(0, MAX_NAME);
  }
  return undefined;
}

/**
 * Nearest named component that authored this element, walking the dev-only
 * `_debugOwner` chain (falls back to `return` so non-dev owners still work).
 * `undefined` when React internals are absent or carry no name.
 */
export function fiberComponentName(el: Element): string | undefined {
  const fiber = fiberOf(el);
  if (!fiber) return undefined;
  // The fiber's own type is the host tag ("div") — ownership starts at
  // _debugOwner (the component whose JSX wrote it).
  let cursor: unknown = fiber._debugOwner ?? fiber.return;
  for (let depth = 0; depth < MAX_DEPTH && cursor && typeof cursor === "object"; depth++) {
    const f = cursor as AnyFiber;
    const name = typeName(f.type);
    if (name) return name;
    cursor = f._debugOwner ?? f.return;
  }
  return undefined;
}
