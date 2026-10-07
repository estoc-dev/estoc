/**
 * The controls of the mediator's replica-mediation protocol the agent
 * sends, each with the reply it expects: as an arrangement's account,
 * and the registration of an execution as the runtime's own replica.
 */

export const REPLICA_MEDIATION = "https://estoc.dev/replica-mediation/1.0";
export const ACCOUNT_REGISTER = `${REPLICA_MEDIATION}/account-register`;
export const ACCOUNT_REGISTERED = `${REPLICA_MEDIATION}/account-registered`;
export const REPLICA_ADD = `${REPLICA_MEDIATION}/replica-add`;
export const REPLICA_ADDED = `${REPLICA_MEDIATION}/replica-added`;
export const RECIPIENT_ADD = `${REPLICA_MEDIATION}/recipient-add`;
export const RECIPIENT_ADDED = `${REPLICA_MEDIATION}/recipient-added`;
export const EXECUTION_REGISTER = `${REPLICA_MEDIATION}/execution-register`;
export const EXECUTION_REGISTERED = `${REPLICA_MEDIATION}/execution-registered`;
