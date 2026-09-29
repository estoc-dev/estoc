import type { AttachmentDescriptor } from "../core/types.js";

/**
 * An attachment as the thread shows it: its descriptor in words, and
 * nothing that would open it. The API hands over descriptors alone,
 * whether the bytes are anywhere at hand is not said, and this version
 * has no call that reads them, so the reference is shown as the text it
 * is.
 */
export interface ShownAttachment {
  name: string;
  /** media type, size and signing, as far as the descriptor says; empty when it says none */
  details: string;
  reference: string;
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shownAttachment(attachment: AttachmentDescriptor): ShownAttachment {
  const name = attachment.filename ?? attachment.description ?? (attachment.id === null ? "an attachment" : `attachment ${attachment.id}`);
  const details = [attachment.mediaType, attachment.byteCount === null ? null : sizeOf(attachment.byteCount), attachment.signed ? "signed" : null].filter((part) => part !== null).join(" · ");
  const reference = attachment.content.kind === "links" ? attachment.content.links.join(" ") : `${attachment.content.kind} ${attachment.content.cid}`;
  return { name, details, reference };
}
