/**
 * @hidden
 * @internal
 */

/**
 * Emitted when a connection fails, typically to a destination WebSocket Tracker.
 */
export class ConnectionFailedError extends Error {}

/**
 * Emitted when a client fails somewhere in the authentication process.
 */
export class ClientAuthError extends Error {}
