import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../lib/auth.js";

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <div className="nl-app">
      <aside className="nl-sidebar">
        <div className="nl-brand">
          NULLLAB
          <small>Practice over theory</small>
        </div>
        <nav className="nl-nav">
          <NavLink to="/catalog" className={({ isActive }) => (isActive ? "active" : "")}>
            Lab Catalogue
          </NavLink>
          <NavLink to="/progress" className={({ isActive }) => (isActive ? "active" : "")}>
            Progress
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : "")}>
            Settings
          </NavLink>
        </nav>
        <div className="nl-sidebar-footer">
          <div style={{ marginBottom: "0.5rem" }}>
            Signed in as <strong>{user?.username}</strong>
            {user?.isGuest ? " (guest)" : ""}
          </div>
          <button className="nl-btn secondary small" onClick={() => logout()}>
            Log out
          </button>
        </div>
      </aside>
      <main className="nl-main">{children}</main>
    </div>
  );
}
