/**
 * Shared types between the RootRay native core (Rust) and the desktop frontend.
 * These mirror the serialized shapes produced by `rootray-core`.
 */

/**
 * Frameworks RootRay identifies for a target. Extensible — new frameworks
 * are added here as their detection lands; absence of a runtime adapter
 * is expressed through capabilities, not through the framework value.
 */
export type Framework =
  | "next-js"
  | "vite-react"
  | "vite"
  | "vue-vite"
  | "svelte-vite"
  | "sveltekit"
  | "astro"
  | "nuxt"
  | "angular"
  | "remotion"
  | "static-web"
  | "node-web"
  | "unknown";

export type PackageManager = "pnpm" | "npm" | "yarn" | "unknown";

/** How the selected directory is organized. */
export type WorkspaceKind =
  | "single-package"
  | "npm-workspace"
  | "pnpm-workspace"
  | "yarn-workspace"
  | "unknown-multi-package"
  | "no-manifest";

/** What a discovered target is — evidence-based, not folder-name-based. */
export type TargetKind = "web-app" | "server" | "library" | "tool" | "static-web" | "unknown";

export type RuntimePhase =
  | "idle"
  | "analyzing"
  | "ready"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface DevCommand {
  executable: string;
  args: string[];
  display: string;
}

/** Richer than boolean — every non-available capability carries a reason. */
export type CapabilityState = "available" | "partial" | "unavailable" | "not-applicable";

export interface Capability {
  state: CapabilityState;
  reason?: string;
}

/** The full capability surface of a target or workspace. */
export interface CapabilityMatrix {
  workspaceBrowse: Capability;
  workspaceSearch: Capability;
  quickOpen: Capability;
  quickEdit: Capability;
  safeWrite: Capability;
  openExternal: Capability;
  run: Capability;
  browserOpen: Capability;
  domInspect: Capability;
  styleInspect: Capability;
  sourceMapping: Capability;
  componentIntelligence: Capability;
  hmrAware: Capability;
}

/** A technology identified from real project metadata. */
export interface Technology {
  name: string;
  /** Declared version from the manifest — never guessed. */
  version: string | null;
  evidence: string[];
}

/** A plausible way to run a target — informational until selected. */
export interface RunnerCandidate {
  scriptName: string;
  display: string;
  confidence: number;
  reason: string;
}

/** One runnable/examinable unit inside the workspace. */
export interface ProjectTarget {
  /** Stable id — the workspace-relative path ("root" for the root target). */
  id: string;
  name: string | null;
  relativeRoot: string;
  /** Canonical absolute root — always inside the workspace root. */
  absoluteRoot: string;
  kind: TargetKind;
  framework: Framework;
  frameworkVersion: string | null;
  languages: string[];
  technologies: Technology[];
  packageManager: PackageManager;
  devScript: string | null;
  runnerCandidates: RunnerCandidate[];
  selectedRunner: DevCommand | null;
  capabilities: CapabilityMatrix;
  evidence: string[];
}

/** Metrics recorded during bounded discovery. */
export interface DiscoveryMetrics {
  dirsVisited: number;
  manifestsRead: number;
  metadataBytes: number;
  targetsFound: number;
  elapsedMs: number;
  truncated: boolean;
}

/**
 * The authoritative workspace snapshot. `root` is the selected directory —
 * workspace root AND filesystem security root. `activeTargetId` picks the
 * target runtime actions act on; it never moves the security boundary.
 */
export interface WorkspaceAnalysis {
  root: string;
  name: string | null;
  workspaceKind: WorkspaceKind;
  packageManager: PackageManager;
  manifests: string[];
  technologies: Technology[];
  targets: ProjectTarget[];
  activeTargetId: string | null;
  capabilities: CapabilityMatrix;
  findings: string[];
  warnings: string[];
  discovery: DiscoveryMetrics;
}

/** Convenience accessor mirroring the Rust `active_target()`. */
export function activeTarget(w: WorkspaceAnalysis): ProjectTarget | null {
  return w.targets.find((t) => t.id === w.activeTargetId) ?? null;
}

export interface RuntimeState {
  phase: RuntimePhase;
  workspace: WorkspaceAnalysis | null;
  pid: number | null;
  command: string | null;
  url: string | null;
  port: number | null;
  startedAt: number | null;
  error: CoreErrorPayload | null;
  recentLogs: LogLine[];
}

export interface LogLine {
  stream: "stdout" | "stderr";
  line: string;
  at: number;
}

export interface DetectedLauncher {
  id: string;
  name: string;
  executablePath: string | null;
  available: boolean;
}

export interface RootRaySettings {
  recentProjects: string[];
  preferredLauncher: string | null;
  openBrowserAutomatically: boolean;
  /** Last successfully analyzed project — restored read-only on launch. */
  lastProject?: string | null;
}

export interface CoreErrorPayload {
  code: CoreErrorCode;
  message: string;
}

export type CoreErrorCode =
  | "INVALID_PROJECT_PATH"
  | "PACKAGE_JSON_NOT_FOUND"
  | "PACKAGE_JSON_INVALID"
  | "UNSUPPORTED_FRAMEWORK"
  | "NO_DEV_SCRIPT"
  | "PACKAGE_MANAGER_UNKNOWN"
  | "NO_PROJECT_SELECTED"
  | "WORKSPACE_TARGET_NOT_FOUND"
  | "TARGET_RUNNER_UNAVAILABLE"
  | "PROCESS_ALREADY_RUNNING"
  | "PROCESS_NOT_RUNNING"
  | "PROCESS_START_FAILED"
  | "PROCESS_EXITED"
  | "LOCAL_URL_NOT_DETECTED"
  | "PROJECT_OUTSIDE_ALLOWED_ROOT"
  | "LAUNCHER_NOT_FOUND"
  | "ILLEGAL_STATE_TRANSITION"
  | "SETTINGS_IO"
  | "INSPECTOR_BRIDGE_START_FAILED"
  | "INSPECTOR_UNAVAILABLE"
  | "INSPECTOR_NOT_ACTIVE"
  | "INSPECTOR_SOURCE_NOT_FOUND"
  | "SOURCE_PREVIEW_FAILED"
  | "EDITOR_OPEN_FAILED"
  | "SOURCE_FILE_NOT_FOUND"
  | "SOURCE_FILE_DENIED"
  | "SOURCE_FILE_TOO_LARGE"
  | "SOURCE_FILE_BINARY"
  | "SOURCE_FILE_ENCODING_UNSUPPORTED"
  | "SOURCE_EDIT_CONFLICT"
  | "SOURCE_EXTERNAL_CHANGE"
  | "SOURCE_WRITE_FAILED"
  | "SOURCE_WRITE_PERMISSION_DENIED"
  | "EDITOR_SESSION_CLOSED"
  | "REVERT_UNAVAILABLE"
  | "PROJECT_TREE_FAILED"
  | "WORKSPACE_SEARCH_FAILED"
  | "INTERNAL";

/** Payload of the `rootray://process-event` Tauri event. */
export type ProcessEventPayload =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "url-detected"; url: string; port: number }
  | { kind: "url-timeout" }
  | { kind: "exited"; code: number | null; clean: boolean }
  | { kind: "start-failed"; message: string };

// --- inspector ------------------------------------------------------------------

export type InspectorPhase =
  | "inactive"
  | "starting"
  | "waiting_for_browser"
  | "connected"
  | "inspecting"
  | "disconnected"
  | "failed";

export interface SourceLocation {
  relativePath: string;
  line: number;
  column: number;
  componentName?: string;
  confidence?: "exact" | "approximate" | "component";
}

export interface ElementFacts {
  tagName: string;
  id?: string;
  className?: string;
  textPreview?: string;
}

// --- style details (selection-time snapshot) --------------------------------

export interface BoxEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface BoxModel {
  x: number;
  y: number;
  width: number;
  height: number;
  margin: BoxEdges;
  padding: BoxEdges;
  border: BoxEdges;
}

export interface CssDeclaration {
  property: string;
  value: string;
  important: boolean;
}

export interface MatchedCssRule {
  selector: string;
  declarations: CssDeclaration[];
  /** Project-relative stylesheet path — only when reliably resolved. */
  sourcePath?: string;
}

export interface StyleDetails {
  classes: string[];
  elementId?: string;
  box: BoxModel;
  computed: Record<string, string>;
  matchedRules: MatchedCssRule[];
}

export interface ElementSelection {
  element: ElementFacts;
  /**
   * Authored source identity — absent when the selected DOM element has
   * no trustworthy mapping (generic DOM inspection of runtime-created
   * nodes). UI must treat a missing source as a normal state, never an
   * error, and must not fabricate one.
   */
  source?: SourceLocation;
  styles?: StyleDetails;
}

/** Snapshot pushed on `rootray://inspector-state`. */
export interface InspectorState {
  phase: InspectorPhase;
  sessionId: string | null;
  port: number | null;
  pageUrl: string | null;
  connectedAt: number | null;
  inspectionEnabled: boolean;
  lastSelection: ElementSelection | null;
  error: CoreErrorPayload | null;
}

export interface SourcePreviewLine {
  n: number;
  text: string;
}

/** Result of the `read_source_preview` command. */
export interface SourcePreview {
  relativePath: string;
  selectedLine: number;
  startLine: number;
  endLine: number;
  lines: SourcePreviewLine[];
}

// --- quick editor ---------------------------------------------------------------

export type SourceLineEnding = "lf" | "crlf";

/** Result of `open_source_editor` / `reload_source_file` / `revert_source_save`. */
export interface SourceFileRead {
  relativePath: string;
  /** LF-normalized file text — the editor works on LF; disk keeps its convention. */
  content: string;
  /** SHA-256 of the raw on-disk bytes — the optimistic-concurrency token. */
  hash: string;
  lineEnding: SourceLineEnding;
  bom: boolean;
  sizeBytes: number;
}

/** Result of `save_source_file`. */
export interface SourceFileWrite {
  relativePath: string;
  hash: string;
}

/** Result of `check_source_file`. */
export interface SourceFileHash {
  relativePath: string;
  hash: string;
  sizeBytes: number;
}

/** Snapshot of the native-side editor session (`get_editor_state`). */
export interface EditorSessionInfo {
  open: boolean;
  relativePath: string | null;
  baseHash: string | null;
  diskHash: string | null;
  watching: boolean;
  canRevert: boolean;
}

/** Payload of the `rootray://editor-event` Tauri event. */
export type EditorEventPayload = {
  kind: "externalChange";
  relativePath: string;
  diskHash: string;
};

/** Frontend-side Quick Edit session status. */
export type EditSessionStatus =
  | "closed"
  | "loading"
  | "clean"
  | "dirty"
  | "saving"
  | "conflict"
  | "save_failed";

/** The UI-owned half of an editing session. */
export interface EditSession {
  relativePath: string;
  /** Text as last read from / written to disk (LF-normalized). */
  diskContent: string;
  /** Current editor text (LF-normalized). */
  currentContent: string;
  /** Hash of `diskContent`'s raw on-disk bytes — sent as expected_hash on save. */
  baseHash: string;
  lineEnding: SourceLineEnding;
  bom: boolean;
  status: EditSessionStatus;
  selectedLine: number | null;
  selectedColumn: number | null;
  canRevert: boolean;
  error: CoreErrorPayload | null;
}

// --- project navigation -------------------------------------------------------

export interface ProjectEntry {
  name: string;
  /** Forward-slash path relative to the project root. */
  relativePath: string;
  kind: "dir" | "file";
  /** True when the file passes the Quick Edit source rules. */
  editable: boolean;
  sizeBytes: number | null;
}

/** Result of `list_project_dir` — one directory level, lazy. */
export interface DirListing {
  relativePath: string;
  entries: ProjectEntry[];
  truncated: boolean;
}

/** Result of `list_project_files` — powers Quick Open. */
export interface FileListing {
  paths: string[];
  truncated: boolean;
}

export interface SearchMatch {
  relativePath: string;
  line: number;
  column: number;
  preview: string;
}

/** Result of `search_workspace`. */
export interface WorkspaceSearchResult {
  query: string;
  matches: SearchMatch[];
  filesScanned: number;
  truncated: boolean;
}

export interface SourceBlob {
  relativePath: string;
  /** LF-normalized text. */
  content: string;
  sizeBytes: number;
}

/** Result of `collect_source_files` — bounded JS/TS sources for analysis. */
export interface SourceCollection {
  files: SourceBlob[];
  truncated: boolean;
  totalBytes: number;
}
