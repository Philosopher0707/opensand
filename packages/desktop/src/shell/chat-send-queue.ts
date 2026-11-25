// Follow-up messages typed while a turn runs. Legacy keeps them in a module-level
// array; the Preact shell keeps this state in useChatTurn so a view switch cannot
// drop the queue, and clears it on a failed or cancelled turn like legacy does.

import { friendlyErrorMessage } from "./composer-model.js";

export interface QueuedMessage {
  /** Stable id so cancelling one item never removes another with the same text. */
  id: number;
  text: string;
}

export interface SendQueueState {
  items: QueuedMessage[];
  nextId: number;
}

export const EMPTY_SEND_QUEUE: SendQueueState = { items: [], nextId: 1 };

export const SEND_FAILURE_MESSAGE = "The message did not send. Try again.";

/** A plain, actionable line: the provider's raw error text and stack never reach the UI. */
export function sendFailureMessage(err: unknown): string {
  return friendlyErrorMessage(err, SEND_FAILURE_MESSAGE);
}

export function enqueueMessage(state: SendQueueState, text: string): SendQueueState {
  const trimmed = text.trim();
  if (!trimmed) return state;
  return {
    items: [...state.items, { id: state.nextId, text: trimmed }],
    nextId: state.nextId + 1,
  };
}

export function cancelQueuedMessage(state: SendQueueState, id: number): SendQueueState {
  if (!state.items.some((item) => item.id === id)) return state;
  return { ...state, items: state.items.filter((item) => item.id !== id) };
}

/** FIFO: the oldest follow-up goes first when the running turn ends. */
export function takeNextQueued(state: SendQueueState): { state: SendQueueState; text: string | null } {
  const [first, ...rest] = state.items;
  if (!first) return { state, text: null };
  return { state: { ...state, items: rest }, text: first.text };
}

export function clearSendQueue(state: SendQueueState): SendQueueState {
  return state.items.length === 0 ? state : { items: [], nextId: state.nextId };
}

export function queueStatusLabel(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "1 queued message" : `${count} queued messages`;
}
