import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHttpTarget } from "../src/server/capability-executor.js";
import { StorageService, normalizeScope, rankByBm25 } from "../src/server/storage.js";
import type { StorageNode, TopologyEdge } from "../src/shared/contracts.js";
import { edge, node, tempDir } from "./helpers.js";

function storageNode(storageType: StorageNode["config"]["storageType"], location = "files"): StorageNode {
  const created = node({ id: `storage-${storageType}`, kind: "storage", name: "Files", position: { x: 0, y: 0 }, config: { storageType, location } });
  if (created.kind !== "storage") throw new Error("expected storage");
  return created;
}

function grant(read: boolean, write: boolean, scope = "/"): TopologyEdge {
  return edge("edge-storage", "agent", "storage", "agent_can_access_storage", { permissions: { read, write, scope } });
}

describe("filesystem storage adapter", () => {
  it("reads and writes inside the granted scope", async () => {
    const service = new StorageService(await tempDir());
    const files = storageNode("project-files");
    const rw = grant(true, true, "/docs");
    await service.write(files, rw, "notes/plan.md", "# Plan\n");
    expect(await service.read(files, rw, "notes/plan.md")).toBe("# Plan\n");
    expect(await service.list(files, rw, ".")).toContain("dir  notes");
    expect(await service.list(files, rw, "notes")).toContain("file notes/plan.md");
    // The scope maps to a sub-directory of the storage root.
    const onDisk = path.join(service.rootFor(files), "docs", "notes", "plan.md");
    expect(await readFile(onDisk, "utf8")).toBe("# Plan\n");
  });

  it("rejects traversal, absolute paths, and missing permissions", async () => {
    const service = new StorageService(await tempDir());
    const files = storageNode("project-files");
    const readOnly = grant(true, false, "/docs");
    await expect(service.read(files, readOnly, "../secret.txt")).rejects.toThrow(/escapes/);
    await expect(service.read(files, readOnly, "/etc/passwd")).rejects.toThrow(/relative/);
    await expect(service.read(files, readOnly, "C:/Windows/win.ini")).rejects.toThrow(/relative/);
    await expect(service.write(files, readOnly, "x.md", "nope")).rejects.toThrow(/write access/);
    await expect(service.list(files, grant(false, true), ".")).rejects.toThrow(/read access/);
    expect(() => normalizeScope("/docs/../../etc")).toThrow(/\.\./);
  });

  it("refuses symlinks that point outside the scope", async () => {
    const dataDir = await tempDir();
    const service = new StorageService(dataDir);
    const files = storageNode("project-files");
    const rw = grant(true, true, "/");
    const root = service.rootFor(files);
    await mkdir(root, { recursive: true });
    const outside = path.join(dataDir, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "secret");
    try {
      await symlink(outside, path.join(root, "link"), "junction");
    } catch {
      return; // Symlink creation may be unavailable (e.g. restricted Windows accounts).
    }
    await expect(service.read(files, rw, "link/secret.txt")).rejects.toThrow(/outside/);
  });

  it("keeps relative project locations inside the harness workspace", async () => {
    const dataDir = await tempDir();
    const service = new StorageService(dataDir);
    expect(service.rootFor(storageNode("project-files", "project"))).toBe(path.join(dataDir, "workspace", "project"));
    expect(() => service.rootFor(storageNode("vector-store"))).toThrow(/no adapter/);
  });
});

describe("memory storage adapter", () => {
  it("remembers notes and retrieves them by relevance within scope", async () => {
    const service = new StorageService(await tempDir());
    const memory = storageNode("memory", "team");
    const teamA = grant(true, true, "/team-a");
    const teamB = grant(true, true, "/team-b");
    const source = { runId: "run", workOrderId: "order", agentId: "agent" };
    await service.remember(memory, teamA, "The renderer uses WebGPU with a WebGL fallback.", ["decision"], source);
    await service.remember(memory, teamA, "Physics runs at a fixed 60 Hz timestep.", [], source);
    await service.remember(memory, teamB, "WebGPU is banned for team B.", [], source);

    const hits = await service.searchMemory(memory, teamA, "which renderer backend and WebGPU fallback?", 3);
    expect(hits[0]?.text).toContain("WebGL fallback");
    expect(hits.every((hit) => hit.scope === "team-a")).toBe(true);
    await expect(service.remember(memory, grant(true, false), "x", [], source)).rejects.toThrow(/write access/);
  });

  it("ranks with BM25 deterministically", () => {
    const docs = ["alpha beta", "beta gamma gamma", "delta"];
    const ranked = rankByBm25(docs, (doc) => doc, "gamma beta", 3);
    expect(ranked.map((entry) => entry.item)).toEqual(["beta gamma gamma", "alpha beta"]);
  });
});

describe("HTTP connector boundary", () => {
  it("resolves paths strictly under the configured endpoint", () => {
    expect(resolveHttpTarget("https://api.example.com/v1", "items", { q: "a b" }).toString()).toBe(
      "https://api.example.com/v1/items?q=a+b",
    );
    expect(resolveHttpTarget("https://api.example.com/v1/", "/items/7").pathname).toBe("/v1/items/7");
    expect(() => resolveHttpTarget("https://api.example.com/v1", "https://evil.test/x")).toThrow(/relative/);
    expect(() => resolveHttpTarget("https://api.example.com/v1", "//evil.test/x")).toThrow(/relative/);
    expect(() => resolveHttpTarget("https://api.example.com/v1", "../admin")).toThrow(/escapes/);
  });
});
