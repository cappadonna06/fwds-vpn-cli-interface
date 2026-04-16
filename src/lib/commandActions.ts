import { invoke } from "@tauri-apps/api/core";

interface AppStateSnapshot {
  connection_mode?: string;
}

export async function copyCommandText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export async function sendCommandText(text: string): Promise<void> {
  const isWindows = typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
  if (isWindows) {
    try {
      const appState = await invoke<AppStateSnapshot>("get_app_state");
      if (appState.connection_mode === "vpn") {
        await invoke("send_input", { text });
        return;
      }
    } catch {
      // fall through to external send path
    }
  }
  await invoke("send_external_input", { text });
}
