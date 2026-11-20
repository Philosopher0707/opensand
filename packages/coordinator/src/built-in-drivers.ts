/** All built-in provider drivers, mirroring OpenMausBot's BUILT_IN_DRIVERS. */

import type { AnyProviderDriver } from "@opensand/shared";
import { OpenRouterDriver } from "./providers/openrouter-driver.js";
import { AnthropicDriver } from "./providers/anthropic-driver.js";
import { ClaudeDriver } from "./providers/claude-driver.js";
import { CodexDriver } from "./providers/codex-driver.js";
import { OpenCodeDriver } from "./providers/opencode-driver.js";
import { AntigravityDriver } from "./providers/antigravity-driver.js";
import { GrokAgentDriver } from "./providers/grok-agent-driver.js";
import { GeminiAgentDriver } from "./providers/gemini-agent-driver.js";
import { KimiAgentDriver } from "./providers/kimi-agent-driver.js";
import { DroidDriver } from "./providers/droid-driver.js";
import { CursorDriver } from "./providers/cursor-driver.js";
import { QwenDriver } from "./providers/qwen-driver.js";
import { HermesDriver } from "./providers/hermes-driver.js";
import { ClineDriver } from "./providers/cline-driver.js";
import { CopilotDriver } from "./providers/copilot-driver.js";
import { CommandCodeDriver } from "./providers/command-code-driver.js";
import { CustomAcpDriver } from "./providers/custom-acp-driver.js";
import { DeepSeekDriver } from "./providers/deepseek-driver.js";
import { GrokApiDriver } from "./providers/grok-api-driver.js";
import { OpenAiCompatDriver } from "./providers/openai-compat-driver.js";
import { MistralDriver } from "./providers/mistral-driver.js";
import { CerebrasDriver } from "./providers/cerebras-driver.js";
import { GroqDriver } from "./providers/groq-driver.js";
import { GreenferenceDriver } from "./providers/greenference-driver.js";
import { MetaDriver } from "./providers/meta-driver.js";
import { MinimaxDriver } from "./providers/minimax-driver.js";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  OpenRouterDriver,
  AnthropicDriver,
  ClaudeDriver,
  CodexDriver,
  OpenCodeDriver,
  AntigravityDriver,
  GrokAgentDriver,
  GeminiAgentDriver,
  KimiAgentDriver,
  DroidDriver,
  CursorDriver,
  QwenDriver,
  HermesDriver,
  ClineDriver,
  CopilotDriver,
  CommandCodeDriver,
  CustomAcpDriver,
  DeepSeekDriver,
  GrokApiDriver,
  OpenAiCompatDriver,
  MistralDriver,
  CerebrasDriver,
  GroqDriver,
  GreenferenceDriver,
  MetaDriver,
  MinimaxDriver,
];
