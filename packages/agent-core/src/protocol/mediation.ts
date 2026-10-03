/**
 * The community protocol the agent uses as its transport: message
 * pickup with its mediator (didcomm.org registry, not the specification).
 * Traffic in this protocol runs between the agent and its mediator, not
 * between the user and a contact, and a delivery is only an envelope
 * around the real mail — so none of it enters the message log.
 */

export const STATUS_REQUEST = "https://didcomm.org/messagepickup/3.0/status-request";
export const STATUS = "https://didcomm.org/messagepickup/3.0/status";
export const DELIVERY_REQUEST =
  "https://didcomm.org/messagepickup/3.0/delivery-request";
export const DELIVERY = "https://didcomm.org/messagepickup/3.0/delivery";
export const MESSAGES_RECEIVED =
  "https://didcomm.org/messagepickup/3.0/messages-received";
export const LIVE_DELIVERY_CHANGE =
  "https://didcomm.org/messagepickup/3.0/live-delivery-change";
