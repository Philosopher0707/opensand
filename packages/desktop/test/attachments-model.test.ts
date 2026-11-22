import test from "node:test";
import assert from "node:assert";
import {
  ATTACHMENT_EMPTY_STATE,
  ATTACHMENT_VALIDATION_MESSAGE,
  attachmentCardView,
  attachmentHashLabel,
  attachmentSizeKb,
  closeStageAttachmentModal,
  createInitialModalState,
  openStageAttachmentModal,
  unstageConfirmMessage,
  validateStageAttachmentInput,
  type Attachment,
} from "../src/shell/attachments-model.js";

const legacyAttachment: Attachment = {
  id: "att-1",
  fileName: "schema.sql",
  filePath: "/Users/philosopher/dev/project/schema.sql",
  byteLength: 4096,
  sha256: "abcdef0123456789aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

test("attachments-model: validation requires a non-blank file path", () => {
  assert.strictEqual(validateStageAttachmentInput("/tmp/a.sql"), null);
  assert.strictEqual(validateStageAttachmentInput(""), ATTACHMENT_VALIDATION_MESSAGE);
  assert.strictEqual(validateStageAttachmentInput("   "), ATTACHMENT_VALIDATION_MESSAGE);
  assert.strictEqual(validateStageAttachmentInput("\n\t"), ATTACHMENT_VALIDATION_MESSAGE);
  assert.strictEqual(validateStageAttachmentInput("  /tmp/a.sql  "), null);
});

test("attachments-model: size is KB rounded to one decimal", () => {
  assert.strictEqual(attachmentSizeKb(4096), 4);
  assert.strictEqual(attachmentSizeKb(1536), 1.5);
  assert.strictEqual(attachmentSizeKb(1), 0);
  assert.strictEqual(attachmentSizeKb(undefined), 0);
});

test("attachments-model: hash label shows a 16-char prefix", () => {
  assert.strictEqual(attachmentHashLabel("abcdef0123456789ffff"), "SHA: abcdef0123456789...");
  assert.strictEqual(attachmentHashLabel(undefined), "SHA: ...");
  assert.strictEqual(attachmentHashLabel(""), "SHA: ...");
});

test("attachments-model: card view uses legacy field names", () => {
  assert.deepStrictEqual(attachmentCardView(legacyAttachment), {
    title: "schema.sql",
    pathLabel: "/Users/philosopher/dev/project/schema.sql",
    sizeLabel: "4 KB",
    hashLabel: "SHA: abcdef0123456789...",
  });
});

test("attachments-model: card view uses real bridge field names", () => {
  assert.deepStrictEqual(
    attachmentCardView({
      id: "att-2",
      filename: "notes.md",
      localPath: "/tmp/notes.md",
      sizeBytes: 2048,
      sha256: "0123456789abcdef",
    }),
    {
      title: "notes.md",
      pathLabel: "/tmp/notes.md",
      sizeLabel: "2 KB",
      hashLabel: "SHA: 0123456789abcdef...",
    },
  );
});

test("attachments-model: card view applies defaults", () => {
  assert.deepStrictEqual(attachmentCardView({ id: "att-3" }), {
    title: "att-3",
    pathLabel: "in-memory",
    sizeLabel: "0 KB",
    hashLabel: "SHA: ...",
  });
  assert.strictEqual(attachmentCardView({ id: "att-4", fileName: "   ", filename: "real.md" }).title, "real.md");
  assert.strictEqual(attachmentCardView({ id: "att-5", filePath: "  ", localPath: "/x" }).pathLabel, "/x");
});

test("attachments-model: unstage confirm names the file", () => {
  assert.strictEqual(unstageConfirmMessage(legacyAttachment), 'Unstage attachment "schema.sql"?');
  assert.strictEqual(unstageConfirmMessage({ id: "att-2", filename: "notes.md" }), 'Unstage attachment "notes.md"?');
  assert.strictEqual(unstageConfirmMessage({ id: "att-3" }), 'Unstage attachment "att-3"?');
});

test("attachments-model: modal open/close state machine", () => {
  const initial = createInitialModalState();
  assert.deepStrictEqual(initial, { stageAttachmentModalOpen: false });
  const opened = openStageAttachmentModal(initial);
  assert.deepStrictEqual(opened, { stageAttachmentModalOpen: true });
  assert.deepStrictEqual(closeStageAttachmentModal(opened), initial);
});

test("attachments-model: empty state mentions the stage button", () => {
  assert.ok(ATTACHMENT_EMPTY_STATE.includes("+ Stage Attachment"));
  assert.ok(ATTACHMENT_EMPTY_STATE.includes("No staged context attachments."));
});
