/**
 * Dev-only shim so the web frontend can boot in a plain browser (e.g. Vite
 * preview, design review) when the Tauri runtime is absent. It provides
 * permissive defaults for the IPC calls the UI makes on mount so the shell and
 * tabs render in a disconnected state. It is a no-op inside the real Tauri app
 * and is tree-shaken out of production builds (guarded by import.meta.env.DEV
 * at the call site in main.tsx).
 */
type Handler = (event: { event: string; id: number; payload: unknown }) => void;

const DEFAULTS: Record<string, unknown> = {
  get_app_state: {
    vpn_phase: "disconnected",
    shell_phase: "disconnected",
    controller_ip: null,
    connection_mode: null,
    local_serial_device: null,
  },
  get_diagnostic_state: { system: null },
  // List commands must return arrays — the UI maps over them on render.
  list_serial_devices: [],
  discover_controllers: [],
  // Preview default: all connection dependencies present (the common case).
  // Flip an `installed` to false here to preview the missing-dependency notice.
  check_dependencies: [
    { id: "minicom", label: "minicom", method: "serial", installed: true, install_hint: "brew install minicom", found_path: "/opt/homebrew/bin/minicom" },
    { id: "ssh", label: "OpenSSH (ssh)", method: "network", installed: true, install_hint: "Install the OpenSSH client", found_path: "/usr/bin/ssh" },
    { id: "openvpn", label: "OpenVPN", method: "vpn", installed: true, install_hint: "brew install openvpn", found_path: "/opt/homebrew/sbin/openvpn" },
  ],
};

export function installBrowserTauriShim(): void {
  if (typeof window === "undefined") return;
  if ("__TAURI_INTERNALS__" in window) return; // real Tauri present

  let listenerId = 0;
  const noopUnlisten = async () => {};

  const invoke = async (cmd: string, _args?: unknown): Promise<unknown> => {
    // Event plugin used by `listen` / window close hooks — resolve quietly.
    if (cmd.startsWith("plugin:event|")) return listenerId++;
    if (cmd in DEFAULTS) return DEFAULTS[cmd];
    // Everything else: resolve to a benign empty value.
    return null;
  };

  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb: Handler) => {
      const id = listenerId++;
      (window as unknown as Record<string, unknown>)[`_${id}`] = cb;
      return id;
    },
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    plugins: { path: { sep: "/", delimiter: ":" } },
  };

  // Some builds read the older global too.
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { event: { listen: () => noopUnlisten } };

  // eslint-disable-next-line no-console
  console.info("[browserTauriShim] Tauri runtime not found — running UI in disconnected preview mode.");
}
