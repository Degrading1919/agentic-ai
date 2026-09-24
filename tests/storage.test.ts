import { existsSync } from "node:fs";
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
    await expect(service.read(files, readOnly, "../secret.txt")).rejects.toThrow(/'\.\.' is not allowed/);
    await expect(service.read(files, readOnly, "/etc/passwd")).rejects.toThrow(/relative/);
    await expect(service.read(files, readOnly, "C:/Windows/win.ini")).rejects.toThrow(/Drive-qualified/);
    await expect(service.write(files, readOnly, "x.md", "nope")).rejects.toThrow(/write access/);
    await expect(service.list(files, grant(false, true), ".")).rejects.toThrow(/read access/);
    expect(() => normalizeScope("/docs/../../etc")).toThrow(/'\.\.' is not allowed/);
  });

  // Audit A1: a drive-qualified scope used to replace the node root entirely.
  it.each([
    ["C:/Windows", /Drive-qualified/],
    ["C:", /Drive-qualified/],
    ["c:\\Windows\\System32", /Drive-qualified/],
    ["\\\\?\\C:\\Windows", /UNC and device/],
    ["\\\\.\\PhysicalDrive0", /UNC and device/],
    ["//server/share", /UNC and device/],
    ["\\\\server\\share", /UNC and device/],
    ["/docs/../../..", /'\.\.' is not allowed/],
    ["notes:secret", /':' is not allowed/],
    ["/CON", /reserved device/],
    ["/docs.", /dot or space/],
  ])("rejects the hostile scope %s for every operation", async (scope, message) => {
    const dataDir = await tempDir();
    const service = new StorageService(dataDir);
    const files = storageNode("project-files");
    const hostile = grant(true, true, scope);
    await expect(service.read(files, hostile, "win.ini")).rejects.toThrow(message);
    await expect(service.list(files, hostile, ".")).rejects.toThrow(message);
    await expect(service.write(files, hostile, "planted.txt", "x")).rejects.toThrow(message);
  });

  it.each([
    ["..\\..\\outside.txt"],
    ["a/../../outside.txt"],
    ["D:outside.txt"],
    ["notes.md:stream"],
    ["nul"],
    ["lpt1.txt"],
    ["name "],
  ])("rejects the hostile path %s", async (hostilePath) => {
    const service = new StorageService(await tempDir());
    const files = storageNode("project-files");
    await expect(service.write(files, grant(true, true), hostilePath, "x")).rejects.toThrow();
    await expect(service.read(files, grant(true, true), hostilePath)).rejects.toThrow();
  });

  // Audit A1: a scope that *is* a junction/symlink escaped both reads and writes.
  it("refuses a scope that is a junction or symlink to an outside directory", async () => {
    const dataDir = await tempDir();
    const service = new StorageService(dataDir);
    const files = storageNode("project-files");
    const root = service.rootFor(files);
    await mkdir(root, { recursive: true });
    const outside = path.join(dataDir, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "OUTSIDE SECRET");
    await symlink(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");

    const scoped = grant(true, true, "/link");
    await expect(service.read(files, scoped, "secret.txt")).rejects.toThrow(/link or junction/);
    await expect(service.list(files, scoped, ".")).rejects.toThrow(/link or junction/);
    await expect(service.write(files, scoped, "created.txt", "x")).rejects.toThrow(/link or junction/);
    expect(existsSync(path.join(outside, "created.txt"))).toBe(false);
  });

  it("refuses links anywhere below the scope, including nested and write-parent positions", async () => {
    const dataDir = await tempDir();
    const service = new StorageService(dataDir);
    const files = storageNode("project-files");
    const root = service.rootFor(files);
    await mkdir(path.join(root, "docs", "deep"), { recursive: true });
    const outside = path.join(dataDir, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "OUTSIDE SECRET");
    const type = process.platform === "win32" ? "junction" : "dir";
    await symlink(outside, path.join(root, "docs", "deep", "escape"), type);

    const rw = grant(true, true, "/docs");
    await expect(service.read(files, rw, "deep/escape/secret.txt")).rejects.toThrow(/link or junction/);
    await expect(service.write(files, rw, "deep/escape/new/file.txt", "x")).rejects.toThrow(/link or junction/);
    expect(existsSync(path.join(outside, "new"))).toBe(false);
    expect(await service.list(files, rw, "deep")).toContain("(not followed)");
  });

  it("canonicalizes a configured root that is itself a link (the root is trusted configuration)", async () => {
    const dataDir = await tempDir();
    const real = path.join(dataDir, "real-project");
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, "readme.md"), "hello");
    const linkedRoot = path.join(dataDir, "linked-project");
    await symlink(real, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const service = new StorageService(dataDir);
    const files = storageNode("project-files", linkedRoot);
    expect(await service.read(files, grant(true, false), "readme.md")).toBe("hello");
  });

  it("never writes through an existing link at the destination", async () => {
    const dataDir = await tempDir();
    const service = new StorageService(dataDir);
    const files = storageNode("project-files");
    const root = service.rootFor(files);
    await mkdir(root, { recursive: true });
    const outside = path.join(dataDir, "outside-dir");
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(root, "target"), process.platform === "win32" ? "junction" : "dir");
    await expect(service.write(files, grant(true, true), "target", "x")).rejects.toThrow(/link or junction/);
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
