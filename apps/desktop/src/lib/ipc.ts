/**
 * Typed wrappers over the narrow Tauri command surface.
 * There is intentionally no generic shell/execute — every call maps to a
 * specific, input-validated native command.
 */

import type {
  DetectedLauncher,
  ProjectAnalysis,
  RootRaySettings,
  RuntimeState,
} from "@rootray/shared";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export async function pickProjectDirectory(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title: "Open project" });
  return typeof selected === "string" ? selected : null;
}

export const analyzeProject = (path: string) =>
  invoke<ProjectAnalysis>("analyze_project", { path });

export const startDevServer = () => invoke<number>("start_dev_server");

export const stopDevServer = () => invoke<void>("stop_dev_server");

export const restartDevServer = () => invoke<number>("restart_dev_server");

export const getRuntimeState = () => invoke<RuntimeState>("get_runtime_state");

export const openBrowser = (url: string) => invoke<void>("open_browser", { url });

export const detectEditors = () => invoke<DetectedLauncher[]>("detect_editors");

export const openInEditor = (launcherId: string, path?: string) =>
  invoke<void>("open_in_editor", { launcherId, path: path ?? null });

export const getSettings = () => invoke<RootRaySettings>("get_settings");

export interface SettingsPatch {
  preferredLauncher?: string;
  openBrowserAutomatically?: boolean;
  clearRecentProjects?: boolean;
  removeRecentProject?: string;
}

export const updateSettings = (update: SettingsPatch) =>
  invoke<RootRaySettings>("update_settings", { update });
