import type {
  CreateRunRequest,
  Run,
  RuntimeSnapshot,
  Topology,
  ValidationIssue,
} from "../shared/contracts.js";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed with HTTP ${response.status}.`);
  return payload;
}

export const api = {
  async topologies(): Promise<{ activeTopologyId: string; topologies: Topology[] }> {
    return request("/api/topologies");
  },

  async saveTopology(
    topology: Topology,
  ): Promise<{ topology: Topology; issues: ValidationIssue[] }> {
    return request(`/api/topologies/${encodeURIComponent(topology.id)}`, {
      method: "PUT",
      body: JSON.stringify(topology),
    });
  },

  async runs(): Promise<Run[]> {
    const result = await request<{ runs: Run[] }>("/api/runs?limit=100");
    return result.runs;
  },

  async run(id: string): Promise<Run> {
    const result = await request<{ run: Run }>(`/api/runs/${encodeURIComponent(id)}`);
    return result.run;
  },

  async createRun(payload: CreateRunRequest): Promise<Run> {
    const result = await request<{ run: Run }>("/api/runs", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return result.run;
  },

  async pauseRun(id: string): Promise<Run> {
    const result = await request<{ run: Run }>(`/api/runs/${encodeURIComponent(id)}/pause`, {
      method: "POST",
      body: "{}",
    });
    return result.run;
  },

  async resumeRun(id: string): Promise<Run> {
    const result = await request<{ run: Run }>(`/api/runs/${encodeURIComponent(id)}/resume`, {
      method: "POST",
      body: "{}",
    });
    return result.run;
  },

  async runtime(): Promise<RuntimeSnapshot> {
    const result = await request<{ runtime: RuntimeSnapshot }>("/api/runtime");
    return result.runtime;
  },

  async testModel(
    topologyId: string,
    modelId: string,
  ): Promise<{ ok: boolean; message: string; models?: string[] }> {
    return request(
      `/api/topologies/${encodeURIComponent(topologyId)}/models/${encodeURIComponent(modelId)}/test`,
      { method: "POST" },
    );
  },
};
