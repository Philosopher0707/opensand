import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { recognizeScreenText } from "./vision-ocr.js";
import { listWindows, captureWindow } from "./window-capture.js";
import { runOpHardened } from "./op-launcher.js";
import { readRecentMessages, draftMessage } from "./messages-reader.js";
import { speakText } from "./speech-bridge.js";
import { BrowserBridge } from "./browser-bridge.js";

export function registerNativeTools(daemon: LocalExecDaemon): void {
  const browserBridge = new BrowserBridge();
  // 1. Apple Vision OCR
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "recognize_screen_text",
        description: "Extract text from an image or screenshot using offline Apple Vision OCR with confidence scores and bounding boxes.",
        parameters: {
          type: "object",
          properties: {
            image_path: {
              type: "string",
              description: "The path to the image or screenshot file on disk.",
            },
          },
          required: ["image_path"],
        },
      },
    },
    requiresGate: "deviceTools",
    handler: async (args) => {
      return recognizeScreenText(args.image_path);
    },
  });

  // 2. Window Listing
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "list_windows",
        description: "List currently visible on-screen windows with IDs, application names, and geometries.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    requiresGate: "deviceTools",
    handler: async () => {
      return listWindows();
    },
  });

  // 3. ScreenCaptureKit Window Capture
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "capture_window",
        description: "Capture an on-screen window to an image file using macOS ScreenCaptureKit.",
        parameters: {
          type: "object",
          properties: {
            window_id: {
              type: "number",
              description: "The target window ID to capture.",
            },
            output_path: {
              type: "string",
              description: "The destination path where the PNG screenshot will be saved.",
            },
          },
          required: ["window_id", "output_path"],
        },
      },
    },
    requiresGate: "deviceTools",
    handler: async (args) => {
      return captureWindow(args.window_id, args.output_path);
    },
  });

  // 4. Hardened 1Password CLI Runner
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "op_exec",
        description: "Execute a 1Password CLI command securely inside a Seatbelt sandbox container.",
        parameters: {
          type: "object",
          properties: {
            subcommand: {
              type: "array",
              items: { type: "string" },
              description: "The 1Password CLI subcommand and arguments (e.g. ['item', 'get', 'GitHub']).",
            },
            vault: {
              type: "string",
              description: "Optional vault name or ID.",
            },
            account: {
              type: "string",
              description: "Optional 1Password account shorthand.",
            },
          },
          required: ["subcommand"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      return runOpHardened({
        subcommand: args.subcommand,
        vault: args.vault,
        account: args.account,
      });
    },
  });

  // 5. macOS Messages Sync (Grok Bot GrokBotUserComputerMessagesOp parity)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "read_recent_messages",
        description: "Read recent iMessage/SMS conversations from the local macOS chat database (Grok Bot Messages parity).",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of recent messages to return (default: 20).",
            },
          },
        },
      },
    },
    requiresGate: "deviceTools",
    handler: async (args) => {
      const res = await readRecentMessages(args.limit ?? 20);
      return JSON.stringify(res, null, 2);
    },
  });

  // 6. Draft iMessage (Grok Bot draft_card parity)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "draft_imessage",
        description: "Prepare a draft iMessage for user confirmation before sending.",
        parameters: {
          type: "object",
          properties: {
            recipient: {
              type: "string",
              description: "Phone number or email address of the recipient.",
            },
            body: {
              type: "string",
              description: "The text message content to send.",
            },
          },
          required: ["recipient", "body"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const res = draftMessage(args.recipient, args.body);
      return JSON.stringify(res, null, 2);
    },
  });

  // 7. Native Speech Synthesis (Grok Bot AiService.TextToSpeech parity)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "speak_text",
        description: "Synthesize and speak text aloud using native macOS speech synthesis.",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The text to speak aloud.",
            },
            voice: {
              type: "string",
              description: "Optional macOS voice identifier (e.g. 'Samantha', 'Daniel', 'Alex').",
            },
          },
          required: ["text"],
        },
      },
    },
    requiresGate: "deviceTools",
    handler: async (args) => {
      const res = await speakText(args.text, args.voice);
      return JSON.stringify(res, null, 2);
    },
  });

  // 8. Autonomous Web Search
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for up-to-date documentation, technical references, or facts using DuckDuckGo and Wikipedia.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query (e.g. 'Node.js 22 crypto PBKDF2', 'PostgreSQL JSONB indexes').",
            },
            max_results: {
              type: "number",
              description: "Optional maximum number of search results to return (default: 8).",
            },
          },
          required: ["query"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const results = await browserBridge.webSearch(args.query, args.max_results || 8);
      return JSON.stringify({
        status: "success",
        query: args.query,
        count: results.length,
        results,
      }, null, 2);
    },
  });

  // 9. Web Page Fetcher & Markdown Extractor
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "fetch_web_page",
        description: "Fetch a web page by URL and extract clean, readable Markdown content (stripping ads, scripts, and styling).",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The HTTP/HTTPS web address to inspect.",
            },
            max_bytes: {
              type: "number",
              description: "Optional maximum text length to return (default: 40000 characters).",
            },
          },
          required: ["url"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      try {
        const page = await browserBridge.fetchWebPage(args.url, args.max_bytes);
        return JSON.stringify({
          status: "success",
          url: page.url,
          title: page.title,
          description: page.description,
          contentLength: page.contentLength,
          markdown: page.markdown,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({
          status: "error",
          url: args.url,
          error: err instanceof Error ? err.message : String(err),
        }, null, 2);
      }
    },
  });

  // 10. Safari Active Tab Inspector
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "safari_inspect_active_tab",
        description: "Inspect the URL and title of the currently open active tab in macOS Safari.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    requiresGate: "deviceTools",
    handler: async () => {
      const tab = await browserBridge.inspectSafariActiveTab();
      if (!tab) {
        return JSON.stringify({
          status: "not_available",
          message: "No active Safari window or tab detected.",
        }, null, 2);
      }
      return JSON.stringify({
        status: "success",
        url: tab.url,
        title: tab.title,
      }, null, 2);
    },
  });
}
