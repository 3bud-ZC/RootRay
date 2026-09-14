/**
 * Shared types between the RootRay native core (Rust) and the desktop frontend.
 * These mirror the serialized shapes produced by `rootray-core`.
 */

export type Framework = "vite-react" | "vite" | "unknown";

export type PackageManager = "pnpm" | "npm" | "yarn" | "unknown";

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

export interface ProjectCapabilities {
  canRun: boolean;
  inspectorCompatible: boolean;
}

export interface ProjectAnalysis {
  root: string;
  projectName: string | null;
  supported: boolean;
  framework: Framework;
  packageManager: PackageManager;
  devCommand: DevCommand | null;
  packageJsonPath: string | null;
  devScript: string | null;
  reasons: string[];
  capabilities: ProjectCapabilities;
}

export interface RuntimeState {
  phase: RuntimePhase;
  project: ProjectAnalysis | null;
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
  | "PROCESS_ALREADY_RUNNING"
  | "PROCESS_NOT_RUNNING"
  | "PROCESS_START_FAILED"
  | "PROCESS_EXITED"
  | "LOCAL_URL_NOT_DETECTED"
  | "PROJECT_OUTSIDE_ALLOWED_ROOT"
  | "LAUNCHER_NOT_FOUND"
  | "ILLEGAL_STATE_TRANSITION"
  | "SETTINGS_IO"
  | "INTERNAL";

/** Payload of the `rootray://process-event` Tauri event. */
export type ProcessEventPayload =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "url-detected"; url: string; port: number }
  | { kind: "url-timeout" }
  | { kind: "exited"; code: number | null; clean: boolean }
  | { kind: "start-failed"; message: string };
