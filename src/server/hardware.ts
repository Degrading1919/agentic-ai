import { execFile } from "node:child_process";
import os from "node:os";
import type { GpuDevice, GpuSnapshot, HardwareSnapshot } from "../shared/contracts.js";

let previousCpu = os.cpus().map((cpu) => ({ ...cpu.times }));

function cpuLoadPercent(): number {
  const current = os.cpus();
  let idleDelta = 0;
  let totalDelta = 0;

  current.forEach((cpu, index) => {
    const previous = previousCpu[index] ?? cpu.times;
    const times = cpu.times;
    const previousTotal = Object.values(previous).reduce((sum, value) => sum + value, 0);
    const currentTotal = Object.values(times).reduce((sum, value) => sum + value, 0);
    idleDelta += times.idle - previous.idle;
    totalDelta += currentTotal - previousTotal;
  });

  previousCpu = current.map((cpu) => ({ ...cpu.times }));
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1_000) / 10));
}

const GPU_QUERY = "index,name,memory.total,memory.used,utilization.gpu,temperature.gpu";

function parseNumber(value: string | undefined): number | null {
  const parsed = Number(value?.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` output. */
export function parseNvidiaSmi(output: string): GpuDevice[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [index, name, total, used, utilization, temperature] = line.split(",").map((part) => part.trim());
      const totalMb = parseNumber(total);
      const usedMb = parseNumber(used);
      if (totalMb === null || usedMb === null) return [];
      return [
        {
          index: parseNumber(index) ?? 0,
          name: name || "GPU",
          totalVramMb: Math.round(totalMb),
          usedVramMb: Math.round(usedMb),
          utilizationPercent: parseNumber(utilization),
          temperatureC: parseNumber(temperature),
        },
      ];
    });
}

/**
 * GPU telemetry from nvidia-smi when present. Queried asynchronously and
 * cached; snapshots never block on a subprocess and never invent values.
 */
class GpuMonitor {
  private latest: GpuSnapshot = { available: false, reason: "GPU probe has not completed yet." };
  private inflight: Promise<GpuSnapshot> | null = null;
  private lastProbe = 0;
  private disabled = process.env.AGENTIC_HARNESS_GPU_TELEMETRY === "off";

  probe(): Promise<GpuSnapshot> {
    if (this.disabled) {
      this.latest = { available: false, reason: "GPU telemetry disabled by configuration." };
      return Promise.resolve(this.latest);
    }
    if (this.inflight) return this.inflight;
    this.lastProbe = Date.now();
    this.inflight = new Promise<GpuSnapshot>((resolve) => {
      execFile(
        "nvidia-smi",
        [`--query-gpu=${GPU_QUERY}`, "--format=csv,noheader,nounits"],
        { timeout: 3_000, windowsHide: true },
        (error, stdout) => {
          if (error) {
            const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
            resolve({
              available: false,
              reason: missing ? "No supported GPU telemetry provider (nvidia-smi not found)." : `nvidia-smi failed: ${error.message}`,
            });
            return;
          }
          const devices = parseNvidiaSmi(stdout);
          resolve(
            devices.length
              ? { available: true, source: "nvidia-smi", devices, capturedAt: new Date().toISOString() }
              : { available: false, reason: "nvidia-smi returned no devices." },
          );
        },
      );
    }).then((snapshot) => {
      this.latest = snapshot;
      this.inflight = null;
      // A missing binary will not appear later in this process.
      if (!snapshot.available && snapshot.reason.includes("not found")) this.disabled = true;
      return snapshot;
    });
    return this.inflight;
  }

  current(): GpuSnapshot {
    if (Date.now() - this.lastProbe > 2_000) void this.probe();
    return this.latest;
  }
}

export const gpuMonitor = new GpuMonitor();

export function getHardwareSnapshot(): HardwareSnapshot {
  const cpus = os.cpus();
  const totalRam = os.totalmem();
  const freeRam = os.freemem();

  return {
    platform: `${os.platform()} ${os.arch()}`,
    cpuModel: cpus[0]?.model ?? "Unknown CPU",
    logicalCores: cpus.length,
    loadPercent: cpuLoadPercent(),
    totalRamMb: Math.round(totalRam / 1024 / 1024),
    usedRamMb: Math.round((totalRam - freeRam) / 1024 / 1024),
    processRamMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    gpu: gpuMonitor.current(),
    capturedAt: new Date().toISOString(),
  };
}

export function defaultMemoryBudgetMb(): number {
  const explicit = Number(process.env.AGENTIC_HARNESS_MEMORY_BUDGET_MB);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  return Math.max(1_024, Math.round((os.totalmem() / 1024 / 1024) * 0.5));
}

/**
 * VRAM budget: explicit configuration wins; otherwise 90% of the largest
 * detected GPU. `null` means VRAM is not enforced because it is unknown.
 */
export function vramBudgetFrom(gpu: GpuSnapshot): number | null {
  const explicit = Number(process.env.AGENTIC_HARNESS_VRAM_BUDGET_MB);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  if (!gpu.available) return null;
  const largest = Math.max(...gpu.devices.map((device) => device.totalVramMb));
  return Math.round(largest * 0.9);
}
