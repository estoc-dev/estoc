/**
 * The protocol vocabulary a view needs to name what it sends and to
 * recognize what it is shown. These are the DIDComm identifiers as the
 * daemon speaks them, declared here so that a view needs no runtime
 * package to spell them.
 */

export const BASIC_MESSAGE = "https://didcomm.org/basicmessage/2.0/message";
export const PROFILE = "https://didcomm.org/user-profile/1.0/profile";
export const REQUEST_PROFILE = "https://didcomm.org/user-profile/1.0/request-profile";
export const TRUST_PING = "https://didcomm.org/trust-ping/2.0/ping";
export const TRUST_PING_RESPONSE = "https://didcomm.org/trust-ping/2.0/ping-response";
export const PROBLEM_REPORT = "https://didcomm.org/report-problem/2.0/problem-report";
export const OOB_INVITATION = "https://didcomm.org/out-of-band/2.0/invitation";
export const PLAIN_TYP = "application/didcomm-plain+json";

/** The goal code of an invitation to a conversation between people. */
export const GOAL_CONNECT = "connect";

export const TRACE_LEVELS = ["off", "normal", "verbose"] as const;
export type TraceLevel = (typeof TRACE_LEVELS)[number];

export const DISCLOSURE_AS = ["oob", "direct"] as const;
/** The form a DID was disclosed in: inside an out-of-band invitation, or handed over on its own. */
export type DisclosureAs = (typeof DISCLOSURE_AS)[number];

/** An out-of-band invitation as its plaintext carries it. */
export interface Invitation {
  type: typeof OOB_INVITATION;
  id: string;
  typ: typeof PLAIN_TYP;
  from: string;
  body: {
    goal_code?: string;
    goal?: string;
    accept?: string[];
  };
}
