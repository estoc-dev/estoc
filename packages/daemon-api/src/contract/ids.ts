/**
 * The identifiers a view holds, compares and hands back. Each is an
 * opaque string with one role; the brand keeps a TypeScript caller
 * from passing one role's ID where another is expected and is no
 * validation: request decoding checks the syntax, and the domain
 * procedure behind a method checks existence, ownership and current
 * eligibility. A view never composes one of these from parts.
 */

declare const role: unique symbol;

type Id<Role extends string> = string & { readonly [role]: Role };

/** A contact the vault created; one per undeleted contact record. */
export type ContactId = Id<"ContactId">;

/** A logical message, input or output, whatever channel shows it. */
export type MessageId = Id<"MessageId">;

/** A communication DID entity of this vault, apart from its DID string. */
export type DidId = Id<"DidId">;

/** An arrangement with a mediator. */
export type MediationId = Id<"MediationId">;

/** The execution an established input is handled under. */
export type ExecutionId = Id<"ExecutionId">;

/** A vault event, named as an observation's source, a disclosure or a rotation decision. */
export type EventCid = Id<"EventCid">;

/**
 * The canonical JSON text of `[localDid, peerDid]` for one channel.
 * The daemon constructs it; every channel reference, command target
 * and command result carries it, and a view treats it as opaque.
 */
export type ChannelId = Id<"ChannelId">;

/**
 * The daemon's name for the vault file it currently holds. Stable
 * through lock and unlock while that file stays held; retired when
 * the file is removed or released, and fresh for a replacement file
 * or a new ownership period even under the same anchor. Neither a
 * portable vault ID nor a capability.
 */
export type Hold = Id<"Hold">;

/**
 * An opaque token the publisher installs on startup and whenever the
 * phase or the hold changes. Epochs are unequal, not ordered.
 */
export type Epoch = Id<"Epoch">;

/** A positive safe integer counting publications within one epoch, from 1. */
export type Revision = number;

/** A conversation's projection key: `contact:` plus a contact ID, or `channel:` plus a channel ID. */
export type ConversationId = Id<"ConversationId">;

/**
 * A valid Gregorian UTC instant spelled exactly `YYYY-MM-DDTHH:mm:ss.sssZ`,
 * with seconds 00 to 59. The fixed spelling makes literal string order
 * chronological; a view localizes it for display only.
 */
export type DisplayTime = Id<"DisplayTime">;
