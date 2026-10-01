/**
 * gremlins: the runtime's half of each pulse. The egg posts pulses (it holds the board identity and the
 * balance reader); the runtime contributes what only it knows, via GREMLIN_HOME/status.json.
 */
import fs from "fs";
import path from "path";

export interface RuntimeStatus {
  tier?: "normal" | "low_compute" | "critical" | "dead";
  creditsCents?: number;
  goals?: { goal: string; progressPct: number; note?: string }[];
  /** Most recent first, at most 5. */
  highlights?: string[];
  models?: string[];
  host?: string;
  updatedAt?: string;
}

const file = () => path.join(process.env.GREMLIN_HOME ?? "/var/lib/gremlin", "status.json");

export function readStatus(): RuntimeStatus {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf-8"));
  } catch {
    return {};
  }
}

export function updateStatus(patch: RuntimeStatus & { highlight?: string }): RuntimeStatus {
  const { highlight, ...rest } = patch;
  const cur = readStatus();
  const next: RuntimeStatus = {
    ...cur,
    ...rest,
    highlights: highlight ? [highlight.slice(0, 280), ...(cur.highlights ?? [])].slice(0, 5) : cur.highlights,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file() + ".tmp", JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(file() + ".tmp", file());
  return next;
}
