/**
 * Component intelligence — lazy, bounded, cacheable, invalidatable.
 *
 * First request → native bounded source collection → `@rootray/intelligence`
 * static analysis (lazy-imported so the parser stays out of the main
 * bundle) → cached snapshot.
 *
 * Any source change — a RootRay save, a clean auto-reload, an external
 * modification — invalidates the snapshot; the next request rebuilds.
 * Nothing watches or indexes the project continuously.
 */

import type { ComponentDef, ProjectIntel, SourceRef } from "@rootray/intelligence";
import { collectSourceFiles } from "../../lib/ipc";

let cache: { root: string; intel: ProjectIntel } | null = null;
let inflight: Promise<ProjectIntel> | null = null;

/** Lazy snapshot — analyzes at most once per invalidation. */
export async function getIntel(root: string): Promise<ProjectIntel> {
  if (cache && cache.root === root) return cache.intel;
  if (inflight) return inflight;
  inflight = (async () => {
    const [{ analyzeSources }, coll] = await Promise.all([
      import("@rootray/intelligence"),
      collectSourceFiles(),
    ]);
    const intel = analyzeSources(
      coll.files.map((f) => ({ relativePath: f.relativePath, content: f.content })),
    );
    cache = { root, intel };
    inflight = null;
    return intel;
  })().catch((e) => {
    inflight = null;
    throw e;
  });
  return inflight;
}

/** Called whenever project source may have changed. */
export function invalidateIntel(): void {
  cache = null;
}

export interface ComponentSummary {
  def: ComponentDef | null;
  usedBy: SourceRef[];
  truncated: boolean;
}

/**
 * Resolve one component's definition + resolved callers through the
 * lazily-loaded analyzer — callers stay chunk-split from the parser.
 */
export async function describeComponent(
  root: string,
  name: string,
  path: string,
): Promise<ComponentSummary> {
  const [mod, intel] = await Promise.all([import("@rootray/intelligence"), getIntel(root)]);
  const def = mod.findComponent(intel, name, path);
  return {
    def,
    usedBy: def ? mod.usagesOf(intel, def).map((u) => u.usedIn) : [],
    truncated: intel.truncated,
  };
}
