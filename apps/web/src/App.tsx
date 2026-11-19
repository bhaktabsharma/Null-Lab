import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth.js";
import Layout from "./components/Layout.js";
import LoginPage from "./pages/LoginPage.js";
import CatalogPage from "./pages/CatalogPage.js";
import WorkspacePage from "./pages/WorkspacePage.js";
import ProgressPage from "./pages/ProgressPage.js";
import SettingsPage from "./pages/SettingsPage.js";

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <p className="nl-muted">Loading NULLLAB…</p>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/catalog" replace />} />
        <Route path="/catalog" element={<CatalogPage />} />
        <Route path="/workspace/:instanceId" element={<WorkspacePage />} />
        <Route path="/progress" element={<ProgressPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/catalog" replace />} />
      </Routes>
    </Layout>
  );
}
