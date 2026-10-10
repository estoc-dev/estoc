/**
 * The messages of blob-store/1.0 the agent sends to its mediator, each
 * with the reply it expects. Like mediation and pickup, they run
 * between the agent and its mediator and stay out of the message log.
 */

export const BLOB_STORE = "https://estoc.dev/blob-store/1.0";
export const BLOB_PUT = `${BLOB_STORE}/put`;
export const BLOB_PUT_RESULT = `${BLOB_STORE}/put-result`;
export const BLOB_DELETE = `${BLOB_STORE}/delete`;
export const BLOB_DELETE_RESULT = `${BLOB_STORE}/delete-result`;

/** The codes of a refused put: a blob over the per-blob limit, one that would take its owner over its quota, and anything else the store will not do. */
export const BLOB_TOO_LARGE = "e.p.blob.too-large";
export const BLOB_QUOTA = "e.p.blob.quota";
export const BLOB_REFUSED = "e.p.blob.refused";
