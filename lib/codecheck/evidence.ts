/**
 * Evidence Bundle — trust layer for CodeCheck runs
 * Stores patch hashes, repo SHA, commands, logs, and reproduce instructions.
 * Written to .codecheck/evidence/<id>.json on disk (server-side only).
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";

export interface EvidenceCommand {
  command: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  output: string;
  source?: "server-executed" | "user-provided";
}

export interface EvidenceProvider {
  primaryModel: string;
  fallbackUsed?: boolean;
  latencyMs: number;
  errorCode?: string;
}

export interface EvidenceEnvironment {
  nodeVersion: string;
  npmVersion?: string;
  os: string;
  lockfileHash?: string;
}

export interface EvidenceRecord {
  id: string;
  createdAt: string;
  userId: string;
  action: "plan" | "implement" | "verify";
  taskId?: string;
  repoSha?: string;
  patchHash?: string;
  verificationCommands: string[];
  executedCommands: EvidenceCommand[];
  reproduce: { commands: string[]; notes: string[] };
  provider: EvidenceProvider;
  environment?: EvidenceEnvironment;
}

const EVIDENCE_DIR = path.join(process.cwd(), ".codecheck", "evidence");

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* best effort */ }
}

export function generateEvidenceId(): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

export function computePatchHash(diff: string): string {
  return crypto.createHash("sha256").update(diff, "utf8").digest("hex");
}

export function buildReproduceCommands(
  repoSha: string | undefined,
  verificationCommands: string[],
  taskScripts?: string[]
): { commands: string[]; notes: string[] } {
  const commands: string[] = [];
  const notes: string[] = [];

  if (repoSha) {
    commands.push(`git checkout ${repoSha}`);
    notes.push(`Repo was at commit ${repoSha.slice(0, 12)}`);
  } else {
    notes.push("No git SHA available — repo may not be a git repository");
  }

  commands.push("git apply <patch-file>");

  for (const cmd of verificationCommands) {
    if (!commands.includes(cmd)) commands.push(cmd);
  }

  if (taskScripts) {
    for (const s of taskScripts) {
      if (!commands.includes(s)) commands.push(s);
    }
  }

  return { commands, notes };
}

const LOCKFILE_CANDIDATES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
];

function hashLockfile(): string | undefined {
  const root = process.cwd();
  for (const name of LOCKFILE_CANDIDATES) {
    const fp = path.join(root, name);
    try {
      const buf = fs.readFileSync(fp);
      return crypto.createHash("sha256").update(buf).digest("hex");
    } catch { /* try next */ }
  }
  return undefined;
}

export function captureEnvironment(): EvidenceEnvironment {
  let npmVersion: string | undefined;
  try {
    npmVersion = execSync("npm --version", { timeout: 5000 }).toString().trim();
  } catch { /* optional */ }

  return {
    nodeVersion: process.version,
    npmVersion,
    os: `${process.platform} ${process.arch}`,
    lockfileHash: hashLockfile(),
  };
}

export function storeEvidence(record: EvidenceRecord): string {
  ensureDir(EVIDENCE_DIR);
  const filePath = path.join(EVIDENCE_DIR, `${record.id}.json`);
  fs.promises.writeFile(filePath, JSON.stringify(record, null, 2), "utf8")
    .catch(err => console.warn(`[Evidence] Failed to write evidence file: ${err instanceof Error ? err.message : err}`));
  return record.id;
}

export function createImplementEvidence(params: {
  userId: string;
  taskId: string;
  diff: string;
  repoSha?: string;
  verificationCommands: string[];
  provider: EvidenceProvider;
}): string {
  const id = generateEvidenceId();
  const patchHash = computePatchHash(params.diff);
  const reproduce = buildReproduceCommands(
    params.repoSha,
    params.verificationCommands
  );

  const record: EvidenceRecord = {
    id,
    createdAt: new Date().toISOString(),
    userId: params.userId,
    action: "implement",
    taskId: params.taskId,
    repoSha: params.repoSha,
    patchHash,
    verificationCommands: params.verificationCommands,
    executedCommands: [],
    reproduce,
    provider: params.provider,
    environment: captureEnvironment(),
  };

  return storeEvidence(record);
}

export function createVerifyEvidence(params: {
  userId: string;
  taskId: string;
  repoSha?: string;
  verificationCommands: string[];
  logs: { buildOutput?: string; tscOutput?: string; testOutput?: string };
  provider: EvidenceProvider;
}): string {
  const id = generateEvidenceId();
  const now = new Date().toISOString();

  const executedCommands: EvidenceCommand[] = [];
  if (params.logs.buildOutput) {
    executedCommands.push({
      command: "npm run build",
      exitCode: null,
      startedAt: now,
      endedAt: now,
      output: params.logs.buildOutput.slice(0, 10000),
      source: "user-provided",
    });
  }
  if (params.logs.tscOutput) {
    executedCommands.push({
      command: "npx tsc --noEmit",
      exitCode: null,
      startedAt: now,
      endedAt: now,
      output: params.logs.tscOutput.slice(0, 10000),
      source: "user-provided",
    });
  }
  if (params.logs.testOutput) {
    executedCommands.push({
      command: "(test runner)",
      exitCode: null,
      startedAt: now,
      endedAt: now,
      output: params.logs.testOutput.slice(0, 10000),
      source: "user-provided",
    });
  }

  const reproduce = buildReproduceCommands(
    params.repoSha,
    params.verificationCommands
  );

  const record: EvidenceRecord = {
    id,
    createdAt: now,
    userId: params.userId,
    action: "verify",
    taskId: params.taskId,
    repoSha: params.repoSha,
    verificationCommands: params.verificationCommands,
    executedCommands,
    reproduce: {
      ...reproduce,
      notes: [...reproduce.notes, "Logs were user-provided (not server-executed)"],
    },
    provider: params.provider,
    environment: captureEnvironment(),
  };

  return storeEvidence(record);
}
