/**
 * The exchange every port begins with. Its shapes stay the same across
 * application API versions, so that an endpoint can report a version
 * mismatch without interpreting that version's records.
 */

export const WIRE_VERSION = 1;

/** The application API version this contract describes. */
export const API_VERSION = 1;

export interface Hello {
  kind: "hello";
  wire: typeof WIRE_VERSION;
  /** the application versions the client can decode and honour completely */
  apis: number[];
}

/**
 * The daemon's request acceptance bounds. They bound client-to-daemon
 * frames, and `maxBackupBytes` an export result as well; state, lines,
 * logs and other replies are not subject to them.
 */
export interface Limits {
  /** maximum UTF-8 length of one client-to-daemon JSON frame on a text port; null on a structured-clone port */
  maxFrameBytes: number | null;
  /** maximum decoded bytes of an inbound backup, and of an export result */
  maxBackupBytes: number;
  /** maximum logical size of one client-to-daemon frame */
  maxValueBytes: number;
  /** maximum nesting of one client-to-daemon frame, its root at depth 1 */
  maxDepth: number;
}

export interface Welcome {
  kind: "welcome";
  wire: typeof WIRE_VERSION;
  api: number;
  /** informational text about the daemon; never a substitute for negotiation */
  implementation: string;
  limits: Limits;
}

export interface Incompatible {
  kind: "incompatible";
  wire: typeof WIRE_VERSION;
  supported: number[];
  message: string;
}

export type Bootstrap = Hello | Welcome | Incompatible;
