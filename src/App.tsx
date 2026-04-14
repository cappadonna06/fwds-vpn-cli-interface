import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import SessionTab from "./components/tabs/SessionTab";
import ConsoleTab from "./components/tabs/ConsoleTab";
import CommandsTab from "./components/tabs/CommandsTab";
import WizardTab from "./components/tabs/WizardTab";
import ReportTab from "./components/tabs/ReportTab";
import DiagnosticsTab from "./components/tabs/DiagnosticsTab";
import SystemConfigurationTab from "./components/tabs/SystemConfigurationTab";
import Sidebar from "./components/shell/Sidebar";
import SidebarHeader from "./components/shell/SidebarHeader";
import SidebarNavItem from "./components/shell/SidebarNavItem";
import { StatusPillState } from "./components/shell/StatusPill";
import "./App.css";
import "./components/tabs/tabs.css";

type Tab = "session" | "console" | "commands" | "wizard" | "system-configuration" | "report" | "diagnostics";

const TABS: { id: Tab; label: string; badge?: string }[] = [
  { id: "session", label: "Connect" },
  { id: "console", label: "Console" },
  { id: "commands", label: "Commands" },
  { id: "wizard", label: "Setup Wizard" },
  { id: "system-configuration", label: "System Configuration" },
  { id: "diagnostics", label: "Diagnostics", badge: "Beta" },
  { id: "report", label: "Report", badge: "Beta" },
];

let closeGuard = false;
let closeUnlisten: (() => void) | null = null;

interface AppStatus {
  vpn_phase: string;
  shell_phase: string;
  controller_ip: string | null;
  connection_mode?: string;
  local_serial_device?: string | null;
  platform?: string;
}

interface SystemInfo {
  sid: string | null;
  version: string | null;
  release_date: string | null;
}

interface DiagnosticStateSnapshot {
  system: SystemInfo | null;
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
  const [systemInfo, setSystemInfo] = useState<{ sid: string | null; version: string | null }>({
    sid: null,
    version: null,
  });

  useEffect(() => {
    const appWindow = getCurrentWindow();
    if (closeUnlisten) {
      closeUnlisten();
      closeUnlisten = null;
    }

    appWindow
      .onCloseRequested(async (event) => {
        if (closeGuard) {
          return;
        }
        event.preventDefault();
        const shouldQuit = await confirm("Quit application?", {
          title: "FWDS Controller Console",
          kind: "warning",
          okLabel: "Quit",
          cancelLabel: "Cancel",
        });
        if (!shouldQuit) {
          return;
        }
        closeGuard = true;
        if (closeUnlisten) {
          closeUnlisten();
          closeUnlisten = null;
        }
        await invoke("quit_app").catch(async () => {
          await appWindow.close().catch(() => {});
        });
      })
      .then((fn) => {
        closeUnlisten = fn;
      })
      .catch(() => {});

    return () => {
      if (closeUnlisten) {
        closeUnlisten();
        closeUnlisten = null;
      }
    };
  }, []);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const s = await invoke<AppStatus>("get_app_state");
        setAppStatus(s);

        const diagData = await invoke<DiagnosticStateSnapshot>("get_diagnostic_state");
        const rawSid = diagData.system?.sid ?? "";
        const rawVersion = diagData.system?.version ?? "";

        const sid = /^\d{8}$/.test(rawSid) ? rawSid : null;
        const version = /^r\d+\.\d+/.test(rawVersion) ? rawVersion : null;

        setSystemInfo({ sid, version });
      } catch {
        /* ignore */
      }
    }
    fetchStatus();
    const id = setInterval(fetchStatus, 2000);
    const unlistenSid = listen("controller-sid-detected", () => { fetchStatus(); });
    return () => {
      clearInterval(id);
      unlistenSid.then((fn) => fn());
    };
  }, []);

  const showVpn = appStatus.vpn_phase !== "disconnected";
  const showLocal = appStatus.connection_mode === "local";
  const vpnState = mapVpnState(appStatus.vpn_phase);
  const localState = mapLocalState(appStatus.connection_mode, appStatus.local_serial_device);
  const useTerminal = appStatus.platform === "windows" && appStatus.connection_mode === "local";

  const controllerDisplay = appStatus.controller_ip ?? appStatus.local_serial_device ?? "No controller";
  const controllerValid = Boolean(appStatus.controller_ip) || Boolean(appStatus.local_serial_device);

  return (
    <div className="app">
      <SidebarHeader
        showVpn={showVpn}
        vpnState={vpnState}
        showLocal={showLocal}
        localState={localState}
        controllerDisplay={controllerDisplay}
        controllerValid={controllerValid}
        systemSid={systemInfo.sid}
        systemVersion={systemInfo.version}
      />

      <div className="app-shell">
        <Sidebar
          nav={
            <nav className="sidebar-nav" aria-label="Primary navigation">
              {TABS.map((tab) => (
                <SidebarNavItem
                  key={tab.id}
                  label={tab.label}
                  badge={tab.badge}
                  selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                />
              ))}
            </nav>
          }
        />

        <main className="app-body">
          <div style={{ display: activeTab === "session" ? "contents" : "none" }}>
            <SessionTab onControllerConnected={() => setActiveTab("console")} />
          </div>
          <div style={{ display: activeTab === "console" ? "contents" : "none" }}>
            <ConsoleTab useTerminal={useTerminal} />
          </div>
          <div style={{ display: activeTab === "commands" ? "contents" : "none" }}>
            <CommandsTab />
          </div>
          <div style={{ display: activeTab === "wizard" ? "contents" : "none" }}>
            <WizardTab />
          </div>
          <div style={{ display: activeTab === "system-configuration" ? "contents" : "none" }}>
            <SystemConfigurationTab />
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
