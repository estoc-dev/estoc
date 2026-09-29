/**
 * `@estoc/daemon-api/views`: what a view computes from what it was
 * shown, with no daemon in reach. Records read by ID and conversations
 * assembled from their references; a conversation followed across
 * snapshots; invitations written as links and read back; the message
 * contents a view composes; a mediator named by a person, read as far
 * as text goes. Nothing here rescans events, decides continuity or
 * grants a send: the daemon rechecks every operation when it runs it.
 */

export { indexSnapshot, type ConversationView, type ShownChannel, type SnapshotIndex } from "./records.js";
export { successorOf } from "./navigation.js";
export { invitationOf, invitationUrl, parseInvitation } from "./invitations.js";
export { announcedName, basicMessage, profileMessage } from "./messages.js";
export { mediatorHost, mediatorInputOf, type MediatorInput } from "./mediators.js";
