import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Network, PanelsTopLeft, Sparkles } from "lucide-react";
import type { ConnectorCatalog, Run, RuntimeSnapshot, Topology } from "../shared/contracts.js";
import { api } from "./api.js";
import { ConfigureView } from "./components/ConfigureView.js";
import { WorkView } from "./components/WorkView.js";

type View = "work" | "configure";
type Toast = { id: number; tone: "success" | "error" | "info"; message: string };

export function App() {
  const [view, setView] = useState<View>("work");
  const [topologies, setTopologies] = useState<Topology[]>([]);
  const [activeTopologyId, setActiveTopologyId] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [catalogs, setCatalogs] = useState<ConnectorCatalog[]>([]);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((tone: Toast["tone"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-2), { id, tone, message }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      3_600,
    );
  }, []);

  const load = useCallback(async () => {
    try {
      const [topologyResult, runResult, runtimeResult, catalogResult] = await Promise.all([
        api.topologies(),
        api.runs(),
        api.runtime(),
        api.catalogs(),
      ]);
      setTopologies(topologyResult.topologies);
      setActiveTopologyId(topologyResult.activeTopologyId);
      setRuns(runResult);
      setRuntime(runtimeResult);
      setCatalogs(catalogResult);
      setFatalError(null);
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void Promise.all([api.runs(), api.runtime()])
        .then(([nextRuns, nextRuntime]) => {
          setRuns(nextRuns);
          setRuntime(nextRuntime);
        })
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const activeTopology = useMemo(
    () => topologies.find((topology) => topology.id === activeTopologyId) ?? topologies[0] ?? null,
    [activeTopologyId, topologies],
  );

  const replaceRun = useCallback((run: Run) => {
    setRuns((current) => {
      const next = current.filter((candidate) => candidate.id !== run.id);
      return [run, ...next].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }, []);

  const saveTopology = useCallback(
    async (topology: Topology) => {
      const result = await api.saveTopology(topology);
      setTopologies((current) =>
        current.map((candidate) =>
          candidate.id === result.topology.id ? result.topology : candidate,
        ),
      );
      setActiveTopologyId(result.topology.id);
      const errors = result.issues.filter((issue) => issue.severity === "error");
      notify(
        errors.length ? "info" : "success",
        errors.length
          ? `Draft saved with ${errors.length} runtime-blocking issue${errors.length === 1 ? "" : "s"}.`
          : "Topology saved and ready to run.",
      );
      return result;
    },
    [notify],
  );

  if (loading) {
    return (
      <main className="boot-screen">
        <div className="brand-mark large"><Network /></div>
        <p>Starting local runtime…</p>
      </main>
    );
  }

  if (fatalError || !activeTopology) {
    return (
      <main className="boot-screen error-screen">
        <div className="brand-mark large"><Network /></div>
        <h1>Runtime unavailable</h1>
        <p>{fatalError ?? "No topology is available."}</p>
        <button className="primary-button" onClick={() => void load()}>Retry</button>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Network size={18} /></div>
          <div>
            <strong>Agentic Harness</strong>
            <span>local capability runtime</span>
          </div>
        </div>

        <nav className="view-switcher" aria-label="Primary views">
          <button className={view === "work" ? "active" : ""} onClick={() => setView("work")}>
            <Sparkles size={16} /> Work
          </button>
          <button
            className={view === "configure" ? "active" : ""}
            onClick={() => setView("configure")}
          >
            <PanelsTopLeft size={16} /> Configure
          </button>
        </nav>

        <div className="topbar-actions">
          <select
            className="topology-select"
            aria-label="Active topology"
            value={activeTopology.id}
            onChange={(event) => setActiveTopologyId(event.target.value)}
          >
            {topologies.map((topology) => (
              <option key={topology.id} value={topology.id}>{topology.name}</option>
            ))}
          </select>
          <div className={`runtime-pill ${runtime?.status ?? "idle"}`}>
            <Activity size={14} />
            <span>{runtime?.status ?? "offline"}</span>
          </div>
        </div>
      </header>

      <main className="main-surface">
        {view === "work" ? (
          <WorkView
            topology={activeTopology}
            runs={runs.filter((run) => run.topologyId === activeTopology.id)}
            runtime={runtime}
            onRunChanged={replaceRun}
            notify={notify}
          />
        ) : (
          <ConfigureView
            key={activeTopology.id}
            topology={activeTopology}
            runtime={runtime}
            catalogs={catalogs}
            onCatalog={(catalog) =>
              setCatalogs((current) => [
                ...current.filter((item) => item.connectorId !== catalog.connectorId),
                catalog,
              ])
            }
            onSave={saveTopology}
            notify={notify}
          />
        )}
      </main>

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>{toast.message}</div>
        ))}
      </div>
    </div>
  );
}
