import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import SessionTab from "./components/tabs/SessionTab";
import CommandsTab from "./components/tabs/CommandsTab";
import WizardTab from "./components/tabs/WizardTab";
import ReportTab from "./components/tabs/ReportTab";
import DiagnosticsTab from "./components/tabs/DiagnosticsTab";
import Sidebar from "./components/shell/Sidebar";
import SidebarHeader from "./components/shell/SidebarHeader";
import SidebarNavItem from "./components/shell/SidebarNavItem";
import { StatusPillState } from "./components/shell/StatusPill";
import "./App.css";
import "./components/tabs/tabs.css";

type Tab = "session" | "console" | "wizard" | "report" | "diagnostics";

const TABS: { id: Tab; label: string }[] = [
  { id: "session", label: "Connect" },
  { id: "console", label: "Commands" },
  { id: "wizard", label: "Setup Wizard" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "report", label: "Report" },
];

interface AppStatus {
  vpn_phase: string;
  shell_phase: string;
  controller_ip: string | null;
  connection_mode?: string;
  local_serial_device?: string | null;
}
interface HeaderDiagnosticState {
  system?: { sid?: string | null; version?: string | null } | null;
}

function mapVpnState(vpnPhase: string): StatusPillState {
  if (vpnPhase === "connected") {
    return "success";
  }
  if (vpnPhase === "failed") {
    return "error";
  }
  return "neutral";
}

function mapLocalState(connectionMode?: string, serialDevice?: string | null): StatusPillState {
  if (connectionMode === "local" && serialDevice) {
    return "success";
  }
  if (connectionMode === "local" && !serialDevice) {
    return "error";
  }
  return "neutral";
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("session");
  const [appStatus, setAppStatus] = useState<AppStatus>({
    vpn_phase: "disconnected",
    shell_phase: "disconnected",
    controller_ip: null,
  });
  const [localSid, setLocalSid] = useState<string | null>(null);
  const [systemVersion, setSystemVersion] = useState<string | null>(null);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    appWindow
      .onCloseRequested(async () => {
        await invoke("stop_log_watcher").catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const s = await invoke<AppStatus>("get_app_state");
        setAppStatus(s);
        const diag = await invoke<HeaderDiagnosticState>("get_diagnostic_state");
        setSystemVersion(diag.system?.version ?? null);
        if (s.connection_mode === "local") {
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

  const showVpn = appStatus.vpn_phase !== "disconnected";
  const showLocal = appStatus.connection_mode === "local";
  const vpnState = mapVpnState(appStatus.vpn_phase);
  const localState = mapLocalState(appStatus.connection_mode, appStatus.local_serial_device);

  const controllerDisplay = localSid ?? appStatus.controller_ip ?? appStatus.local_serial_device ?? "No controller";
  const controllerValid = Boolean(localSid);

  return (
    <div className="app">
      <SidebarHeader
        showVpn={showVpn}
        vpnState={vpnState}
        showLocal={showLocal}
        localState={localState}
        controllerDisplay={controllerDisplay}
        controllerValid={controllerValid}
        systemVersion={systemVersion}
      />

      <div className="app-shell">
        <Sidebar
          nav={
            <nav className="sidebar-nav" aria-label="Primary navigation">
              {TABS.map((tab) => (
                <SidebarNavItem
                  key={tab.id}
                  label={tab.label}
                  selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                />
              ))}
            </nav>
          }
        />

        <main className="app-body">
          <div style={{ display: activeTab === "session" ? "contents" : "none" }}>
            <SessionTab />
          </div>
          <div style={{ display: activeTab === "console" ? "contents" : "none" }}>
            <CommandsTab />
          </div>
          <div style={{ display: activeTab === "wizard" ? "contents" : "none" }}>
            <WizardTab />
          </div>
          <div style={{ display: activeTab === "diagnostics" ? "contents" : "none" }}>
            <DiagnosticsTab />
          </div>
          <div style={{ display: activeTab === "report" ? "contents" : "none" }}>
            <ReportTab />
          </div>
        </main>
      </div>
    </div>
  );
}
