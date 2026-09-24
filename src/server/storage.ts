import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { StorageNode, TopologyEdge } from "../shared/contracts.js";
import { slugify } from "../shared/capabilities.js";

export const MAX_READ_BYTES = 64 * 1024;
export const MAX_WRITE_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_SEGMENTS = 32;

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
  const resolved = path.resolve(value);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

export function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = comparable(root);
  const normalizedCandidate = comparable(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`)
  );
}

const windowsReserved = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const forbiddenCharacters = /[<>"|?*\u0000-\u001f]/;

/**
 * Validate a scope or path lexically and return its segments.
 *
 * Rejected on every platform so behaviour does not depend on the host:
 * drive-qualified paths (`C:`, `C:/x`), UNC and device paths (`//server`,
 * `\\?\`, `\\.\`), `..`, colons (drive letters and NTFS alternate data
 * streams), control and wildcard characters, reserved Windows device names,
 * and segments ending in a dot or space (Windows silently strips them).
 */
export function validateRelativeSegments(
  input: string | undefined,
  kind: "scope" | "path",
): string[] {
  const raw = input ?? "";
  const normalized = raw.replaceAll("\\", "/");
  if (/^\/\//.test(normalized)) {
    throw new StorageBoundaryError(`UNC and device paths are not allowed in a storage ${kind}.`);
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new StorageBoundaryError(`Drive-qualified paths are not allowed in a storage ${kind}.`);
  }
  if (kind === "path" && normalized.startsWith("/")) {
    throw new StorageBoundaryError("Paths must be relative to the storage scope.");
  }
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length > MAX_SEGMENTS) throw new StorageBoundaryError(`The ${kind} is nested too deeply.`);
  for (const segment of segments) {
    if (segment === "..") throw new StorageBoundaryError(`'..' is not allowed in a storage ${kind}.`);
    if (segment.includes(":")) {
      throw new StorageBoundaryError(`':' is not allowed in a storage ${kind} (drive letters and alternate streams).`);
    }
    if (forbiddenCharacters.test(segment)) {
      throw new StorageBoundaryError(`The ${kind} contains a character that is not allowed: '${segment}'.`);
    }
    if (windowsReserved.test(segment)) throw new StorageBoundaryError(`'${segment}' is a reserved device name.`);
    if (/[. ]$/.test(segment)) {
      throw new StorageBoundaryError(`Segments may not end with a dot or space: '${segment}'.`);
    }
  }
  return segments;
}

/** Normalize an edge scope ("/runs", "runs/", "") to a relative POSIX-style path. */
export function normalizeScope(scope: string | undefined): string {
  return validateRelativeSegments(scope ?? "/", "scope").join("/");
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

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Physical storage adapters behind storage edges. Every call receives the
 * edge so read/write permissions and scope are enforced at the adapter, not
 * only in prompt text.
 *
 * Containment model: the node's configured location is trusted (the topology
 * editor chose it) and is canonicalized once. Below it, every path component
 * — scope and requested path alike — is resolved one step at a time with
 * `lstat`; symbolic links and junctions are never followed, and each existing
 * component's real path must equal its lexical path (which also rejects
 * mount points and other reparse points). Reads and writes re-validate after
 * opening or before renaming to narrow time-of-check/time-of-use races.
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

  private async canonicalRoot(node: StorageNode): Promise<string> {
    const root = this.rootFor(node);
    await mkdir(root, { recursive: true });
    return realpath(root);
  }

  /**
   * Resolve segments below a canonical root without following links.
   * Missing trailing components are allowed (the path may be created later)
   * unless `createDirectories` asks for the parents to be created safely.
   */
  private async walk(realRoot: string, segments: string[], createDirectories: boolean): Promise<string> {
    let current = realRoot;
    for (const [index, segment] of segments.entries()) {
      const next = path.join(current, segment);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(next);
      } catch (error) {
        if (!isMissing(error)) throw error;
        const isParent = index < segments.length - 1;
        if (!(createDirectories && isParent)) {
          return path.join(current, ...segments.slice(index));
        }
        try {
          await mkdir(next);
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        info = await lstat(next);
      }
      if (info.isSymbolicLink()) {
        throw new StorageBoundaryError(
          `'${segments.slice(0, index + 1).join("/")}' is a link or junction; storage never follows links.`,
        );
      }
      const real = await realpath(next);
      if (comparable(real) !== comparable(next)) {
        throw new StorageBoundaryError(
          `'${segments.slice(0, index + 1).join("/")}' resolves elsewhere (reparse point); access denied.`,
        );
      }
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw new StorageBoundaryError(`'${segments.slice(0, index + 1).join("/")}' is not a directory.`);
      }
      current = next;
    }
    if (!isInside(realRoot, current)) throw new StorageBoundaryError("Path escapes the storage root.");
    return current;
  }

  private segmentsFor(edge: TopologyEdge, relativePath: string): { scope: string[]; target: string[] } {
    const scope = validateRelativeSegments(edge.permissions?.scope ?? "/", "scope");
    const target = validateRelativeSegments(relativePath || ".", "path");
    return { scope, target };
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
    const { scope, target } = this.segmentsFor(edge, relativePath);
    const realRoot = await this.canonicalRoot(node);
    const scopeRoot = await this.walk(realRoot, scope, false);
    const resolved = await this.walk(realRoot, [...scope, ...target], false);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(resolved);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return target.length === 0 ? "(empty)" : `Not found: ${relativePath}`;
    }
    const display = (absolute: string) => path.relative(scopeRoot, absolute).replaceAll("\\", "/");
    if (!info.isDirectory()) return `${display(resolved)} (file, ${info.size} bytes)`;
    const entries = await readdir(resolved, { withFileTypes: true });
    const lines = entries
      .filter((entry) => !entry.name.startsWith(".tmp-"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_LIST_ENTRIES)
      .map((entry) => {
        const kind = entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir " : "file";
        return `${kind} ${display(path.join(resolved, entry.name))}${entry.isSymbolicLink() ? " (not followed)" : ""}`;
      });
    const more = entries.length > MAX_LIST_ENTRIES ? `\n… ${entries.length - MAX_LIST_ENTRIES} more` : "";
    return lines.length ? `${lines.join("\n")}${more}` : "(empty)";
  }

  async read(node: StorageNode, edge: TopologyEdge, relativePath: string): Promise<string> {
    this.requirePermission(edge, "read", node);
    const { scope, target } = this.segmentsFor(edge, relativePath);
    if (target.length === 0) throw new StorageBoundaryError("A file path is required.");
    const realRoot = await this.canonicalRoot(node);
    const resolved = await this.walk(realRoot, [...scope, ...target], false);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(resolved);
    } catch (error) {
      if (isMissing(error)) throw new StorageBoundaryError(`File not found: ${relativePath}`);
      throw error;
    }
    if (!info.isFile()) throw new StorageBoundaryError(`Not a file: ${relativePath}`);
    const handle = await open(resolved, "r");
    try {
      // Re-validate after opening: the opened object must still be the file we checked.
      const again = await this.walk(realRoot, [...scope, ...target], false);
      const [opened, current] = await Promise.all([handle.stat({ bigint: true }), stat(again, { bigint: true })]);
      if (opened.ino !== current.ino || opened.dev !== current.dev) {
        throw new StorageBoundaryError("The file changed while it was being opened; access denied.");
      }
      const buffer = Buffer.alloc(Math.min(Number(opened.size), MAX_READ_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      return Number(opened.size) > MAX_READ_BYTES
        ? `${text}\n[…truncated: ${opened.size} bytes total]`
        : text;
    } finally {
      await handle.close();
    }
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
    const { scope, target } = this.segmentsFor(edge, relativePath);
    if (target.length === 0) throw new StorageBoundaryError("A file name is required.");
    const realRoot = await this.canonicalRoot(node);
    const segments = [...scope, ...target];
    const destination = await this.walk(realRoot, segments, true);
    try {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new StorageBoundaryError(`'${relativePath}' exists and is not a regular file.`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = path.dirname(destination);
    const temporary = path.join(parent, `.tmp-${randomUUID()}`);
    // `wx` creates a new file exclusively; it can never write through an existing link.
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    try {
      // Re-validate the parent chain immediately before publishing the file.
      const parentAgain = await this.walk(realRoot, segments.slice(0, -1), false);
      if (comparable(parentAgain) !== comparable(parent)) {
        throw new StorageBoundaryError("The destination changed while writing; access denied.");
      }
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return { path: destination, bytes };
  }

  private async memoryFile(node: StorageNode): Promise<string> {
    const realRoot = await this.canonicalRoot(node);
    const file = path.join(realRoot, "memory.jsonl");
    try {
      if ((await lstat(file)).isSymbolicLink()) {
        throw new StorageBoundaryError("The memory file is a link; storage never follows links.");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return file;
  }

  async readMemory(node: StorageNode): Promise<MemoryEntry[]> {
    const file = await this.memoryFile(node);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
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

  /**
   * Append a note. With `entryId` (an operation ID) the append is idempotent:
   * repeating it after an interrupted call returns the existing entry.
   */
  async remember(
    node: StorageNode,
    edge: TopologyEdge,
    text: string,
    tags: string[],
    source: MemoryEntry["source"],
    entryId?: string,
  ): Promise<MemoryEntry> {
    this.requirePermission(edge, "write", node);
    const trimmed = text.trim();
    if (!trimmed) throw new StorageBoundaryError("Memory text is required.");
    if (entryId) {
      const existing = (await this.readMemory(node)).find((entry) => entry.id === entryId);
      if (existing) return existing;
    }
    const entry: MemoryEntry = {
      id: entryId ?? randomUUID(),
      text: trimmed.slice(0, 4_000),
      tags: tags.map((tag) => tag.slice(0, 40)).slice(0, 8),
      scope: normalizeScope(edge.permissions?.scope),
      source,
      createdAt: new Date().toISOString(),
    };
    const file = await this.memoryFile(node);
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }
}
