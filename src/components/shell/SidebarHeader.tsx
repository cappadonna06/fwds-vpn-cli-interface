import StatusPill, { StatusPillState } from "./StatusPill";

interface SidebarHeaderProps {
  vpnState?: StatusPillState;
  showVpn: boolean;
  localState?: StatusPillState;
  showLocal: boolean;
  controllerDisplay: string;
  controllerTone: "valid" | "invalid" | "neutral";
  systemSid?: string | null;
  systemVersion?: string | null;
  systemLocation?: string | null;
}

export default function SidebarHeader({
  vpnState,
  showVpn,
  localState,
  showLocal,
  controllerDisplay,
  controllerTone,
  systemSid,
  systemVersion,
  systemLocation,
}: SidebarHeaderProps) {
  return (
    <header className="app-top-header">
      <div className="top-header-brand">
        <img src="/logo.png" alt="FWDS logo" className="h-10 w-auto object-contain" />
        <div className="top-header-brand-text">
          <span className="top-header-brand-title">FWDS</span>
          <span className="top-header-brand-subtitle">Controller Console <span className="header-version-pill">v1.0</span></span>
        </div>
      </div>

      <div className="top-header-status">
        <div className="top-header-pills">
          {showVpn && vpnState && <StatusPill label="VPN" state={vpnState} />}
          {showLocal && localState && <StatusPill label="Local" state={localState} />}
        </div>
        <div className="top-header-controller-group">
          <div className={`top-header-controller ${controllerTone}`}>
            {controllerDisplay}
          </div>
          {systemSid && <span className="badge-info">SID {systemSid}</span>}
          {systemVersion && <span className="badge-info">{systemVersion}</span>}
          {systemLocation && <span className="badge-info">Location {systemLocation}</span>}
        </div>
      </div>
    </header>
  );
}
