import { parseInvitation, type Invitation } from "@estoc/agent-core";

/** The invitation a scanned code carries, or null when it carries something else: text, another site's link, a broken invitation. */
export function invitationIn(rawValue: string): Invitation | null {
  try {
    return parseInvitation(rawValue);
  } catch {
    return null;
  }
}
