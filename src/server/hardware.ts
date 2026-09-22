import os from "node:os";
import type { HardwareSnapshot } from "../shared/contracts.js";

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
    gpu: "unavailable",
    capturedAt: new Date().toISOString(),
  };
}

export function defaultMemoryBudgetMb(): number {
  const explicit = Number(process.env.AGENTIC_HARNESS_MEMORY_BUDGET_MB);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  return Math.max(1_024, Math.round((os.totalmem() / 1024 / 1024) * 0.5));
}
