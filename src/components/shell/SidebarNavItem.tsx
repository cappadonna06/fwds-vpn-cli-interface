interface SidebarNavItemProps {
  label: string;
  selected: boolean;
  onClick: () => void;
}

export default function SidebarNavItem({ label, selected, onClick }: SidebarNavItemProps) {
  return (
    <button
      type="button"
      className={`sidebar-nav-item ${selected ? "selected" : ""}`}
      onClick={onClick}
    >
      <span>{label}</span>
      {selected && <span className="sidebar-nav-accent" aria-hidden="true" />}
    </button>
  );
}
