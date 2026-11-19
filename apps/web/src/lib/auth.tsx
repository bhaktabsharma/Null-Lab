import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { PublicUser } from "@nulllab/shared";
import { api } from "./api.js";

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  error: string | null;
  continueAsGuest: () => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { user } = await api.auth.me();
      setUser(user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    refresh().finally(() => {
      if (!ignore) setLoading(false);
    });
    return () => {
      ignore = true;
    };
  }, [refresh]);

  const wrap = useCallback(
    (fn: () => Promise<{ user: PublicUser }>) => async () => {
      setError(null);
      try {
        const { user } = await fn();
        setUser(user);
      } catch (err) {
        setError(err instanceof api.ApiError ? err.message : "Something went wrong.");
        throw err;
      }
    },
    [],
  );

  const continueAsGuest = useCallback(() => wrap(() => api.auth.guest())(), [wrap]);
  const register = useCallback(
    (username: string, password: string) => wrap(() => api.auth.register(username, password))(),
    [wrap],
  );
  const login = useCallback((username: string, password: string) => wrap(() => api.auth.login(username, password))(), [wrap]);
  const logout = useCallback(async () => {
    await api.auth.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, error, continueAsGuest, register, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
