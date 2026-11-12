import { ErrorCodes, OspError } from "./errors.js";
import { isWellFormedName } from "./names.js";

export interface RequestFrame {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface SuccessResponseFrame {
  id: string;
  result: unknown;
}

export interface ErrorResponseFrame {
  id: string;
  error: { code: number; message: string; data?: unknown };
}

export type ResponseFrame = SuccessResponseFrame | ErrorResponseFrame;

export interface EventFrame {
  event: string;
  seq: number;
  missionId?: string;
  ts: string;
  data: Record<string, unknown>;
}

export type Frame = RequestFrame | ResponseFrame | EventFrame;

export function encodeLine(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function parseLine(line: string): Frame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new OspError(ErrorCodes.ParseError, "Malformed JSON line");
  }
  if (!isRecord(value)) {
    throw invalid("Frame must be a JSON object");
  }
  if ("event" in value) return parseEvent(value);
  if ("method" in value) return parseRequest(value);
  if ("result" in value || "error" in value) return parseResponse(value);
  throw invalid("Frame is not a request, response or event");
}

function parseRequest(value: Record<string, unknown>): RequestFrame {
  const id = requireId(value);
  if (typeof value.method !== "string" || !isWellFormedName(value.method)) {
    throw invalid("method must be namespace.Class.method");
  }
  if (!isRecord(value.params)) {
    throw invalid("params must be an object");
  }
  return { id, method: value.method, params: value.params };
}

function parseResponse(value: Record<string, unknown>): ResponseFrame {
  const id = requireId(value);
  if (!("error" in value)) {
    return { id, result: value.result };
  }
  const error = value.error;
  if (!isRecord(error) || typeof error.code !== "number" || !Number.isInteger(error.code) || typeof error.message !== "string") {
    throw invalid("error must have an integer code and a string message");
  }
  return error.data === undefined
    ? { id, error: { code: error.code, message: error.message } }
    : { id, error: { code: error.code, message: error.message, data: error.data } };
}

function parseEvent(value: Record<string, unknown>): EventFrame {
  if (typeof value.event !== "string" || !isWellFormedName(value.event)) {
    throw invalid("event must be namespace.Class.event");
  }
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 1) {
    throw invalid("seq must be a positive integer");
  }
  if (typeof value.ts !== "string") {
    throw invalid("ts must be a string");
  }
  if (!isRecord(value.data)) {
    throw invalid("data must be an object");
  }
  const frame: EventFrame = { event: value.event, seq: value.seq, ts: value.ts, data: value.data };
  if (value.missionId !== undefined) {
    if (typeof value.missionId !== "string") throw invalid("missionId must be a string");
    frame.missionId = value.missionId;
  }
  return frame;
}

function requireId(value: Record<string, unknown>): string {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw invalid("id must be a non-empty string");
  }
  return value.id;
}

function invalid(message: string): OspError {
  return new OspError(ErrorCodes.InvalidRequest, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
