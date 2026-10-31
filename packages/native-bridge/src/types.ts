export interface VisionTextBlock {
  text: string;
  confidence: number;
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface VisionResult {
  status: "ok" | "error";
  image?: string;
  text?: string;
  blocks?: VisionTextBlock[];
  message?: string;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: number;
  owner: string;
  title: string;
  bounds: WindowBounds;
}

export interface WindowListResult {
  status: "ok" | "error";
  windows?: WindowInfo[];
  message?: string;
}

export interface CaptureResult {
  status: "ok" | "error";
  path?: string;
  windowId?: number;
  message?: string;
}

export interface OpExecInput {
  subcommand: string[];
  vault?: string;
  account?: string;
}

export interface OpExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}
