export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  StaleEpochError: 4001,
  ResourceLockedError: 4002,
  BudgetExceededError: 4003,
  ChainIntegrityError: 4004,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class OspError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "OspError";
    this.code = code;
    this.data = data;
  }
}
