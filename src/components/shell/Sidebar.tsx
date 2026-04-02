import { ReactNode } from "react";

interface SidebarProps {
  nav: ReactNode;
}

export default function Sidebar({ nav }: SidebarProps) {
  return (
    <aside className="app-sidebar">
      <div className="app-sidebar-nav-wrap">{nav}</div>
    </aside>
  );
}
