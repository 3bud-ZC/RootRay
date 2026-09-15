/**
 * Typed wrappers over the narrow Tauri command surface.
 * There is intentionally no generic shell/execute — every call maps to a
 * specific, input-validated native command.
 */

import type {
  DetectedLauncher,
  DirListing,
  EditorSessionInfo,
  FileListing,
  InspectorState,
  ProjectAnalysis,
  RootRaySettings,
  RuntimeState,
  SourceCollection,
  SourceFileHash,
  SourceFileRead,
  SourceFileWrite,
  SourcePreview,
  WorkspaceSearchResult,
} from "@rootray/shared";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export async function pickProjectDirectory(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title: "Open project" });
  return typeof selected === "string" ? selected : null;
}

export const analyzeProject = (path: string) =>
  invoke<ProjectAnalysis>("analyze_project", { path });

export const startDevServer = (inspector = false) =>
  invoke<number>("start_dev_server", { inspector });

export const stopDevServer = () => invoke<void>("stop_dev_server");

export const restartDevServer = (inspector = false) =>
  invoke<number>("restart_dev_server", { inspector });

export const getRuntimeState = () => invoke<RuntimeState>("get_runtime_state");

export const openBrowser = (url: string) => invoke<void>("open_browser", { url });

export const detectEditors = () => invoke<DetectedLauncher[]>("detect_editors");

export const openInEditor = (launcherId: string, path?: string) =>
  invoke<void>("open_in_editor", { launcherId, path: path ?? null });

export const openSourceLocation = (
  launcherId: string,
  relativePath: string,
  line: number,
  column: number,
) => invoke<void>("open_source_location", { launcherId, relativePath, line, column });

// --- inspector ---------------------------------------------------------------

export const getInspectorState = () => invoke<InspectorState>("get_inspector_state");

export const setInspection = (enabled: boolean) => invoke<void>("set_inspection", { enabled });

export const clearInspectorSelection = () => invoke<void>("clear_inspector_selection");

export const readSourcePreview = (relativePath: string, line: number) =>
  invoke<SourcePreview>("read_source_preview", { relativePath, line });

// --- quick editor --------------------------------------------------------------
//
// All paths are project-relative; the native layer re-validates them against
// the selected project root on every call.

export const openSourceEditor = (relativePath: string) =>
  invoke<SourceFileRead>("open_source_editor", { relativePath });

export const saveSourceFile = (relativePath: string, content: string, expectedHash: string) =>
  invoke<SourceFileWrite>("save_source_file", {
    relativePath,
    content,
    expectedHash,
  });

export const checkSourceFile = (relativePath: string) =>
  invoke<SourceFileHash>("check_source_file", { relativePath });

export const reloadSourceFile = (relativePath: string) =>
  invoke<SourceFileRead>("reload_source_file", { relativePath });

export const revertSourceSave = (relativePath: string) =>
  invoke<SourceFileRead>("revert_source_save", { relativePath });

/** Read-only fetch that leaves the edit session untouched — conflict compare. */
export const peekSourceFile = (relativePath: string) =>
  invoke<SourceFileRead>("peek_source_file", { relativePath });

export const closeSourceEditor = () => invoke<void>("close_source_editor");

export const getEditorState = () => invoke<EditorSessionInfo>("get_editor_state");

// --- project navigation --------------------------------------------------------
//
// Read-only, root-bounded navigation: lazy dir listing for the explorer,
// a bounded file list for Quick Open, bounded text search, and the
// bounded source collection that feeds component intelligence.

export const listProjectDir = (relativeDir: string) =>
  invoke<DirListing>("list_project_dir", { relativeDir });

export const listProjectFiles = () => invoke<FileListing>("list_project_files");

export const searchWorkspace = (query: string) =>
  invoke<WorkspaceSearchResult>("search_workspace", { query });

export const collectSourceFiles = () => invoke<SourceCollection>("collect_source_files");

export const getSettings = () => invoke<RootRaySettings>("get_settings");

export interface SettingsPatch {
  preferredLauncher?: string;
  openBrowserAutomatically?: boolean;
  clearRecentProjects?: boolean;
  removeRecentProject?: string;
}

export const updateSettings = (update: SettingsPatch) =>
  invoke<RootRaySettings>("update_settings", { update });

export interface DiagnosticsInfo {
  version: string;
  os: string;
  arch: string;
}

export const getDiagnostics = () => invoke<DiagnosticsInfo>("get_diagnostics");
