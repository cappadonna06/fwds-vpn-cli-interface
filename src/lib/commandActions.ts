import { invoke } from "@tauri-apps/api/core";

export async function copyCommandText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export async function sendCommandText(text: string): Promise<void> {
  await invoke("send_external_input", { text });
}
