import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import SessionTab from "./components/tabs/SessionTab";
import CommandsTab from "./components/tabs/CommandsTab";
import WizardTab from "./components/tabs/WizardTab";
import LogsTab from "./components/tabs/LogsTab";
import DiagnosticsTab from "./components/tabs/DiagnosticsTab";
import "./App.css";
import "./components/tabs/tabs.css";

type Tab = "session" | "console" | "wizard" | "logs" | "diagnostics";

const TABS: { id: Tab; label: string }[] = [
  { id: "session", label: "Connect" },
  { id: "console", label: "Commands" },
  { id: "wizard", label: "Setup Wizard" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "logs", label: "Logs" },
];

interface AppStatus {
  vpn_phase: string;
  shell_phase: string;
  controller_ip: string | null;
  connection_mode?: string;
  local_serial_device?: string | null;
}
interface HeaderDiagnosticState {
  system?: { sid?: string | null } | null;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("session");
  const [appStatus, setAppStatus] = useState<AppStatus>({
    vpn_phase: "disconnected",
    shell_phase: "disconnected",
    controller_ip: null,
  });
  const [localSid, setLocalSid] = useState<string | null>(null);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    appWindow.onCloseRequested(async () => {
      await invoke("stop_log_watcher").catch(() => {});
    }).then((fn) => {
      unlisten = fn;
    }).catch(() => {});

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  // Poll app-wide status for the header every 2s
  useEffect(() => {
    async function fetchStatus() {
      try {
        const s = await invoke<AppStatus>("get_app_state");
        setAppStatus(s);
        if (s.connection_mode === "local") {
          const diag = await invoke<HeaderDiagnosticState>("get_diagnostic_state");
          setLocalSid(diag.system?.sid ?? null);
        } else {
          setLocalSid(null);
        }
      } catch {
        /* ignore */
      }
    }
    fetchStatus();
    const id = setInterval(fetchStatus, 2000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <span className="app-title-mark">FWDS</span>
          <span className="app-title-sub">Controller Console</span>
        </div>
        <nav className="tab-bar">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="header-status">
          {appStatus.vpn_phase !== "disconnected" && (
            <span className={`badge badge-${appStatus.vpn_phase}`}>VPN</span>
          )}
          {appStatus.connection_mode === "local" && appStatus.local_serial_device && (
            <span className="badge badge-connected">LOCAL {localSid ?? "—"}</span>
          )}
          {appStatus.connection_mode !== "local" && appStatus.controller_ip && (
            <span className="badge badge-connected">CTRL {appStatus.controller_ip}</span>
          )}
        </div>
      </header>

      <main className="app-body">
        <div style={{ display: activeTab === "session" ? "contents" : "none" }}>
          <SessionTab />
        </div>
        <div style={{ display: activeTab === "console" ? "contents" : "none" }}><CommandsTab /></div>
        <div style={{ display: activeTab === "wizard" ? "contents" : "none" }}><WizardTab /></div>
        <div style={{ display: activeTab === "diagnostics" ? "contents" : "none" }}><DiagnosticsTab /></div>
        <div style={{ display: activeTab === "logs" ? "contents" : "none" }}><LogsTab /></div>
      </main>
    </div>
  );
}
