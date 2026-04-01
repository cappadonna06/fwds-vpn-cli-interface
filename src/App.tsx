import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
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
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("session");
  const [appStatus, setAppStatus] = useState<AppStatus>({
    vpn_phase: "disconnected",
    shell_phase: "disconnected",
    controller_ip: null,
  });

  // Poll app-wide status for the header every 2s
  useEffect(() => {
    async function fetchStatus() {
      try {
        const s = await invoke<AppStatus>("get_app_state");
        setAppStatus(s);
      } catch { /* ignore */ }
    }
    fetchStatus();
    const id = setInterval(fetchStatus, 2000);
    return () => clearInterval(id);
  }, []);

  // Stop the log watcher when the window closes
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const unlisten = getCurrentWindow().onCloseRequested(() => {
        invoke("stop_log_watcher").catch(() => {});
      });
      cleanup = () => { unlisten.then((fn) => fn()); };
    });
    return () => { cleanup?.(); };
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
          {appStatus.shell_phase === "connected" && appStatus.controller_ip && (
            <span className="badge badge-connected">{appStatus.controller_ip}</span>
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
