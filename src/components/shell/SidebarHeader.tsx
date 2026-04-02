import StatusPill, { StatusPillState } from "./StatusPill";

interface SidebarHeaderProps {
  vpnState?: StatusPillState;
  showVpn: boolean;
  localState?: StatusPillState;
  showLocal: boolean;
  controllerDisplay: string;
  controllerValid: boolean;
}

export default function SidebarHeader({
  vpnState,
  showVpn,
  localState,
  showLocal,
  controllerDisplay,
  controllerValid,
}: SidebarHeaderProps) {
  return (
    <div className="sidebar-header">
      <div className="sidebar-brand">
        <img src="/logo.png" alt="FWDS logo" className="h-8 w-auto object-contain" />
        <div className="sidebar-brand-text">
          <span className="sidebar-brand-title">FWDS</span>
          <span className="sidebar-brand-subtitle">Controller Console</span>
        </div>
      </div>

      <div className="sidebar-pills">
        {showVpn && vpnState && <StatusPill label="VPN" state={vpnState} />}
        {showLocal && localState && <StatusPill label="Local" state={localState} />}
      </div>

      <div className={`sidebar-controller ${controllerValid ? "valid" : "invalid"}`}>
        {controllerDisplay}
      </div>
    </div>
  );
}
