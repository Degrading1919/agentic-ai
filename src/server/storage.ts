import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StorageNode, TopologyEdge } from "../shared/contracts.js";
import { slugify } from "../shared/capabilities.js";

export const MAX_READ_BYTES = 64 * 1024;
export const MAX_WRITE_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 200;

export type MemoryEntry = {
  id: string;
  text: string;
  tags: string[];
  scope: string;
  source: { runId: string | null; workOrderId: string | null; agentId: string | null };
  createdAt: string;
};

export class StorageBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageBoundaryError";
  }
}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

function comparable(value: string): string {
  return caseInsensitive ? value.toLowerCase() : value;
}

export function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = comparable(path.resolve(root));
  const normalizedCandidate = comparable(path.resolve(candidate));
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

/** Normalize an edge scope ("/runs", "runs/", "") to a relative POSIX-style path. */
export function normalizeScope(scope: string | undefined): string {
  const parts = (scope ?? "/")
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".");
  if (parts.includes("..")) throw new StorageBoundaryError("Storage scope may not contain '..'.");
  return parts.join("/");
}

const stopWords = new Set(
  "a an and are as at be but by for from has have in into is it its of on or that the this to was were will with".split(
    " ",
  ),
);

export function lexicalTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1 && !stopWords.has(term));
}

/** Okapi BM25 over a small in-memory corpus. Deterministic and dependency-free. */
export function rankByBm25<T>(
  items: T[],
  textOf: (item: T) => string,
  query: string,
  limit: number,
): Array<{ item: T; score: number }> {
  const queryTerms = [...new Set(lexicalTerms(query))];
  if (queryTerms.length === 0 || items.length === 0) return [];
  const documents = items.map((item) => lexicalTerms(textOf(item)));
  const averageLength =
    documents.reduce((sum, terms) => sum + terms.length, 0) / Math.max(1, documents.length);
  const documentFrequency = new Map<string, number>();
  for (const terms of documents) {
    for (const term of new Set(terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const k1 = 1.2;
  const b = 0.75;
  return documents
    .map((terms, index) => {
      let score = 0;
      for (const term of queryTerms) {
        const frequency = terms.filter((candidate) => candidate === term).length;
        if (frequency === 0) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        score +=
          (idf * frequency * (k1 + 1)) /
          (frequency + k1 * (1 - b + (b * terms.length) / Math.max(1, averageLength)));
      }
      return { item: items[index], score, index };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ item, score }) => ({ item, score: Math.round(score * 1_000) / 1_000 }));
}

/**
 * Physical storage adapters behind storage edges. Every call receives the
 * edge so read/write permissions and scope are enforced at the adapter, not
 * only in prompt text.
 */
export class StorageService {
  readonly workspaceRoot: string;

  constructor(readonly dataDir: string, workspaceRoot?: string) {
    this.workspaceRoot = path.resolve(
      workspaceRoot ?? process.env.AGENTIC_HARNESS_WORKSPACE_DIR ?? path.join(dataDir, "workspace"),
    );
  }

  /** Physical root for a storage node, before the edge scope is applied. */
  rootFor(node: StorageNode): string {
    const location = node.config.location.trim();
    switch (node.config.storageType) {
      case "artifact-store":
        return path.join(this.dataDir, "storage", slugify(location || node.id, 60));
      case "memory":
        return path.join(this.dataDir, "memory", slugify(location || node.id, 60));
      case "project-files":
      case "git":
        // Relative project locations live under the harness workspace, never
        // under the application's own working directory.
        return path.isAbsolute(location)
          ? path.resolve(location)
          : path.resolve(this.workspaceRoot, location || slugify(node.name, 60));
      case "vector-store":
        throw new StorageBoundaryError(
          `Storage '${node.name}' uses the vector-store type, which has no adapter yet.`,
        );
    }
  }

  private scopedRoot(node: StorageNode, edge: TopologyEdge): string {
    const scope = normalizeScope(edge.permissions?.scope);
    return path.resolve(this.rootFor(node), scope);
  }

  private async resolveInside(
    node: StorageNode,
    edge: TopologyEdge,
    relativePath: string,
  ): Promise<{ root: string; target: string }> {
    const root = this.scopedRoot(node, edge);
    const cleaned = (relativePath || ".").replaceAll("\\", "/");
    if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith("//")) {
      throw new StorageBoundaryError("Paths must be relative to the storage scope.");
    }
    const target = path.resolve(root, cleaned.replace(/^\/+/, ""));
    if (!isInside(root, target)) {
      throw new StorageBoundaryError(`Path '${relativePath}' escapes the granted scope.`);
    }
    // Resolve symlinks on the nearest existing ancestor so links cannot escape.
    let probe = target;
    while (!existsSync(probe) && isInside(root, path.dirname(probe)) && probe !== root) {
      probe = path.dirname(probe);
    }
    if (existsSync(probe) && existsSync(root)) {
      const [realRoot, realProbe] = await Promise.all([realpath(root), realpath(probe)]);
      if (!isInside(realRoot, realProbe)) {
        throw new StorageBoundaryError(`Path '${relativePath}' resolves outside the granted scope.`);
      }
    }
    return { root, target };
  }

  private requirePermission(edge: TopologyEdge, permission: "read" | "write", node: StorageNode) {
    if (!edge.permissions?.[permission]) {
      throw new StorageBoundaryError(
        `Topology boundary: ${permission} access to '${node.name}' is not granted by this edge.`,
      );
    }
  }

  async list(node: StorageNode, edge: TopologyEdge, relativePath = "."): Promise<string> {
    this.requirePermission(edge, "read", node);
    const { root, target } = await this.resolveInside(node, edge, relativePath);
    if (!existsSync(target)) return relativePath === "." ? "(empty)" : `Not found: ${relativePath}`;
    const info = await stat(target);
    if (!info.isDirectory()) return `${path.relative(root, target).replaceAll("\\", "/")} (file, ${info.size} bytes)`;
    const entries = await readdir(target, { withFileTypes: true });
    const lines = entries
      .filter((entry) => !entry.name.startsWith(".tmp-"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_LIST_ENTRIES)
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${path.relative(root, path.join(target, entry.name)).replaceAll("\\", "/")}`);
    const more = entries.length > MAX_LIST_ENTRIES ? `\n… ${entries.length - MAX_LIST_ENTRIES} more` : "";
    return lines.length ? `${lines.join("\n")}${more}` : "(empty)";
  }

  async read(node: StorageNode, edge: TopologyEdge, relativePath: string): Promise<string> {
    this.requirePermission(edge, "read", node);
    const { target } = await this.resolveInside(node, edge, relativePath);
    if (!existsSync(target)) throw new StorageBoundaryError(`File not found: ${relativePath}`);
    const info = await stat(target);
    if (!info.isFile()) throw new StorageBoundaryError(`Not a file: ${relativePath}`);
    const buffer = await readFile(target);
    const text = buffer.subarray(0, MAX_READ_BYTES).toString("utf8");
    return buffer.length > MAX_READ_BYTES
      ? `${text}\n[…truncated: ${buffer.length} bytes total]`
      : text;
  }

  async write(
    node: StorageNode,
    edge: TopologyEdge,
    relativePath: string,
    content: string,
  ): Promise<{ path: string; bytes: number }> {
    this.requirePermission(edge, "write", node);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_WRITE_BYTES) {
      throw new StorageBoundaryError(`Write exceeds the ${MAX_WRITE_BYTES}-byte limit.`);
    }
    const { root, target } = await this.resolveInside(node, edge, relativePath);
    if (target === root) throw new StorageBoundaryError("A file name is required.");
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.tmp-${randomUUID()}`);
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
    return { path: target, bytes };
  }

  private memoryFile(node: StorageNode): string {
    return path.join(this.rootFor(node), "memory.jsonl");
  }

  async readMemory(node: StorageNode): Promise<MemoryEntry[]> {
    const file = this.memoryFile(node);
    if (!existsSync(file)) return [];
    const raw = await readFile(file, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as MemoryEntry];
        } catch {
          return [];
        }
      });
  }

  async searchMemory(
    node: StorageNode,
    edge: TopologyEdge,
    query: string,
    limit = 4,
  ): Promise<Array<MemoryEntry & { score: number }>> {
    this.requirePermission(edge, "read", node);
    const scope = normalizeScope(edge.permissions?.scope);
    const entries = (await this.readMemory(node)).filter(
      (entry) => !scope || entry.scope === scope || entry.scope.startsWith(`${scope}/`),
    );
    return rankByBm25(entries, (entry) => `${entry.text} ${entry.tags.join(" ")}`, query, limit).map(
      ({ item, score }) => ({ ...item, score }),
    );
  }

  async remember(
    node: StorageNode,
    edge: TopologyEdge,
    text: string,
    tags: string[],
    source: MemoryEntry["source"],
  ): Promise<MemoryEntry> {
    this.requirePermission(edge, "write", node);
    const trimmed = text.trim();
    if (!trimmed) throw new StorageBoundaryError("Memory text is required.");
    const entry: MemoryEntry = {
      id: randomUUID(),
      text: trimmed.slice(0, 4_000),
      tags: tags.map((tag) => tag.slice(0, 40)).slice(0, 8),
      scope: normalizeScope(edge.permissions?.scope),
      source,
      createdAt: new Date().toISOString(),
    };
    const file = this.memoryFile(node);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }
}
