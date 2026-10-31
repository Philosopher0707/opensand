import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { recognizeScreenText } from "./vision-ocr.js";
import { listWindows, captureWindow } from "./window-capture.js";
import { runOpHardened } from "./op-launcher.js";

export function registerNativeTools(daemon: LocalExecDaemon): void {
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
}
