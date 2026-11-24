import { execFile } from "node:child_process";
import { createReadStream, unwatchFile, watchFile } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export interface SessionInfo {
  id: string;
  file: string;
  title: string;
  cwd: string | null;
  updatedAt: Date;
  active: boolean;
}

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

const PROJECTS_DIR = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

async function* readEntries(file: string): AsyncGenerator<Record<string, any>> {
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {}
  }
}

function userText(entry: Record<string, any>): string | null {
  if (entry.type !== "user" || entry.isSidechain || entry.isMeta) return null;
  const content = entry.message?.content;
  let text: string | null = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const parts = content.filter((b: any) => b?.type === "text").map((b: any) => b.text);
    text = parts.length ? parts.join("\n") : null;
  }
  if (!text) return null;
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text || text.startsWith("<command-") || text.startsWith("<local-command") || text.startsWith("Caveat:")) return null;
  return text;
}

function assistantText(entry: Record<string, any>): string | null {
  if (entry.type !== "assistant" || entry.isSidechain) return null;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
  return text || null;
}

async function summarize(file: string, id: string, mtime: Date): Promise<SessionInfo | null> {
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let firstPrompt: string | null = null;
  let cwd: string | null = null;
  let hasConversation = false;

  for await (const e of readEntries(file)) {
    if (e.type === "custom-title" && e.customTitle) customTitle = e.customTitle;
    else if (e.type === "ai-title" && e.aiTitle) aiTitle = e.aiTitle;
    if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
    const text = userText(e);
    if (text) {
      hasConversation = true;
      if (!firstPrompt) firstPrompt = text;
    }
  }
  if (!hasConversation) return null;

  const title = (customTitle ?? aiTitle ?? firstPrompt ?? "(untitled)").replace(/\s+/g, " ").slice(0, 80);
  return { id, file, title, cwd, updatedAt: mtime, active: Date.now() - mtime.getTime() < ACTIVE_WINDOW_MS };
}

export async function listSessions(limit = 10, excludeCwdPrefix?: string): Promise<SessionInfo[]> {
  let projects: string[];
  try {
    projects = await readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  const files: { file: string; id: string; mtime: Date }[] = [];
  for (const project of projects) {
    const dir = path.join(PROJECTS_DIR, project);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      try {
        const s = await stat(file);
        if (s.isFile()) files.push({ file, id: name.slice(0, -".jsonl".length), mtime: s.mtime });
      } catch {}
    }
  }

  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const sessions: SessionInfo[] = [];
  for (const f of files) {
    if (sessions.length >= limit) break;
    const info = await summarize(f.file, f.id, f.mtime);
    if (!info) continue;
    if (excludeCwdPrefix && info.cwd?.startsWith(excludeCwdPrefix)) continue;
    sessions.push(info);
  }
  return sessions;
}

export async function findSession(id: string): Promise<SessionInfo | null> {
  let projects: string[];
  try {
    projects = await readdir(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const project of projects) {
    const file = path.join(PROJECTS_DIR, project, `${id}.jsonl`);
    try {
      const s = await stat(file);
      if (s.isFile()) return summarize(file, id, s.mtime);
    } catch {}
  }
  return null;
}

export async function readTranscriptTail(file: string, count: number): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  for await (const e of readEntries(file)) {
    const u = userText(e);
    if (u) {
      entries.push({ role: "user", text: u });
      continue;
    }
    const a = assistantText(e);
    if (a) {
      const last = entries[entries.length - 1];
      if (last?.role === "assistant") last.text += "\n\n" + a;
      else entries.push({ role: "assistant", text: a });
    }
    if (entries.length > count * 4) entries.splice(0, entries.length - count * 2);
  }
  return entries.slice(-count);
}

export interface LiveSession {
  sessionId: string;
  kind: string;
  status: string;
  pid: number;
}

export function liveSessions(cliPath: string): Promise<Map<string, LiveSession>> {
  return new Promise((resolve) => {
    execFile(cliPath, ["agents", "--json"], { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      const map = new Map<string, LiveSession>();
      if (err && !stdout) return resolve(map);
      try {
        for (const a of JSON.parse(stdout) as any[]) {
          if (!a?.sessionId || (a.kind !== "interactive" && a.kind !== "background")) continue;
          map.set(a.sessionId, { sessionId: a.sessionId, kind: a.kind, status: a.status ?? "unknown", pid: a.pid });
        }
      } catch {}
      resolve(map);
    });
  });
}

export type WatchedEvent =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; input: Record<string, any> }
  | { kind: "continued"; sessionId: string };

export class TranscriptWatcher {
  private offset = 0;
  private partial = "";
  private reading = false;
  private stopped = false;

  constructor(
    private readonly file: string,
    private readonly onEvents: (events: WatchedEvent[]) => void,
  ) {}

  async start(): Promise<void> {
    try {
      this.offset = (await stat(this.file)).size;
    } catch {
      this.offset = 0;
    }
    watchFile(this.file, { interval: 1000 }, () => void this.read());
  }

  stop(): void {
    this.stopped = true;
    unwatchFile(this.file);
  }

  async skipToEnd(): Promise<void> {
    while (this.reading) await new Promise((r) => setTimeout(r, 50));
    try {
      this.offset = (await stat(this.file)).size;
    } catch {}
    this.partial = "";
  }

  private async read(): Promise<void> {
    if (this.reading || this.stopped) return;
    this.reading = true;
    try {
      const size = (await stat(this.file)).size;
      if (size < this.offset) this.offset = 0;
      if (size === this.offset) return;
      const fh = await open(this.file, "r");
      try {
        const buf = Buffer.alloc(size - this.offset);
        await fh.read(buf, 0, buf.length, this.offset);
        this.offset = size;
        const chunk = this.partial + buf.toString("utf8");
        const lines = chunk.split("\n");
        this.partial = lines.pop() ?? "";
        const events: WatchedEvent[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          let e: Record<string, any>;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          if (e.type === "continued-in" && typeof e.continuedInSessionId === "string") {
            events.push({ kind: "continued", sessionId: e.continuedInSessionId });
            continue;
          }
          const u = userText(e);
          if (u) {
            events.push({ kind: "user", text: u });
            continue;
          }
          if (e.type === "assistant" && !e.isSidechain && Array.isArray(e.message?.content)) {
            for (const b of e.message.content) {
              if (b?.type === "text" && b.text?.trim()) events.push({ kind: "assistant", text: b.text.trim() });
              else if (b?.type === "tool_use") events.push({ kind: "tool", name: b.name, input: b.input ?? {} });
            }
          }
        }
        if (events.length && !this.stopped) this.onEvents(events);
      } finally {
        await fh.close();
      }
    } catch {
    } finally {
      this.reading = false;
    }
  }
}
