import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface CliConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  autoApprove: boolean;
  query?: string;
  systemPromptFile?: string;
  bot?: string;
  worktree?: string;
  completion?: 'bash' | 'zsh';
  listTools?: boolean;
  listBots?: boolean;
  listTasks?: boolean;
  provider?: string;
  resume?: string;
  explicitFlags?: Set<string>;
}

export function loadUserConfig(customPath?: string): Partial<CliConfig> {
  try {
    const configPath = customPath ?? path.join(os.homedir(), ".opensand", "config.json");
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return {
        endpoint: parsed.endpoint,
        model: parsed.model,
        apiKey: parsed.apiKey,
        autoApprove: parsed.autoApprove,
        provider: parsed.provider,
      };
    }
  } catch {
    // Ignore unreadable or malformed config file
  }
  return {};
}

export async function probeLocalOllama(
  timeoutMs = 400,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<{ endpoint: string; model: string } | null> {
  const hosts = ["http://127.0.0.1:11434", "http://localhost:11434"];
  for (const host of hosts) {
    try {
      const res = await fetchFn(`${host}/api/tags`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string; model?: string }> };
        const foundModel = data.models?.[0]?.name || data.models?.[0]?.model || "qwen3:8b";
        return {
          endpoint: `${host}/v1`,
          model: foundModel,
        };
      }
    } catch {
      // Continue to next host
    }
  }
  return null;
}

export function validateConfig(config: CliConfig): { valid: boolean; warning?: string } {
  const isCloudOpenAI =
    config.endpoint.includes("api.openai.com") ||
    (!config.endpoint.includes("127.0.0.1") &&
      !config.endpoint.includes("localhost") &&
      !config.endpoint.includes("192.168.") &&
      !config.endpoint.includes("10."));

  const hasApiKey = Boolean(config.apiKey && config.apiKey.trim() !== "" && config.apiKey !== "none");

  if (isCloudOpenAI && !hasApiKey) {
    return {
      valid: false,
      warning:
        `No API key configured for cloud endpoint ${config.endpoint}.\n` +
        `  Fix options:\n` +
        `  1. Set environment variable: export OPENAI_API_KEY="sk-..."\n` +
        `  2. Pass key on launch: opensand --api-key "sk-..."\n` +
        `  3. Use local Ollama: opensand --endpoint http://127.0.0.1:11434/v1 --model qwen3:8b`,
    };
  }

  return { valid: true };
}

export function parseCliArgs(args: string[], customConfigFile?: string): CliConfig {
  const userConfig = loadUserConfig(customConfigFile);
  const explicitFlags = new Set<string>();

  const config: CliConfig = {
    endpoint:
      process.env.OPENSAND_ENDPOINT ||
      process.env.OPENAI_BASE_URL ||
      userConfig.endpoint ||
      "https://api.openai.com/v1",
    model: process.env.OPENSAND_MODEL || userConfig.model || "gpt-4o",
    apiKey:
      process.env.OPENSAND_API_KEY ||
      process.env.OPENAI_API_KEY ||
      userConfig.apiKey,
    autoApprove: userConfig.autoApprove ?? false,
    provider: userConfig.provider,
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--endpoint" && i + 1 < args.length) {
      config.endpoint = args[++i];
      explicitFlags.add("endpoint");
    } else if (arg === "--model" && i + 1 < args.length) {
      config.model = args[++i];
      explicitFlags.add("model");
    } else if (arg === "--api-key" && i + 1 < args.length) {
      config.apiKey = args[++i];
      explicitFlags.add("apiKey");
    } else if (arg === "--provider" && i + 1 < args.length) {
      config.provider = args[++i];
      explicitFlags.add("provider");
    } else if (arg === "--system-prompt" && i + 1 < args.length) {
      config.systemPromptFile = args[++i];
      explicitFlags.add("systemPrompt");
    } else if (arg === "--bot" && i + 1 < args.length) {
      config.bot = args[++i];
      explicitFlags.add("bot");
    } else if (arg === "--auto-approve" || arg === "-y") {
      config.autoApprove = true;
      explicitFlags.add("autoApprove");
    } else if (arg === "--list-tools") {
      config.listTools = true;
      explicitFlags.add("listTools");
    } else if (arg === "--list-bots") {
      config.listBots = true;
      explicitFlags.add("listBots");
    } else if (arg === "--list-tasks") {
      config.listTasks = true;
      explicitFlags.add("listTasks");
    } else if (arg === "--worktree") {
      explicitFlags.add("worktree");
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        config.worktree = args[++i];
      } else {
        config.worktree = `opensand-worktree-${Date.now()}`;
      }
    } else if (arg === "completion" || arg === "--completion") {
      explicitFlags.add("completion");
      if (i + 1 < args.length && (args[i + 1] === "zsh" || args[i + 1] === "bash")) {
        config.completion = args[++i] as 'bash' | 'zsh';
      } else {
        config.completion = "bash";
      }
    } else if (arg === "--resume") {
      explicitFlags.add("resume");
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        config.resume = args[++i];
      } else {
        config.resume = "latest";
      }
    } else if (arg === "--continue" || arg === "-c") {
      explicitFlags.add("resume");
      config.resume = "latest";
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    config.query = positional.join(" ");
  }

  config.explicitFlags = explicitFlags;
  return config;
}
