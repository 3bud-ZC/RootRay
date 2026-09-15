/**
 * Recent files per project — a small localStorage list of
 * project-relative paths only. No contents, no database.
 */

const CAP = 10;

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function key(root: string): string {
  return `rootray:recentFiles:${root}`;
}

export function getRecentFiles(
  root: string,
  store: KeyValueStore | undefined = globalThis.localStorage,
): string[] {
  if (!store) return [];
  try {
    const raw = store.getItem(key(root));
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((x): x is string => typeof x === "string").slice(0, CAP);
  } catch {
    return [];
  }
}

export function pushRecentFile(
  root: string,
  relativePath: string,
  store: KeyValueStore | undefined = globalThis.localStorage,
): void {
  if (!store) return;
  try {
    const list = [relativePath, ...getRecentFiles(root, store).filter((p) => p !== relativePath)];
    store.setItem(key(root), JSON.stringify(list.slice(0, CAP)));
  } catch {
    /* storage may be unavailable — recents are best-effort */
  }
}
