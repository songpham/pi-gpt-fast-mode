import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fastModeExtension, {
  createFastModeStreamSimple,
  CONFIG_FIELD,
  DEFAULT_SHORTCUT,
  KEYBINDING_FIELD,
  RESERVED_SHORTCUTS,
  SUPPORTED_MODELS,
  TARGET_MODEL,
  TARGET_PROVIDER,
  loadDefaultEnabled,
  loadShortcuts,
  normalizeShortcutSetting,
  resolveKeybindingsPath,
  resolvePiFilePath,
  resolveSettingsPath,
} from "../src/index.ts";

type MockCtx = ReturnType<typeof createCtx>;
type TestModel = {
  provider: string;
  id: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
};
type StreamCall = { kind: "native" | "simple"; options?: unknown };
type TestStreams = {
  stream: (_model: unknown, _context: unknown, options?: unknown) => unknown;
  streamSimple: (_model: unknown, _context: unknown, options?: unknown) => unknown;
};
type TestStreamHandler = (
  model: TestModel,
  context: unknown,
  options?: { reasoning?: "high"; toolChoice?: "required" },
) => unknown;
type FastModeStreamFactory = (api: TestStreams, enabled: () => boolean) => TestStreamHandler;

function createTestStreams(calls: StreamCall[]): TestStreams {
  return {
    stream: (_model, _context, options) => {
      calls.push({ kind: "native", options });
      return "native stream";
    },
    streamSimple: (_model, _context, options) => {
      calls.push({ kind: "simple", options });
      return "simple stream";
    },
  };
}

function createMockPi() {
  const commands = new Map<string, { handler: (args: string, ctx: MockCtx) => Promise<void> | void }>();
  const shortcuts = new Map<string, { handler: (ctx: MockCtx) => Promise<void> | void }>();
  const handlers = new Map<string, (event: any, ctx: MockCtx) => unknown>();
  const providers = new Map<string, { api?: string; streamSimple?: (...args: any[]) => unknown }>();

  return {
    commands,
    shortcuts,
    handlers,
    providers,
    registerCommand(name: string, options: { handler: (args: string, ctx: MockCtx) => Promise<void> | void }) {
      commands.set(name, options);
    },
    registerShortcut(shortcut: string, options: { handler: (ctx: MockCtx) => Promise<void> | void }) {
      shortcuts.set(shortcut, options);
    },
    on(event: string, handler: (event: any, ctx: MockCtx) => unknown) {
      handlers.set(event, handler);
    },
    registerProvider(name: string, config: { api?: string; streamSimple?: (...args: any[]) => unknown }) {
      providers.set(name, config);
    },
  };
}

function createCtx(model = { provider: TARGET_PROVIDER, id: TARGET_MODEL }) {
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses = new Map<string, string | undefined>();

  return {
    model,
    notifications,
    statuses,
    ui: {
      notify(message: string, level = "info") {
        notifications.push({ message, level });
      },
      setStatus(key: string, text: string | undefined) {
        statuses.set(key, text);
      },
    },
  };
}

let previousPiDir: string | undefined;
let previousXdg: string | undefined;

beforeEach(() => {
  previousPiDir = process.env.PI_CODING_AGENT_DIR;
  previousXdg = process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiDir;

  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
});

test("passes native priority serviceTier for supported Codex and OpenAI models", () => {
  const createStreamHandler = createFastModeStreamSimple as unknown as FastModeStreamFactory;
  const context = { messages: [] };

  for (const model of [
    {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 128_000,
    },
    { provider: "openai", id: "gpt-5.5", reasoning: true, contextWindow: 200_000, maxTokens: 128_000 },
  ]) {
    const calls: StreamCall[] = [];
    const handler = createStreamHandler(createTestStreams(calls), () => true);

    expect(handler(model, context, { reasoning: "high" })).toBe("native stream");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("native");
    expect(calls[0]?.options).toMatchObject({ serviceTier: "priority", reasoningEffort: "high" });
    expect((calls[0]?.options as Record<string, unknown>)?.service_tier).toBeUndefined();
  }
});

test("forwards caller stream options on the native fast path", () => {
  const createStreamHandler = createFastModeStreamSimple as unknown as FastModeStreamFactory;
  const calls: StreamCall[] = [];
  const handler = createStreamHandler(createTestStreams(calls), () => true);

  handler(
    {
      provider: TARGET_PROVIDER,
      id: "gpt-5.6-luna",
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 128_000,
    },
    { messages: [] },
    { reasoning: "high", toolChoice: "required" },
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]?.kind).toBe("native");
  expect(calls[0]?.options).toMatchObject({ serviceTier: "priority", toolChoice: "required" });
});

test("Fast OFF and unsupported models delegate without a service tier", () => {
  const createStreamHandler = createFastModeStreamSimple as unknown as FastModeStreamFactory;
  const context = { messages: [] };

  for (const [model, enabled] of [
    [
      {
        provider: TARGET_PROVIDER,
        id: "gpt-5.6-luna",
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 128_000,
      },
      false,
    ],
    [
      {
        provider: TARGET_PROVIDER,
        id: "gpt-5.6-mars",
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 128_000,
      },
      true,
    ],
  ] as const) {
    const calls: StreamCall[] = [];
    const handler = createStreamHandler(createTestStreams(calls), () => enabled);

    expect(handler(model, context)).toBe("simple stream");
    expect(calls).toEqual([{ kind: "simple", options: undefined }]);
  }

  expect(SUPPORTED_MODELS.has("openai-codex/gpt-5.6-luna")).toBe(true);
  expect(SUPPORTED_MODELS.has("openai-codex/gpt-5.6-mars")).toBe(false);
});

test("normalizes shortcut settings", () => {
  expect(normalizeShortcutSetting(undefined)).toEqual([DEFAULT_SHORTCUT]);
  expect(normalizeShortcutSetting([DEFAULT_SHORTCUT])).toEqual([DEFAULT_SHORTCUT]);
  expect(normalizeShortcutSetting(` ${DEFAULT_SHORTCUT} `)).toEqual([DEFAULT_SHORTCUT]);
  expect(RESERVED_SHORTCUTS.has("ctrl+m")).toBe(true);
  expect(normalizeShortcutSetting(["ctrl+m", "", "ctrl+alt+m"])).toEqual(["ctrl+alt+m"]);
  expect(normalizeShortcutSetting(["ctrl+m"])).toEqual([]);
  expect(normalizeShortcutSetting([])).toEqual([]);
  expect(normalizeShortcutSetting("ctrl+m")).toEqual([DEFAULT_SHORTCUT]);
  expect(normalizeShortcutSetting("enter")).toEqual([DEFAULT_SHORTCUT]);
  expect(normalizeShortcutSetting(false)).toEqual([]);
  expect(normalizeShortcutSetting(null)).toEqual([]);
});

test("resolves Pi config file paths from env, XDG, then default", () => {
  const home = "/home/test";
  expect(resolvePiFilePath("settings.json", { env: { PI_CODING_AGENT_DIR: "~/pi-env" }, home })).toBe(
    join(resolve(join(home, "pi-env")), "settings.json"),
  );
  expect(resolveKeybindingsPath({ env: { PI_CODING_AGENT_DIR: "~/pi-env" }, home })).toBe(
    join(resolve(join(home, "pi-env")), "keybindings.json"),
  );

  expect(
    resolveSettingsPath({
      env: { XDG_CONFIG_HOME: "/xdg" },
      home,
      exists: (path) => path === join(resolve("/xdg"), "pi", "agent", "settings.json"),
    }),
  ).toBe(join(resolve("/xdg"), "pi", "agent", "settings.json"));

  expect(resolveSettingsPath({ env: {}, home, exists: () => false })).toBe(
    join(home, ".pi", "agent", "settings.json"),
  );
});

test("shows Fast status for supported models and clears it for unsupported models", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-gpt-fast-status-"));

  try {
    const agentDir = join(tempDir, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ [CONFIG_FIELD]: { enabled: false } }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.XDG_CONFIG_HOME;

    const pi = createMockPi();
    fastModeExtension(pi as unknown as Parameters<typeof fastModeExtension>[0]);
    const sessionStart = pi.handlers.get("session_start")!;
    const modelSelect = pi.handlers.get("model_select");
    expect(modelSelect).toBeDefined();
    if (!modelSelect) return;

    const ctx = createCtx();
    await sessionStart({}, ctx);
    expect(ctx.statuses.get(CONFIG_FIELD)).toBe("GPT Fast: NORMAL");

    await pi.commands.get("fast")!.handler("", ctx);
    expect(ctx.statuses.get(CONFIG_FIELD)).toBe("GPT Fast: FAST");

    const unsupportedCtx = createCtx({ provider: "anthropic", id: "claude-opus-4-8" });
    modelSelect({ model: unsupportedCtx.model }, unsupportedCtx);
    expect(unsupportedCtx.statuses.get(CONFIG_FIELD)).toBeUndefined();

    modelSelect({ model: ctx.model }, ctx);
    expect(ctx.statuses.get(CONFIG_FIELD)).toBe("GPT Fast: FAST");

    await pi.commands.get("fast")!.handler("", ctx);
    expect(ctx.statuses.get(CONFIG_FIELD)).toBe("GPT Fast: NORMAL");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("/fast on, off, and status preserve explicit command behavior", async () => {
  const pi = createMockPi();
  fastModeExtension(pi as unknown as Parameters<typeof fastModeExtension>[0]);
  const ctx = createCtx();
  const command = pi.commands.get("fast")!;

  await command.handler("on", ctx);
  expect(ctx.statuses.get(CONFIG_FIELD)).toBe("GPT Fast: FAST");
  expect(ctx.notifications.at(-1)?.message).toMatch(/enabled/);

  await command.handler("status", ctx);
  expect(ctx.statuses.get(CONFIG_FIELD)).toBe("GPT Fast: FAST");
  expect(ctx.notifications.at(-1)?.message).toMatch(/enabled/);

  await command.handler("off", ctx);
  expect(ctx.statuses.get(CONFIG_FIELD)).toBe("GPT Fast: NORMAL");
  expect(ctx.notifications.at(-1)?.message).toMatch(/disabled/);
});

test("loads shortcuts and registers native service-tier providers", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-gpt-fast-mode-"));

  try {
    const envDir = join(tempDir, "agent");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, "keybindings.json"), JSON.stringify({ [KEYBINDING_FIELD]: ["ctrl+alt+m"] }), "utf8");
    writeFileSync(join(envDir, "settings.json"), JSON.stringify({ [CONFIG_FIELD]: { enabled: true } }), "utf8");

    expect(loadShortcuts({ env: { PI_CODING_AGENT_DIR: envDir }, home: tempDir })).toEqual(["ctrl+alt+m"]);
    expect(loadShortcuts({ env: { PI_CODING_AGENT_DIR: join(tempDir, "missing") }, home: tempDir })).toEqual([
      DEFAULT_SHORTCUT,
    ]);
    expect(loadDefaultEnabled({ env: { PI_CODING_AGENT_DIR: envDir }, home: tempDir })).toBe(true);
    writeFileSync(join(envDir, "settings.json"), JSON.stringify({ [CONFIG_FIELD]: { enabled: false } }), "utf8");
    expect(loadDefaultEnabled({ env: { PI_CODING_AGENT_DIR: envDir }, home: tempDir })).toBe(false);
    writeFileSync(join(envDir, "settings.json"), JSON.stringify({ [CONFIG_FIELD]: { enabled: true } }), "utf8");
    expect(loadDefaultEnabled({ env: { PI_CODING_AGENT_DIR: join(tempDir, "missing") }, home: tempDir })).toBe(false);

    process.env.PI_CODING_AGENT_DIR = envDir;
    delete process.env.XDG_CONFIG_HOME;

    const pi = createMockPi();
    fastModeExtension(pi as unknown as Parameters<typeof fastModeExtension>[0]);

    expect(pi.commands.has("fast")).toBe(true);
    expect(pi.shortcuts.has("ctrl+alt+m")).toBe(true);
    expect(pi.handlers.has("before_provider_request")).toBe(false);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.providers.get("openai-codex")?.api).toBe("openai-codex-responses");
    expect(pi.providers.get("openai")?.api).toBe("openai-responses");
    expect(typeof pi.providers.get("openai-codex")?.streamSimple).toBe("function");

    const ctx = createCtx();
    const sessionStart = pi.handlers.get("session_start")!;

    await pi.commands.get("fast")!.handler("", ctx);
    expect(ctx.notifications.at(-1)?.message).toMatch(/disabled/);

    sessionStart({}, ctx);
    expect(ctx.statuses.get(CONFIG_FIELD)).toBe("GPT Fast: FAST");

    await pi.commands.get("fast")!.handler("", ctx);
    expect(ctx.notifications.at(-1)?.message).toMatch(/disabled/);
    expect(ctx.statuses.get(CONFIG_FIELD)).toBe("GPT Fast: NORMAL");

    await pi.commands.get("fast")!.handler("", ctx);
    expect(ctx.notifications.at(-1)?.message).toMatch(/enabled/);
    expect(ctx.statuses.get(CONFIG_FIELD)).toBe("GPT Fast: FAST");

    await pi.commands.get("fast")!.handler("", ctx);
    expect(ctx.statuses.get(CONFIG_FIELD)).toBe("GPT Fast: NORMAL");
    const unsupportedCtx = createCtx({ provider: "anthropic", id: "claude-opus-4-8" });
    await pi.shortcuts.get("ctrl+alt+m")!.handler(unsupportedCtx);
    expect(unsupportedCtx.notifications.at(-1)?.level).toBe("warning");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
