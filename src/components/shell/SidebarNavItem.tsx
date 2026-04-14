interface SidebarNavItemProps {
  label: string;
  badge?: string;
  selected: boolean;
  onClick: () => void;
}

export default function SidebarNavItem({ label, badge, selected, onClick }: SidebarNavItemProps) {
  return (
    <button
      type="button"
      className={`sidebar-nav-item ${selected ? "selected" : ""}`}
      onClick={onClick}
    >
      <span className="sidebar-nav-label">
        {label}
        {badge && <span className="nav-beta-pill">{badge}</span>}
      </span>
      {selected && <span className="sidebar-nav-accent" aria-hidden="true" />}
    </button>
  );
}
