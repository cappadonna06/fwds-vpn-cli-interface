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
  location: string | null;
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
  const [systemInfo, setSystemInfo] = useState<SystemInfo>({
    sid: null,
    version: null,
    release_date: null,
    location: null,
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
        const vpnReady = s.vpn_phase === "connected" || s.vpn_phase === "manual";
        const previousVpnReady =
          previous?.vpn_phase === "connected" || previous?.vpn_phase === "manual";
        const lostVpnUnexpectedly =
          previous?.connection_mode === "vpn" &&
          s.connection_mode === "vpn" &&
          ["starting", "connected", "manual"].includes(previous.vpn_phase) &&
          ["failed", "disconnected"].includes(s.vpn_phase) &&
          previous.vpn_phase !== "stopping";
        const lostControllerUnexpectedly =
          previous?.connection_mode === "vpn" &&
          s.connection_mode === "vpn" &&
          previousVpnReady &&
          vpnReady &&
          ["connecting", "connected"].includes(previous.shell_phase) &&
          ["failed", "disconnected"].includes(s.shell_phase);
        const lostLocalUnexpectedly =
          previous?.connection_mode === "local" &&
          s.connection_mode === "local" &&
          ["connecting", "connected"].includes(previous.shell_phase) &&
          ["failed", "disconnected"].includes(s.shell_phase);

        if (lostVpnUnexpectedly && s.vpn_detail) {
          setConnectionAlert(`OpenVPN connection lost: ${s.vpn_detail}`);
        } else if (lostControllerUnexpectedly) {
          if (s.shell_detail === "Controller disconnected") {
            setConnectionAlert(null);
          } else if (s.shell_detail === "Terminal window closed" || s.shell_detail === "PuTTY window closed") {
            setConnectionAlert("Controller window closed. Relaunch from the Connect page.");
          } else if (s.shell_detail) {
            setConnectionAlert(`Controller session lost while VPN is still connected: ${s.shell_detail}`);
          }
        } else if (lostLocalUnexpectedly) {
          if (s.shell_detail === "Local session disconnected") {
            setConnectionAlert(null);
          } else if (s.shell_detail === "Local session closed") {
            setConnectionAlert("Local terminal window closed. Reconnect from the Connect page.");
          } else if (s.shell_detail) {
            setConnectionAlert(`Local controller session lost: ${s.shell_detail}`);
          }
        } else if (
          (s.connection_mode === "local" && s.shell_phase === "connected") ||
          (s.connection_mode === "vpn" && vpnReady && s.shell_phase === "connected")
        ) {
          setConnectionAlert(null);
        }

        previousStatusRef.current = s;
        setAppStatus(s);

        const diagData = await invoke<DiagnosticStateSnapshot>("get_diagnostic_state");
        const rawSid = diagData.system?.sid ?? "";
        const rawVersion = diagData.system?.version ?? "";
        const rawLocation = diagData.system?.location?.trim() ?? "";

        const sid = /^\d{8}$/.test(rawSid) ? rawSid : null;
        const version = /^r\d+\.\d+/.test(rawVersion) ? rawVersion : null;
        const location = rawLocation.length > 0 ? rawLocation : null;

        setSystemInfo({ sid, version, release_date: diagData.system?.release_date ?? null, location });
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

  const vpnReady = appStatus.vpn_phase === "connected" || appStatus.vpn_phase === "manual";
  const happyVpnPath =
    appStatus.connection_mode === "vpn"
    && Boolean(appStatus.controller_ip)
    && vpnReady
    && appStatus.shell_phase === "connected";
  const showLocal = appStatus.connection_mode === "local";
  const localConnected = showLocal && Boolean(appStatus.local_serial_device);
  const showVpn = happyVpnPath;
  const vpnState = mapVpnState(appStatus.vpn_phase);
  const localState = mapLocalState(appStatus.connection_mode, appStatus.local_serial_device);
  const controllerDisplay = localConnected
    ? appStatus.local_serial_device ?? "No controller"
    : happyVpnPath
      ? appStatus.controller_ip ?? "No controller"
      : "No controller";
  const controllerTone = happyVpnPath || localConnected ? "valid" : "neutral";
  const showSystemInfo = happyVpnPath || localConnected;

  return (
    <div className="app">
      <SidebarHeader
        showVpn={showVpn}
        vpnState={vpnState}
        showLocal={showLocal}
        localState={localState}
        controllerDisplay={controllerDisplay}
        controllerTone={controllerTone}
        systemSid={showSystemInfo ? systemInfo.sid : null}
        systemVersion={showSystemInfo ? systemInfo.version : null}
        systemLocation={showSystemInfo ? systemInfo.location : null}
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
