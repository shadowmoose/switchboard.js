/**
 * Emitted when a connection fails, typically to a destination WebSocket Tracker.
 * @internal
 */
export class ConnectionFailedError extends Error {}

/**
 * Emitted when a client fails somewhere in the authentication process.
 * @internal
 */
export class ClientAuthError extends Error {}
