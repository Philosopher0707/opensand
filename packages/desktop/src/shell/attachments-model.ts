// Pure model for the Staged Context Attachments view and its stage modal (Phase 5 Row 18).
// Mirrors the legacy renderer/app.js attachment controller without any DOM or bridge code.

/** Bridge records use filename/localPath/sizeBytes; the legacy renderer used fileName/filePath/byteLength. */
export interface Attachment {
  id: string;
  fileName?: string;
  filePath?: string;
  filename?: string;
  localPath?: string;
  byteLength?: number;
  sizeBytes?: number;
  sha256?: string;
  [key: string]: unknown;
}

export interface AttachmentCardView {
  title: string;
  pathLabel: string;
  sizeLabel: string;
  hashLabel: string;
}

export interface StageAttachmentModalState {
  stageAttachmentModalOpen: boolean;
}

export const ATTACHMENT_VALIDATION_MESSAGE = "Please provide a local file path.";
export const ATTACHMENT_EMPTY_STATE = 'No staged context attachments. Use "+ Stage Attachment" to add files.';

/** Matches the server's `if (!body.filePath)` guard. */
export function validateStageAttachmentInput(filePath: string): string | null {
  if (!filePath?.trim()) return ATTACHMENT_VALIDATION_MESSAGE;
  return null;
}

export function attachmentSizeKb(bytes: number | undefined): number {
  return Math.round(((bytes || 0) / 1024) * 10) / 10;
}

export function attachmentHashLabel(sha256: string | undefined): string {
  return `SHA: ${(sha256 || "").slice(0, 16)}...`;
}

export function attachmentCardView(att: Attachment): AttachmentCardView {
  return {
    title: att.fileName?.trim() || att.filename?.trim() || att.id || "Attachment",
    pathLabel: att.filePath?.trim() || att.localPath?.trim() || "in-memory",
    sizeLabel: `${attachmentSizeKb(att.byteLength ?? att.sizeBytes)} KB`,
    hashLabel: attachmentHashLabel(att.sha256),
  };
}

export function unstageConfirmMessage(att: Attachment): string {
  return `Unstage attachment "${att.fileName || att.filename || att.id}"?`;
}

export function createInitialModalState(): StageAttachmentModalState {
  return { stageAttachmentModalOpen: false };
}

export function openStageAttachmentModal(state: StageAttachmentModalState): StageAttachmentModalState {
  return { ...state, stageAttachmentModalOpen: true };
}

export function closeStageAttachmentModal(state: StageAttachmentModalState): StageAttachmentModalState {
  return { ...state, stageAttachmentModalOpen: false };
}
