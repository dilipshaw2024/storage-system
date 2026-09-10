/**
 * Source reader implementation for storage-core.
 */
import type { MessageStructureObject } from "imapflow";

export interface AttachmentPartRef {
  part: string;
  filename: string;
  mimeType: string;
}

interface CollectedLeaf {
  part: string;
  mime: string;
  filename?: string;
  disposition?: string;
}

function collectLeaves(node: MessageStructureObject | undefined, out: CollectedLeaf[]): void {
  if (!node) return;
  if (node.childNodes && node.childNodes.length > 0) {
    for (const c of node.childNodes) {
      collectLeaves(c, out);
    }
    return;
  }
  if (!node.part) return;
  const mime = node.type.toLowerCase();
  const filename =
    node.dispositionParameters?.filename || node.parameters?.name || node.parameters?.filename;
  out.push({
    part: node.part,
    mime,
    filename,
    disposition: node.disposition,
  });
}

function isSupportedAttachment(
  mime: string,
  filename?: string,
  allowedExtensions?: string[],
): boolean {
  const f = filename?.toLowerCase() ?? "";
  const extension = f.includes(".") ? f.split(".").pop() ?? "" : "";
  const configuredExtensions = allowedExtensions
    ?.map((item) => item.toLowerCase().replace(/^\./, ""))
    .filter(Boolean);

  if (configuredExtensions && configuredExtensions.length > 0) {
    return configuredExtensions.includes(extension);
  }

  if (mime.startsWith("image/")) return true;
  if (
    mime === "application/pdf" ||
    mime === "application/msword" ||
    mime === "application/rtf" ||
    mime === "text/rtf" ||
    mime === "application/vnd.oasis.opendocument.text" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return true;
  }

  return /\.(pdf|doc|docx|rtf|odt|txt|jpg|jpeg|png|gif|bmp|tif|tiff|webp|heic)$/i.test(f);
}

/**
 * Parts for claim poll: first text/plain, first text/html, and supported attachments.
 */
export function splitPollParts(
  struct: MessageStructureObject | undefined,
  allowedExtensions?: string[],
): {
  textPart?: string;
  htmlPart?: string;
  attachmentParts: AttachmentPartRef[];
} {
  const leaves: CollectedLeaf[] = [];
  collectLeaves(struct, leaves);

  let textPart: string | undefined;
  let htmlPart: string | undefined;
  const attachmentParts: AttachmentPartRef[] = [];

  for (const p of leaves) {
    if (p.mime === "text/plain" && !textPart) {
      textPart = p.part;
      continue;
    }
    if (p.mime === "text/html" && !htmlPart) {
      htmlPart = p.part;
      continue;
    }
    if (isSupportedAttachment(p.mime, p.filename, allowedExtensions)) {
      attachmentParts.push({
        part: p.part,
        filename: p.filename?.trim() || `attachment-${p.part}`,
        mimeType: p.mime,
      });
    }
  }

  return { textPart, htmlPart, attachmentParts };
}
