import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import SessionTab from "./components/tabs/SessionTab";
import CommandsTab from "./components/tabs/CommandsTab";
import WizardTab from "./components/tabs/WizardTab";
import ReportTab from "./components/tabs/ReportTab";
import DiagnosticsTab from "./components/tabs/DiagnosticsTab";
import SystemConfigurationTab from "./components/tabs/SystemConfigurationTab";
import ControllerTerminalWindow from "./components/tabs/ControllerTerminalWindow";
import Sidebar from "./components/shell/Sidebar";
import SidebarHeader from "./components/shell/SidebarHeader";
import SidebarNavItem from "./components/shell/SidebarNavItem";
import { StatusPillState } from "./components/shell/StatusPill";
import "./App.css";
import "./components/tabs/tabs.css";

type Tab = "session" | "commands" | "wizard" | "system-configuration" | "report" | "diagnostics";

const TABS: { id: Tab; label: string; badge?: string }[] = [
  { id: "session", label: "Connect" },
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
  vpn_detail?: string;
  shell_phase: string;
  shell_detail?: string;
  controller_ip: string | null;
  connection_mode?: string;
  local_serial_device?: string | null;
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
  const terminalWindowMode =
    new URLSearchParams(window.location.search).get("terminalWindow") === "1";
  if (terminalWindowMode) {
    return <ControllerTerminalWindow />;
  }

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
  const [connectionAlert, setConnectionAlert] = useState<string | null>(null);
  const previousStatusRef = useRef<AppStatus | null>(null);

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
        const previous = previousStatusRef.current;
        const lostVpnUnexpectedly =
          previous?.connection_mode === "vpn" &&
          s.connection_mode === "vpn" &&
          ["starting", "connected", "manual"].includes(previous.vpn_phase) &&
          ["failed", "disconnected"].includes(s.vpn_phase) &&
          previous.vpn_phase !== "stopping";
        const lostControllerUnexpectedly =
          previous?.connection_mode === "vpn" &&
          s.connection_mode === "vpn" &&
          previous.vpn_phase === "connected" &&
          s.vpn_phase === "connected" &&
          ["connecting", "connected"].includes(previous.shell_phase) &&
          ["failed", "disconnected"].includes(s.shell_phase);

        if (lostVpnUnexpectedly && s.vpn_detail) {
          setConnectionAlert(`OpenVPN connection lost: ${s.vpn_detail}`);
        } else if (lostControllerUnexpectedly && s.shell_detail) {
          setConnectionAlert(`Controller session lost while VPN is still connected: ${s.shell_detail}`);
        } else if (
          (!s.controller_ip && !s.local_serial_device) ||
          s.connection_mode !== "vpn" ||
          ((s.vpn_phase === "connected" || s.vpn_phase === "manual") && s.shell_phase === "connected")
        ) {
          setConnectionAlert(null);
        }

        previousStatusRef.current = s;
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
    const id = setInterval(fetchStatus, 1000);
    const unlistenSid = listen("controller-sid-detected", () => { fetchStatus(); });
    return () => {
      clearInterval(id);
      unlistenSid.then((fn) => fn());
    };
  }, []);

  const showVpn = appStatus.vpn_phase !== "disconnected";
  const showLocal = appStatus.connection_mode === "local";
  const vpnControllerLost =
    appStatus.connection_mode === "vpn"
    && (appStatus.vpn_phase === "connected" || appStatus.vpn_phase === "manual")
    && (appStatus.shell_phase === "failed" || appStatus.shell_phase === "disconnected");
  const vpnState = vpnControllerLost ? "error" : mapVpnState(appStatus.vpn_phase);
  const localState = mapLocalState(appStatus.connection_mode, appStatus.local_serial_device);

  const controllerDisplay = appStatus.controller_ip ?? appStatus.local_serial_device ?? "No controller";
  const controllerValid = vpnControllerLost
    ? false
    : Boolean(appStatus.controller_ip) || Boolean(appStatus.local_serial_device);

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

      {connectionAlert && (
        <div className="app-alert app-alert-danger" role="alert" aria-live="assertive">
          <span className="app-alert-copy">{connectionAlert}</span>
          <button
            type="button"
            className="app-alert-dismiss"
            onClick={() => setConnectionAlert(null)}
            aria-label="Dismiss connection alert"
          >
            ×
          </button>
        </div>
      )}

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
            <SessionTab />
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
