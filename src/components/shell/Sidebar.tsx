import { ReactNode } from "react";

interface SidebarProps {
  header: ReactNode;
  nav: ReactNode;
  footer?: ReactNode;
}

export default function Sidebar({ header, nav, footer }: SidebarProps) {
  return (
    <aside className="app-sidebar">
      <div className="app-sidebar-header-wrap">{header}</div>
      <div className="app-sidebar-nav-wrap">{nav}</div>
      {footer && <div className="app-sidebar-footer-wrap">{footer}</div>}
    </aside>
  );
}
