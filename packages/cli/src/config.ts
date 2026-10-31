export interface CliConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  autoApprove: boolean;
  query?: string;
  systemPromptFile?: string;
}

export function parseCliArgs(args: string[]): CliConfig {
  const config: CliConfig = {
    endpoint: process.env.OPENSAND_ENDPOINT || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: process.env.OPENSAND_MODEL || "gpt-4o",
    apiKey: process.env.OPENSAND_API_KEY || process.env.OPENAI_API_KEY,
    autoApprove: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--endpoint" && i + 1 < args.length) {
      config.endpoint = args[++i];
    } else if (arg === "--model" && i + 1 < args.length) {
      config.model = args[++i];
    } else if (arg === "--api-key" && i + 1 < args.length) {
      config.apiKey = args[++i];
    } else if (arg === "--system-prompt" && i + 1 < args.length) {
      config.systemPromptFile = args[++i];
    } else if (arg === "--auto-approve" || arg === "-y") {
      config.autoApprove = true;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    config.query = positional.join(" ");
  }

  return config;
}
