import type {
  PublicUser,
  LabSummaryDTO,
  LabInstanceDTO,
  ThemeSettings,
  PublicLabManifest,
} from "@nulllab/shared";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: init.body ? { "content-type": "application/json", ...init.headers } : init.headers,
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    throw new ApiError(res.status, (body && (body as { error?: string }).error) || res.statusText);
  }
  return body as T;
}

export const api = {
  ApiError,

  auth: {
    guest: () => request<{ user: PublicUser }>("/api/auth/guest", { method: "POST" }),
    register: (username: string, password: string) =>
      request<{ user: PublicUser }>("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password }) }),
    login: (username: string, password: string) =>
      request<{ user: PublicUser }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
    logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    me: () => request<{ user: PublicUser }>("/api/auth/me"),
  },

  labs: {
    list: () => request<{ labs: LabSummaryDTO[] }>("/api/labs"),
    get: (labId: string) => request<{ manifest: PublicLabManifest; solved: boolean; solvedAt: string | null; saved: boolean }>(`/api/labs/${labId}`),
    hint: (labId: string, n: number) => request<{ index: number; total: number; hint: string }>(`/api/labs/${labId}/hints/${n}`),
    save: (labId: string) => request<{ ok: true }>(`/api/labs/${labId}/save`, { method: "POST" }),
    unsave: (labId: string) => request<{ ok: true }>(`/api/labs/${labId}/save`, { method: "DELETE" }),
    launch: (labId: string) => request<{ instance: LabInstanceDTO }>(`/api/labs/${labId}/instances`, { method: "POST" }),
  },

  instances: {
    list: () => request<{ instances: LabInstanceDTO[] }>("/api/instances"),
    get: (instanceId: string) => request<{ instance: LabInstanceDTO }>(`/api/instances/${instanceId}`),
    reset: (instanceId: string) => request<{ instance: LabInstanceDTO }>(`/api/instances/${instanceId}/reset`, { method: "POST" }),
    stop: (instanceId: string) => request<{ ok: true }>(`/api/instances/${instanceId}/stop`, { method: "POST" }),
    simulateAdminVisit: (instanceId: string, path: string) =>
      request<{ ok: true }>(`/api/instances/${instanceId}/simulate-admin-visit`, {
        method: "POST",
        body: JSON.stringify({ path }),
      }),
  },

  progress: {
    get: () =>
      request<{
        xp: number;
        totalLabs: number;
        totalSolved: number;
        byFamily: Record<string, { total: number; solved: number }>;
        recentSolves: { labId: string; labTitle: string; instanceId: string; evidence: string; xpAwarded: number; verifiedAt: string }[];
      }>("/api/progress"),
  },

  preferences: {
    getTheme: () => request<{ theme: ThemeSettings }>("/api/preferences/theme"),
    setTheme: (theme: ThemeSettings) =>
      request<{ theme: ThemeSettings }>("/api/preferences/theme", { method: "PUT", body: JSON.stringify(theme) }),
  },

  meta: () => request<{ runtimeMode: string; labCount: number }>("/api/meta"),
};

export { ApiError };
