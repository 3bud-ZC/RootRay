import { errorMessage } from "@rootray/shared";
import { useEffect, useState } from "react";
import { detectEditors, getSettings, openSourceLocation } from "../../lib/ipc";
import { useStore } from "../../state/store";

/**
 * The user's preferred (or first available) external editor, with an
 * `openAt(relativePath, line, column)` helper. Shared by every place
 * that offers "Open External".
 */
export function usePreferredLauncher() {
  const { dispatch } = useStore();
  const [launcherId, setLauncherId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([detectEditors(), getSettings()])
      .then(([found, settings]) => {
        const preferred = found.find((l) => l.id === settings.preferredLauncher && l.available);
        setLauncherId(preferred?.id ?? found.find((l) => l.available)?.id ?? null);
      })
      .catch(() => {});
  }, []);

  if (!launcherId) return null;
  return {
    id: launcherId,
    openAt: (relativePath: string, line = 1, column = 1) => {
      openSourceLocation(launcherId, relativePath, line, column).catch((e) =>
        dispatch({ type: "notice", message: errorMessage(e) }),
      );
    },
  };
}
