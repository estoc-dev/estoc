import { parseInvitation } from "@estoc/daemon-api/views";

import type { Invitation } from "../core/types.js";

/** A camera reads whatever code is in front of it, so a parse failure is one more code to pass over, not the end of the scan. */
export function invitationIn(rawValue: string): Invitation | null {
  try {
    return parseInvitation(rawValue);
  } catch {
    return null;
  }
}
