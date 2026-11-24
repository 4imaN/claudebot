import "dotenv/config";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Bot, InlineKeyboard, InputFile, type Api, type Context } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  findSession,
  listSessions,
  liveSessions,
  readTranscriptTail,
  TranscriptWatcher,
  type LiveSession,
  type WatchedEvent,
} from "./sessions.js";
import {
  cleanupMedia,
  downloadTelegramFile,
  imageInput,
  listAppNames,
  screenshot,
  toJpeg,
  videoFrames,
  type ImageInput,
} from "./media.js";

type Provider = "claude" | "gpt";

interface UserInput {
  text: string;
  images: ImageInput[];
}

interface CodeSession {
  sessionId: string | null;
  cwd: string;
  title: string;
}

interface ChatState {
  provider: Provider;
  claudeHistory: Anthropic.Beta.BetaMessageParam[];
  claudeSessionId: string | null;
  gptHistory: OpenAI.Chat.ChatCompletionMessageParam[];
  code: CodeSession | null;
  running: ChildProcess | null;
  botTurn: boolean;
  watcher: { sessionId: string; watcher: TranscriptWatcher } | null;
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");

const CLAUDE_BACKEND = process.env.CLAUDE_BACKEND === "api" ? "api" : "cli";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH ?? "claude";
const CLAUDE_CLI_TOOLS = process.env.CLAUDE_CLI_TOOLS ?? "";
const CLAUDE_CLI_CWD = path.resolve(process.env.CLAUDE_CLI_CWD ?? "workspace");
const CLAUDE_CLI_TIMEOUT_MS = Number(process.env.CLAUDE_CLI_TIMEOUT_MS ?? 300000);
const CLAUDE_CODE_PERMISSION_MODE = process.env.CLAUDE_CODE_PERMISSION_MODE ?? "auto";
const CLAUDE_CODE_TIMEOUT_MS = Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 30 * 60 * 1000);
const CLAUDE_CODE_DEFAULT_DIR = expandHome(process.env.CLAUDE_CODE_DEFAULT_DIR ?? os.homedir());
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5";
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ??
  "You are a helpful assistant chatting over Telegram. Keep replies concise and conversational unless asked for detail.";
const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES ?? 40);
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const anthropic = CLAUDE_BACKEND === "api" && process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const claudeEnabled = CLAUDE_BACKEND === "cli" || anthropic !== null;
const claudeLabel =
  CLAUDE_BACKEND === "cli" ? `local Claude Code, ${process.env.CLAUDE_MODEL ?? "default model"}` : CLAUDE_MODEL;
const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;

if (CLAUDE_BACKEND === "cli") mkdirSync(CLAUDE_CLI_CWD, { recursive: true });

let keepAwake: ChildProcess | null = null;
if (process.platform === "darwin" && process.env.KEEP_AWAKE !== "false") {
  keepAwake = spawn("caffeinate", ["-is", "-w", String(process.pid)], { stdio: "ignore" });
  keepAwake.on("error", (err) => {
    console.error("caffeinate failed:", err.message);
    keepAwake = null;
  });
  keepAwake.on("exit", () => (keepAwake = null));
}

const defaultProvider: Provider = claudeEnabled ? "claude" : "gpt";
const chats = new Map<number, ChatState>();
const chatQueues = new Map<number, Promise<unknown>>();

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function enqueue<T>(chatId: number, task: () => Promise<T>): Promise<T> {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(task, task);
  chatQueues.set(chatId, next.catch(() => {}));
  return next;
}

function getState(chatId: number): ChatState {
  let state = chats.get(chatId);
  if (!state) {
    state = {
      provider: defaultProvider,
      claudeHistory: [],
      claudeSessionId: null,
      gptHistory: [],
      code: null,
      running: null,
      botTurn: false,
      watcher: null,
    };
    chats.set(chatId, state);
  }
  return state;
}

const STATE_FILE = path.resolve(process.env.STATE_FILE ?? "data/state.json");

function saveState() {
  const out: Record<string, { provider: Provider; code: CodeSession | null }> = {};
  for (const [chatId, st] of chats) out[chatId] = { provider: st.provider, code: st.code };
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(out, null, 2));
  } catch (err) {
    console.error("Failed to save state:", err);
  }
}

function loadState(): number[] {
  let data: Record<string, { provider?: Provider; code?: CodeSession | null }>;
  try {
    data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return [];
  }
  const restored: number[] = [];
  for (const [key, saved] of Object.entries(data)) {
    const chatId = Number(key);
    if (!Number.isFinite(chatId)) continue;
    const st = getState(chatId);
    if (saved.provider === "claude" || saved.provider === "gpt") st.provider = saved.provider;
    if (saved.code?.cwd) {
      st.code = saved.code;
      restored.push(chatId);
    }
  }
  return restored;
}

function trimHistory<T extends { role: string }>(history: T[]): T[] {
  if (history.length <= MAX_HISTORY_MESSAGES) return history;
  let trimmed = history.slice(history.length - MAX_HISTORY_MESSAGES);
  while (trimmed.length && trimmed[0].role !== "user") trimmed = trimmed.slice(1);
  return trimmed;
}

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function timeAgo(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function splitMessage(text: string, limit = 4000): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

async function sendLong(api: Api, chatId: number, text: string) {
  for (const part of splitMessage(text)) await api.sendMessage(chatId, part);
}

interface CliEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  message?: { content?: any[] };
}

interface CliRunOptions {
  args: string[];
  input: UserInput;
  cwd: string;
  timeoutMs: number;
  state: ChatState;
  onEvent?: (e: CliEvent) => void;
}

function runClaudeCli(opts: CliRunOptions): Promise<CliEvent> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_CLI_PATH, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...opts.args], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    opts.state.running = child;

    let finalEvent: CliEvent | null = null;
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    child.stderr.on("data", (d) => (stderr += d.toString()));
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let event: CliEvent;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "result") finalEvent = event;
      try {
        opts.onEvent?.(event);
      } catch (err) {
        console.error("onEvent error:", err);
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      opts.state.running = null;
      reject(
        new Error(
          err.code === "ENOENT"
            ? `Could not find the claude CLI at "${CLAUDE_CLI_PATH}". Set CLAUDE_CLI_PATH.`
            : `Failed to start claude: ${err.message}`,
        ),
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      opts.state.running = null;
      if (finalEvent) return resolve(finalEvent);
      if (timedOut) return reject(new Error(`Claude timed out after ${Math.round(opts.timeoutMs / 1000)}s.`));
      if (signal) return reject(new Error("Stopped."));
      reject(new Error(`claude exited with code ${code}: ${truncate(stderr.trim(), 500)}`));
    });

    const content = [
      ...opts.input.images.map((img) => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      })),
      { type: "text", text: opts.input.text },
    ];
    child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  });
}

async function askClaudeChatCli(state: ChatState, input: UserInput): Promise<string> {
  const args = ["--tools", CLAUDE_CLI_TOOLS, "--append-system-prompt", SYSTEM_PROMPT];
  if (process.env.CLAUDE_CLI_ALLOW_MCP !== "true") args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);
  if (state.claudeSessionId) args.push("--resume", state.claudeSessionId);

  const out = await runClaudeCli({
    args,
    input,
    cwd: CLAUDE_CLI_CWD,
    timeoutMs: CLAUDE_CLI_TIMEOUT_MS,
    state,
    onEvent: (e) => {
      if (e.type === "system" && e.subtype === "init" && e.session_id) state.claudeSessionId = e.session_id;
    },
  });
  if (out.session_id) state.claudeSessionId = out.session_id;
  if (out.is_error) throw new Error(`Local Claude error (${out.subtype ?? "unknown"}): ${out.result ?? ""}`.trim());
  return out.result?.trim() || "(empty response)";
}

async function askClaudeApi(state: ChatState, input: UserInput): Promise<string> {
  if (!anthropic) throw new Error("ANTHROPIC_API_KEY is not set");
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...input.images.map(
      (img): Anthropic.Beta.BetaImageBlockParam => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      }),
    ),
    { type: "text", text: input.text },
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = [...state.claudeHistory, { role: "user", content }];

  const response = await anthropic.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages,
  });

  if (response.stop_reason === "refusal") return "Claude declined to answer that one.";

  state.claudeHistory = [...messages, { role: "assistant", content: response.content }];
  const reply = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return reply || "(empty response)";
}

async function askGpt(state: ChatState, input: UserInput): Promise<string> {
  if (!openai) throw new Error("OPENAI_API_KEY is not set");
  const content: OpenAI.Chat.ChatCompletionContentPart[] = [
    { type: "text", text: input.text },
    ...input.images.map(
      (img): OpenAI.Chat.ChatCompletionContentPart => ({
        type: "image_url",
        image_url: { url: `data:${img.mediaType};base64,${img.data}` },
      }),
    ),
  ];
  const history = trimHistory<OpenAI.Chat.ChatCompletionMessageParam>([
    ...state.gptHistory,
    { role: "user", content: input.images.length ? content : input.text },
  ]);

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
  });

  const reply = completion.choices[0]?.message?.content?.trim() ?? "";
  state.gptHistory = [...history, { role: "assistant", content: reply }];
  return reply || "(empty response)";
}

function describeToolUse(block: any): string {
  const input = block.input ?? {};
  const detail =
    input.description ??
    input.command ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.url ??
    input.query ??
    input.prompt ??
    "";
  return `🔧 ${block.name}${detail ? `: ${truncate(String(detail).replace(/\s+/g, " "), 120)}` : ""}`;
}

function liveLabel(live: LiveSession): string {
  const where = live.kind === "background" ? "running in the background" : "open in a terminal";
  return `${where} (${live.status})`;
}

function stopWatcher(state: ChatState) {
  state.watcher?.watcher.stop();
  state.watcher = null;
}

function formatMirrored(events: WatchedEvent[]): string {
  const lines: string[] = ["🖥 From your terminal:"];
  for (const e of events) {
    if (e.kind === "user") lines.push(`\n🧑 You: ${truncate(e.text, 1500)}`);
    else if (e.kind === "assistant") lines.push(`\n🤖 Claude: ${truncate(e.text, 3000)}`);
    else if (e.kind === "tool") lines.push(describeToolUse({ name: e.name, input: e.input }));
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

async function ensureWatcher(api: Api, chatId: number, state: ChatState): Promise<void> {
  const id = state.code?.sessionId;
  if (!id) return stopWatcher(state);
  if (state.watcher?.sessionId === id) return;
  stopWatcher(state);
  saveState();
  const session = await findSession(id);
  if (!session || state.code?.sessionId !== id) return;
  const watcher = new TranscriptWatcher(session.file, (events) => {
    if (state.botTurn || state.watcher?.watcher !== watcher) return;
    const text = formatMirrored(events);
    if (text) sendLong(api, chatId, text).catch((err) => console.error(err));
    const moved = events.find((e): e is Extract<WatchedEvent, { kind: "continued" }> => e.kind === "continued");
    if (moved && state.code?.sessionId === id) {
      state.code.sessionId = moved.sessionId;
      saveState();
      api
        .sendMessage(chatId, `↪️ The session continued under a new ID (${moved.sessionId}). Following it.`)
        .catch(() => {});
      ensureWatcher(api, chatId, state).catch((err) => console.error(err));
    }
  });
  state.watcher = { sessionId: id, watcher };
  saveState();
  await watcher.start();
}

async function runCodeTurn(api: Api, chatId: number, state: ChatState, input: UserInput): Promise<void> {
  const code = state.code!;
  const args = ["--permission-mode", CLAUDE_CODE_PERMISSION_MODE];
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);
  const originalId = code.sessionId;
  let forked = false;
  if (originalId) {
    args.push("--resume", originalId);
    const live = (await liveSessions(CLAUDE_CLI_PATH)).get(originalId);
    if (live) {
      args.push("--fork-session");
      forked = true;
      await api
        .sendMessage(
          chatId,
          `ℹ️ This session is ${liveLabel(live)}, so I'm continuing in a copy to avoid clashing with it. Your terminal session is untouched.`,
        )
        .catch(() => {});
    }
  }

  const progress: string[] = [];
  let statusMsgId: number | null = null;
  let lastRendered = "";
  let flushTimer: NodeJS.Timeout | null = null;
  const sentTexts = new Set<string>();
  let sendChain: Promise<unknown> = Promise.resolve();

  const renderStatus = () => {
    const shown = progress.slice(-15);
    const hidden = progress.length - shown.length;
    return [`⚙️ Working in ${shortPath(code.cwd)}`, ...(hidden > 0 ? [`… ${hidden} earlier steps`] : []), ...shown].join(
      "\n",
    );
  };

  const flushStatus = () => {
    flushTimer = null;
    const body = truncate(renderStatus(), 4000);
    if (body === lastRendered) return;
    lastRendered = body;
    sendChain = sendChain.then(async () => {
      try {
        if (statusMsgId === null) statusMsgId = (await api.sendMessage(chatId, body)).message_id;
        else await api.editMessageText(chatId, statusMsgId, body);
      } catch {}
    });
  };

  const scheduleFlush = () => {
    if (!flushTimer) flushTimer = setTimeout(flushStatus, 1200);
  };

  const sendText = (t: string) => {
    sentTexts.add(t.trim());
    sendChain = sendChain.then(() => sendLong(api, chatId, t).catch((err) => console.error(err)));
  };

  const typing = setInterval(() => api.sendChatAction(chatId, "typing").catch(() => {}), 4500);
  api.sendChatAction(chatId, "typing").catch(() => {});
  state.botTurn = true;

  try {
    const result = await runClaudeCli({
      args,
      input,
      cwd: code.cwd,
      timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
      state,
      onEvent: (e) => {
        if (e.type === "system" && e.subtype === "init" && e.session_id) code.sessionId = e.session_id;
        if (e.type !== "assistant" || !Array.isArray(e.message?.content)) return;
        for (const block of e.message!.content!) {
          if (block?.type === "tool_use") {
            progress.push(describeToolUse(block));
            scheduleFlush();
          } else if (block?.type === "text" && block.text?.trim()) {
            sendText(block.text);
          }
        }
      },
    });

    if (result.session_id) code.sessionId = result.session_id;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushStatus();
    }
    if (progress.length) {
      progress.push(result.is_error ? "❌ Finished with an error" : "✅ Done");
      flushStatus();
    }

    const finalText = result.result?.trim();
    if (result.is_error) sendText(`⚠️ Claude error (${result.subtype ?? "unknown"})${finalText ? `: ${finalText}` : ""}`);
    else if (finalText && !sentTexts.has(finalText)) sendText(finalText);
    else if (!finalText && sentTexts.size === 0) sendText("(no text response)");
    if (forked && code.sessionId && code.sessionId !== originalId) {
      sendText(`🔀 Now in the copy: ${code.sessionId}\nOn your computer: claude --resume ${code.sessionId}`);
    }
  } finally {
    clearInterval(typing);
    if (flushTimer) clearTimeout(flushTimer);
    await sendChain;
    if (state.watcher && state.watcher.sessionId === code.sessionId) await state.watcher.watcher.skipToEnd();
    state.botTurn = false;
    await ensureWatcher(api, chatId, state).catch((err) => console.error(err));
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic API key is invalid.";
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate limited, try again shortly.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  if (err instanceof OpenAI.AuthenticationError) return "OpenAI API key is invalid.";
  if (err instanceof OpenAI.RateLimitError) return "ChatGPT is rate limited (or out of quota), try again shortly.";
  if (err instanceof OpenAI.APIError) return `OpenAI API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function codeModeAllowed(): boolean {
  return CLAUDE_BACKEND === "cli" && ALLOWED_USER_IDS.size > 0;
}

const CODE_MODE_LOCKED =
  "Claude Code sessions give whoever texts this bot full access to your computer, so they're only enabled when ALLOWED_USER_IDS is set in .env (and CLAUDE_BACKEND=cli). Send /whoami, add your ID, and restart the bot.";

function modeLabel(state: ChatState): string {
  if (state.code) {
    return `Claude Code session: ${state.code.title}\nFolder: ${shortPath(state.code.cwd)}\nSession ID: ${state.code.sessionId ?? "(starts on first message)"}\nPermission mode: ${CLAUDE_CODE_PERMISSION_MODE}`;
  }
  return state.provider === "claude" ? `Chat with Claude (${claudeLabel})` : `Chat with ChatGPT (${OPENAI_MODEL})`;
}

const bot = new Bot(TELEGRAM_BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (ALLOWED_USER_IDS.size === 0) return next();
  const id = ctx.from?.id;
  if (id && ALLOWED_USER_IDS.has(String(id))) return next();
  if (ctx.message) await ctx.reply(`Not authorized. Your Telegram user ID is ${id}.`);
  else if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Not authorized." });
});

bot.command(["start", "help"], (ctx) => {
  const state = getState(ctx.chat.id);
  return ctx.reply(
    [
      `Mode: ${modeLabel(state)}`,
      "",
      "Chat:",
      "/claude – chat with Claude",
      "/gpt – chat with ChatGPT",
      "/reset – clear the chat conversation",
      "",
      "Claude Code (your computer):",
      "/sessions – list your Claude Code sessions and continue one",
      "/new <folder> – start a new Claude Code session in a folder",
      "/recap – show the latest messages of the current session",
      "/stop – stop what Claude is doing right now",
      "/exit – leave the Claude Code session, back to chat",
      "",
      "/status – current mode",
      "/whoami – your Telegram user ID",
      "/screenoff, /screenon – Mac display off/on (Mac stays awake)",
      "/screenshot [app] – screenshot of the screen or one app (/screenshot apps lists them)",
      "",
      "Send photos, screenshots or videos and Claude will look at them.",
    ].join("\n"),
  );
});

bot.command("claude", (ctx) => {
  if (!claudeEnabled) return ctx.reply("Claude is not configured.");
  const state = getState(ctx.chat.id);
  state.provider = "claude";
  state.code = null;
  stopWatcher(state);
  saveState();
  return ctx.reply(`Chatting with Claude (${claudeLabel}).`);
});

bot.command("gpt", (ctx) => {
  if (!openai) return ctx.reply("OPENAI_API_KEY is not configured.");
  const state = getState(ctx.chat.id);
  state.provider = "gpt";
  state.code = null;
  stopWatcher(state);
  saveState();
  return ctx.reply(`Chatting with ChatGPT (${OPENAI_MODEL}).`);
});

bot.command("reset", (ctx) => {
  const state = getState(ctx.chat.id);
  state.claudeHistory = [];
  state.claudeSessionId = null;
  state.gptHistory = [];
  state.code = null;
  stopWatcher(state);
  saveState();
  return ctx.reply("Chat cleared. You're back in normal chat mode.");
});

bot.command("status", (ctx) => {
  const state = getState(ctx.chat.id);
  return ctx.reply(`${modeLabel(state)}${state.running ? "\n\n⏳ Claude is working right now (/stop to cancel)" : ""}`);
});

bot.command("whoami", (ctx) => ctx.reply(`Your Telegram user ID: ${ctx.from?.id}`));

function runQuiet(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 10000 }, (err, _out, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(),
    ),
  );
}

bot.command("screenoff", async (ctx) => {
  if (process.platform !== "darwin") return ctx.reply("Only supported on macOS.");
  try {
    await runQuiet("pmset", ["displaysleepnow"]);
    await ctx.reply(`🌙 Screen off. The Mac stays awake${keepAwake ? "" : " (warning: keep-awake isn't active)"}. /screenon to wake it.`);
  } catch (err) {
    await ctx.reply(`⚠️ Couldn't turn the screen off: ${describeError(err)}`);
  }
});

bot.command("screenon", async (ctx) => {
  if (process.platform !== "darwin") return ctx.reply("Only supported on macOS.");
  try {
    await runQuiet("caffeinate", ["-u", "-t", "2"]);
    await ctx.reply("☀️ Screen on.");
  } catch (err) {
    await ctx.reply(`⚠️ Couldn't wake the screen: ${describeError(err)}`);
  }
});

bot.command("sessions", async (ctx) => {
  if (!codeModeAllowed()) return ctx.reply(CODE_MODE_LOCKED);
  const limit = Math.min(Math.max(Number(ctx.match) || 10, 1), 30);
  const [sessions, live] = await Promise.all([listSessions(limit, CLAUDE_CLI_CWD), liveSessions(CLAUDE_CLI_PATH)]);
  if (!sessions.length) return ctx.reply("No Claude Code sessions found in ~/.claude/projects.");

  const keyboard = new InlineKeyboard();
  const lines = sessions.map((s, i) => {
    keyboard.text(`${i + 1}. ${truncate(s.title, 40)}`, `s:${s.id}`).row();
    const l = live.get(s.id);
    const marker = l ? (l.kind === "background" ? "🔵 " : "🟢 ") : "";
    return `${i + 1}. ${marker}${s.title}\n    📁 ${s.cwd ? shortPath(s.cwd) : "?"} · ${timeAgo(s.updatedAt)}${l ? ` · ${l.status}` : ""}`;
  });
  return ctx.reply(`Your recent Claude Code sessions (🟢 open in a terminal, 🔵 running in the background):\n\n${lines.join("\n\n")}\n\nTap one to continue it:`, {
    reply_markup: keyboard,
  });
});

bot.callbackQuery(/^s:([0-9a-f-]{36})$/, async (ctx) => {
  if (!codeModeAllowed()) return ctx.answerCallbackQuery({ text: "Locked. Set ALLOWED_USER_IDS." });
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return ctx.answerCallbackQuery();
  const state = getState(chatId);
  if (state.running) return ctx.answerCallbackQuery({ text: "Claude is busy. /stop first.", show_alert: true });

  const session = await findSession(ctx.match[1]);
  if (!session) return ctx.answerCallbackQuery({ text: "Session not found.", show_alert: true });
  if (!session.cwd) return ctx.answerCallbackQuery({ text: "Can't tell which folder that session ran in.", show_alert: true });

  state.code = { sessionId: session.id, cwd: session.cwd, title: session.title };
  await ctx.answerCallbackQuery({ text: "Session attached" });
  await ensureWatcher(ctx.api, chatId, state);
  const live = (await liveSessions(CLAUDE_CLI_PATH)).get(session.id);

  const recap = await readTranscriptTail(session.file, 4);
  const recapText = recap
    .map((m) => `${m.role === "user" ? "🧑 You" : "🤖 Claude"}: ${truncate(m.text, 600)}`)
    .join("\n\n");

  const warn = live
    ? `\n\n🖥 This session is ${liveLabel(live)}. What happens there will show up here live. If you send a message from here while it's still open, I'll continue in a copy so the two don't clash. Close it in the terminal first to keep one shared session.`
    : "\n\n🖥 If you later open this session in a terminal, what happens there will show up here live.";
  await ctx.reply(
    `✅ Continuing: ${session.title}\n📁 ${shortPath(session.cwd)}\n🔐 Permission mode: ${CLAUDE_CODE_PERMISSION_MODE}${warn}\n\nLast messages:\n\n${recapText || "(none)"}\n\nJust send a message to continue. /exit to leave.`.slice(
      0,
      4000,
    ),
  );
});

bot.command("new", async (ctx) => {
  if (!codeModeAllowed()) return ctx.reply(CODE_MODE_LOCKED);
  const state = getState(ctx.chat.id);
  if (state.running) return ctx.reply("Claude is busy. /stop first.");

  const arg = ctx.match.trim();
  const dir = path.resolve(expandHome(arg || CLAUDE_CODE_DEFAULT_DIR));
  try {
    if (!statSync(dir).isDirectory()) return ctx.reply(`Not a folder: ${dir}`);
  } catch {
    return ctx.reply(`Folder not found: ${dir}`);
  }

  state.code = { sessionId: null, cwd: dir, title: `New session in ${path.basename(dir)}` };
  stopWatcher(state);
  saveState();
  return ctx.reply(
    `🆕 New Claude Code session in ${shortPath(dir)}\n🔐 Permission mode: ${CLAUDE_CODE_PERMISSION_MODE}\n\nSend your first message. It will also show up in \`claude --resume\` on your computer.`,
  );
});

bot.command("recap", async (ctx) => {
  const state = getState(ctx.chat.id);
  if (!state.code?.sessionId) return ctx.reply("No Claude Code session attached. Use /sessions or /new.");
  const session = await findSession(state.code.sessionId);
  if (!session) return ctx.reply("Session file not found.");
  const count = Math.min(Math.max(Number(ctx.match) || 6, 1), 20);
  const recap = await readTranscriptTail(session.file, count);
  const text = recap.map((m) => `${m.role === "user" ? "🧑 You" : "🤖 Claude"}: ${truncate(m.text, 1500)}`).join("\n\n");
  await sendLong(ctx.api, ctx.chat.id, `📜 ${session.title} (updated ${timeAgo(session.updatedAt)})\n\n${text || "(no messages yet)"}`);
});

bot.command("stop", (ctx) => {
  const state = getState(ctx.chat.id);
  if (!state.running) return ctx.reply("Nothing is running.");
  state.running.kill("SIGINT");
  setTimeout(() => state.running?.kill("SIGKILL"), 5000);
  return ctx.reply("🛑 Stopping…");
});

bot.command("exit", (ctx) => {
  const state = getState(ctx.chat.id);
  if (!state.code) return ctx.reply("You're not in a Claude Code session.");
  const id = state.code.sessionId;
  state.code = null;
  stopWatcher(state);
  saveState();
  return ctx.reply(
    `Left the session${id ? ` (${id})` : ""}. Back to chat with ${state.provider === "claude" ? "Claude" : "ChatGPT"}.${id ? `\nOn your computer: claude --resume ${id}` : ""}`,
  );
});

const screenshots = new Map<string, string>();

bot.command("screenshot", async (ctx) => {
  if (!codeModeAllowed()) return ctx.reply(CODE_MODE_LOCKED);
  if (process.platform !== "darwin") return ctx.reply("Only supported on macOS.");
  const query = ctx.match.trim();
  if (query === "?" || query === "apps") {
    const apps = await listAppNames().catch(() => []);
    return ctx.reply(apps.length ? `Open apps:\n${apps.join("\n")}\n\nUse /screenshot <app>` : "Couldn't list apps.");
  }
  await ctx.replyWithChatAction("upload_photo");
  try {
    const shot = await screenshot(query || undefined);
    const key = Math.random().toString(36).slice(2, 10);
    screenshots.set(key, shot.file);
    if (screenshots.size > 50) screenshots.delete(screenshots.keys().next().value!);
    await ctx.replyWithPhoto(new InputFile(shot.file), {
      caption: `📸 ${truncate(shot.label, 200)}`,
      reply_markup: new InlineKeyboard().text("🤖 Ask Claude what's happening", `shot:${key}`),
    });
  } catch (err) {
    await ctx.reply(`⚠️ ${describeError(err)}`);
  }
});

bot.callbackQuery(/^shot:([a-z0-9]+)$/, async (ctx) => {
  const file = screenshots.get(ctx.match[1]);
  const chatId = ctx.chat?.id;
  if (!file || chatId === undefined) return ctx.answerCallbackQuery({ text: "Screenshot expired, take a new one." });
  await ctx.answerCallbackQuery({ text: "Sending to Claude…" });
  const state = getState(chatId);
  submit(ctx.api, chatId, async () => ({
    text: `This is a screenshot of my Mac screen right now. What's happening on it?${state.code ? `\n\n(Saved at: ${file})` : ""}`,
    images: [await imageInput(await toJpeg(file))],
  }));
});

function submit(api: Api, chatId: number, prepare: () => Promise<UserInput>) {
  const state = getState(chatId);
  if (state.running) api.sendMessage(chatId, "⏳ Queued, Claude is still working on the previous message.").catch(() => {});

  enqueue(chatId, async () => {
    try {
      const input = await prepare();
      if (state.code) {
        await runCodeTurn(api, chatId, state, input);
        return;
      }
      await api.sendChatAction(chatId, "typing").catch(() => {});
      const typing = setInterval(() => api.sendChatAction(chatId, "typing").catch(() => {}), 4500);
      try {
        const reply =
          state.provider === "gpt"
            ? await askGpt(state, input)
            : CLAUDE_BACKEND === "cli"
              ? await askClaudeChatCli(state, input)
              : await askClaudeApi(state, input);
        await sendLong(api, chatId, reply);
      } finally {
        clearInterval(typing);
      }
    } catch (err) {
      console.error(err);
      await api.sendMessage(chatId, `⚠️ ${describeError(err)}`).catch(() => {});
    }
  });
}

bot.on("message:text", (ctx) => {
  const text = ctx.message.text;
  submit(ctx.api, ctx.chat.id, async () => ({ text, images: [] }));
});

type MediaItem =
  | { kind: "image"; fileId: string; ext: string }
  | { kind: "video"; fileId: string; ext: string; name: string };

function mediaFromMessage(ctx: Context): MediaItem | null {
  const m = ctx.message;
  if (!m) return null;
  if (m.photo?.length) return { kind: "image", fileId: m.photo[m.photo.length - 1].file_id, ext: ".jpg" };
  const doc = m.document;
  if (doc?.mime_type?.startsWith("image/")) {
    return { kind: "image", fileId: doc.file_id, ext: path.extname(doc.file_name ?? "") || ".img" };
  }
  if (doc?.mime_type?.startsWith("video/")) {
    return { kind: "video", fileId: doc.file_id, ext: path.extname(doc.file_name ?? "") || ".mp4", name: doc.file_name ?? "video" };
  }
  if (m.video) return { kind: "video", fileId: m.video.file_id, ext: ".mp4", name: m.video.file_name ?? "video" };
  if (m.video_note) return { kind: "video", fileId: m.video_note.file_id, ext: ".mp4", name: "video note" };
  if (m.animation) return { kind: "video", fileId: m.animation.file_id, ext: ".mp4", name: m.animation.file_name ?? "GIF" };
  return null;
}

async function mediaToInput(api: Api, items: MediaItem[], caption: string, state: ChatState): Promise<UserInput> {
  const images: ImageInput[] = [];
  const notes: string[] = [];
  const saved: string[] = [];

  for (const item of items) {
    let file;
    try {
      file = await api.getFile(item.fileId);
    } catch (err) {
      throw new Error(`Couldn't fetch the file from Telegram (bots can only download files up to 20 MB): ${describeError(err)}`);
    }
    if (!file.file_path) throw new Error("Telegram didn't return a file path.");
    const local = await downloadTelegramFile(TELEGRAM_BOT_TOKEN!, file.file_path, item.ext);
    saved.push(local);

    if (item.kind === "image") {
      images.push(await imageInput(await toJpeg(local)));
    } else {
      const { frames, duration } = await videoFrames(local);
      for (const f of frames) images.push(await imageInput(f));
      notes.push(
        `The ${item.name} is ${duration.toFixed(1)}s long. You can't watch video, so here are ${frames.length} frames sampled evenly across it, in order.`,
      );
    }
  }

  const parts = [caption || (items.some((i) => i.kind === "video") ? "What's happening in this video?" : "What's in this image?")];
  if (notes.length) parts.push(notes.join("\n"));
  if (state.code) parts.push(`(Original file${saved.length > 1 ? "s" : ""} saved at: ${saved.join(", ")})`);
  return { text: parts.join("\n\n"), images };
}

const albums = new Map<string, { items: MediaItem[]; caption: string; timer: NodeJS.Timeout }>();

bot.on(["message:photo", "message:document", "message:video", "message:video_note", "message:animation"], async (ctx) => {
  const item = mediaFromMessage(ctx);
  const chatId = ctx.chat.id;
  if (!item) {
    await ctx.reply("I can only pass images and videos to Claude right now.");
    return;
  }
  const caption = ctx.message.caption ?? "";
  const api = ctx.api;
  const state = getState(chatId);
  const groupId = ctx.message.media_group_id;

  if (!groupId) {
    submit(api, chatId, () => mediaToInput(api, [item], caption, state));
    return;
  }

  const key = `${chatId}:${groupId}`;
  const existing = albums.get(key);
  if (existing) {
    existing.items.push(item);
    if (caption) existing.caption = caption;
    clearTimeout(existing.timer);
  }
  const entry = existing ?? { items: [item], caption, timer: undefined as unknown as NodeJS.Timeout };
  entry.timer = setTimeout(() => {
    albums.delete(key);
    submit(api, chatId, () => mediaToInput(api, entry.items, entry.caption, state));
  }, 1500);
  albums.set(key, entry);
});

bot.catch((err) => console.error("Bot error:", err.error));

cleanupMedia().catch(() => {});
setInterval(() => cleanupMedia().catch(() => {}), 60 * 60 * 1000);

for (const chatId of loadState()) {
  const st = getState(chatId);
  ensureWatcher(bot.api, chatId, st).catch((err) => console.error(err));
}

if (!claudeEnabled && !openai) throw new Error("Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY, or use CLAUDE_BACKEND=cli");

await bot.api.setMyCommands([
  { command: "sessions", description: "List & continue Claude Code sessions" },
  { command: "new", description: "New Claude Code session in a folder" },
  { command: "recap", description: "Latest messages of the current session" },
  { command: "stop", description: "Stop what Claude is doing" },
  { command: "exit", description: "Leave the Claude Code session" },
  { command: "claude", description: "Chat with Claude" },
  { command: "gpt", description: "Chat with ChatGPT" },
  { command: "reset", description: "Clear the chat conversation" },
  { command: "status", description: "Show current mode" },
  { command: "whoami", description: "Show your Telegram user ID" },
  { command: "screenshot", description: "Screenshot the Mac screen or an app" },
  { command: "screenoff", description: "Turn the Mac screen off (stays awake)" },
  { command: "screenon", description: "Turn the Mac screen back on" },
]);

console.log(
  `Bot running. Keep-awake: ${keepAwake ? "on" : "off"}. Claude: ${claudeEnabled ? claudeLabel : "disabled"}, ChatGPT: ${openai ? OPENAI_MODEL : "disabled"}, Claude Code sessions: ${codeModeAllowed() ? `enabled (${CLAUDE_CODE_PERMISSION_MODE})` : "locked (set ALLOWED_USER_IDS)"}`,
);
bot.start();
