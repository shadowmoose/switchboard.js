// noinspection ExceptionCaughtLocallyJS

import {ConnectedPeer, TrackerConnector, TrackerConnectorInterface} from './tracker'
import Subscribable from "./subscribable";
import {ClientAuthError, ConnectionFailedError} from "./errors";
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import sha1 from 'sha1';
import {PeerConfig} from "./peer";
import BufferWrapper from "./buffer";
import {SHORT_ID_LENGTH} from "./shared";
import {getLogger, setLogging} from "./logger";
import {ConnectionTypeOptions, SpsConnector} from "./sps-connector";

const debug = getLogger('switchboard');

/**
 * These are the options that the Switchboard accepts as configuration.
 */
export interface SBClientOptions {
    /**
     * For additional security, long-form IDs can be enabled.
     * These IDs are longer and potentially more difficult to share.
     * All clients wishing to connect together must use the same value for this setting.
     *
     * Defaults to false, using shorter IDs.
     */
    useLongIds?: boolean;

    /**
     * A list of strings and/or {@link TrackerOptions} config objects.
     * If provided, this list will replace all the default trackers SwitchBoard otherwise uses or looks up.
     */
    trackers?: (string|TrackerOptions)[];

    /**
     * The time (in milliseconds) before a client is disconnected automatically.
     */
    clientTimeout?: number;

    /**
     * The maximum attempts a client gets to successfully authenticate, before becoming blacklisted.
     */
    clientMaxRetries?: number;

    /**
     * If set, this is the duration (in milliseconds) that a client will be prevented from reconnecting to this session,
     * once they exceed the max retry limit. Pass 0 for no blacklist. Also accepts Infinity.
     */
    clientBlacklistDuration?: number;

    /**
     * If provided, the given ID will be used to reconnect as a past identity. Otherwise, a new one will be created.
     */
    seed?: string;

    /**
     * If provided (and true), Switchboard will NOT automatically check the excellent tracker list provided over at
     * https://github.com/ngosang/trackerslist for additional trackers.
     */
    skipExtraTrackers?: boolean;
}

/** Custom configuration for client Trackers. */
export interface TrackerOptions {
    /** The WebSocket URI to join. */
    uri: string;

    /** If true, the whole Switchboard will fail (and disconnect from all trackers) if this tracker fails to connect. */
    isRequired?: boolean;

    /** Optionally overwrite client values passed into each Peer created by this tracker. */
    customPeerOpts?: PeerConfig;

    /**
     * The interval, in milliseconds, that each tracker should re-announce.
     * Don't change this unless you know what you're doing.
     */
    trackerAnnounceInterval?: number;

    /**
     * Optionally override the amount of time to wait for this tracker to connect.
     */
    connectTimeoutMs?: number;

    /**
     * If set to true, this tracker must be running the custom Switchboard Peering Server.
     * This allows for self-hosting more streamlined peering servers, rather than relying on tracker protocol.
     */
    isNativeServer?: boolean;

    /**
     * If using the native Switchboard Peering Server which requires a passcode, it can be set here.
     */
    passCode?: string;

    /**
     * If specified, Switchboard will only attempt to reconnect to this tracker this many times before giving up.
     */
    maxReconnectAttempts?: number;
}

/** @internal */
const DEFAULT_MAX_RETRIES = 2;
/** @internal */
const DEFAULT_CLIENT_TIMEOUT = 150000;
/** @internal */
const DEFAULT_WS_TIMEOUT = 5000;
/**
 * The default list of tracker URLs to use for matchmaking. To change these, pass a new list in at {@link SBClientOptions.trackers}.
 */
const DEFAULT_TRACKERS: string[] = [
    'wss://tracker.files.fm:7073/announce',
    'wss://tracker.openwebtorrent.com',
];
/** @internal */
const DEFAULT_ANNOUNCE_RATE = 50000;


export interface Switchboard {
    /**
     * Emitted when all possible trackers have connected.
     * If all trackers fail, this is not emitted.
     *
     * For potential ease of debugging, the internally-used array of
     * connected TrackerConnectors will be provided with this event. It is not advisable to manipulate these.
     *
     * You should not wait for this event. Peers may come in from faster trackers before they are all connected.
     * @param event
     * @param callback A function which can accept an array of the internal TrackerConnectors.
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'connected', callback: {(openTrackers: TrackerConnector[]): void}): () => void;

    /**
     * Emitted after a new Peer object is located, connected, and authenticated.
     * You should always subscribe to this event, because all Peers will be returned via this emitter.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'peer', callback: {(peer: ConnectedPeer): void}): () => void;

    /**
     * Emitted when any connected Peer has an error.
     * You can catch these at a more granular level by subscribing directly to the Peer's `on('error')` emitter instead.
     * @param event
     * @param callback A function that can receive the Error, if any, that caused termination.
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'peer-error', callback: {(err: Error): void}): () => void;

    /**
     * Emitted when a PeerID is offered by a Tracker. The Peer may not actually connect.
     * @param event
     * @param callback A function that can receive the Peer ID.
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'peer-seen', callback: {(peerID: string): void}): () => void;

    /**
     * Emitted whenever a Peer ID is blacklisted.
     * The emitted Peer will be valid until the callback has run (synchronously), then it will be disconnected.
     * @param event
     * @param callback A function that can receive the PeerWrapper that was blacklisted.
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'peer-blacklisted', callback: {(peer: ConnectedPeer): void}): () => void;

    /**
     * Emitted when a non-fatal error occurs. You should not assume that the Switchboard is broken based off these.
     * @param event
     * @param callback A function that can receive the Error, if any, that caused termination.
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'warn', callback: {(err: Error): void}): () => void;

    /**
     * Triggered when this Switchboard is unrecoverably killed.
     *
     * If this is emitted, this Switchboard is dead.
     * You should create a new one if you need to reconnect.
     * @param event
     * @param callback A function that can receive the Error, if any, that caused termination.
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'kill', callback: {(err: Error|null): void}): () => void;

    /**
     * Emitted when each of the trackers connects.
     * @param event
     * @param callback A function that can receive the TrackerOptions.
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'tracker-connect', callback: {(tracker: TrackerOptions): void}): () => void;
}

/**
 * This is the main entrypoint for Switchboard.js.
 *
 * This class manages all connections, and abstracts away all the complex details of WebRTC + Matchmaking.
 */
export class Switchboard extends Subscribable {
    /**
     * This is the secret ID generated for use in cryptography.
     * You should copy and reuse this if you wish to maintain a persistent Peer ID.
     *
     * __Note:__ This should *never* be shared. It allows whoever owns a copy to impersonate this Peer.
     *
     * If you wish to know a valid seed before running Matchmaking, you can pre-generate a Seed using {@link makeSeed}.
     *
     * @see {@link SBClientOptions.seed} for assigning this value.
     * @see {@link Switchboard.makeSeed} for pre-generating an ID.
     */
    public readonly secretSeed: string;
    private readonly opts: SBClientOptions;
    private readonly cryptoKeys: nacl.SignKeyPair;
    private trackerOpts: TrackerOptions[] = [];
    private blacklist: Record<string, number> = {};
    private trackers: Set<TrackerConnectorInterface> = new Set();
    private connected: Record<string, ConnectedPeer> = {};
    private infoHash: string = '';
    private killed: boolean = false;
    private wantedPeerCount: number = 0;
    private wantedSpecificID: string|null = null;
    private _fullID: string|null = null;
    private connectionMode: ConnectionTypeOptions = ConnectionTypeOptions.HOST;
    private readonly realm: string;

    /**
     * Creates a new Switchboard matchmaker.
     *
     * To start finding peers, call one of: [{@link host}, {@link findHost}, {@link swarm}].
     * @param realm Specify a "realm" name that is likely unique to your application to avoid cross-talk with other app's peers.
     * @param opts Extra optional config values that this instance will use.
     * @see {@link SBClientOptions}
     */
    constructor(realm: string, opts?: SBClientOptions) {
        super();
        this.realm = realm;
        this.opts = opts || {};
        this.secretSeed = this.opts.seed || Switchboard.makeSeed();
        this.cryptoKeys = Switchboard.makeCryptoPair(this.secretSeed);

        for (const t of this.opts?.trackers || DEFAULT_TRACKERS) {
            if ((typeof t).toLowerCase() === "string") {
                this.trackerOpts.push({
                    uri: `${t}`
                })
            } else {
                this.trackerOpts.push(<TrackerOptions>t);
            }
        }
    }

    /**
     * The current ID this client is using.
     * By default, uses shorter IDs, but can be toggled with {@link SBClientOptions.useLongIds}.
     * @see {@link makeID}
     */
    get peerID(): string {
        return this.opts.useLongIds ? this.fullID : this.shortID;
    }

    /**
     * The short form of the local client ID.
     * If additional security is desired when connecting to specific IDs, use {@link fullID}.
     */
    get shortID(): string {
        return this.fullID.substr(0, SHORT_ID_LENGTH);
    }

    /**
     * The current long-form ID for this peer.
     * When connecting to a target Host, this may technically be more secure than the shortened {@link peerID}.
     */
    get fullID(): string {
        if (this._fullID) {
            return this._fullID;
        } else {
            this._fullID = Switchboard.makeFullID(this.cryptoKeys.publicKey);
        }
        return this._fullID;
    }

    /**
     * Connect to all Trackers, and register event handling internally.
     * @param swarmID ID to use for the swarm. This is hashed into an InfoHash.
     */
    private async start(swarmID: string) {
        this.infoHash = sha1(this.realm + '::' + swarmID);

        let canEmit = true;
        const checkReady = () => {
            if (canEmit && Array.from(this.trackers).every(t => t.isOpen)) {
                canEmit = false;
                this.emit('connected', Array.from(this.trackers));
            }
        }

        if (!this.opts.skipExtraTrackers && !this.opts?.trackers) {
            await fetch("https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_ws.txt")
                .then(async raw => {
                    const res = await raw.text();
                    res.split("\n")
                        .map(r=>r.trim())
                        .filter(r=>r.startsWith("wss://"))
                        .forEach(t => {
                            this.trackerOpts.push({
                                uri: `${t}`
                            });
                        });
                }).catch(err => {
                    this.emit('warn', err);
                });
        }

        const filtered = new Set<string>();
        this.trackerOpts = this.trackerOpts.filter(t=>!filtered.has(t.uri) && filtered.add(t.uri));

        for (const trk of this.trackerOpts) {
            const t = this.makeConnector(trk);

            t.on('kill', (err) => {
                if (this.killed) return;

                this.emit('warn', err);  // Only warn initially; This might not be fatal.
                this.trackers.delete(t);

                if (!this.trackers.size || trk.isRequired) {
                    this.kill(new ConnectionFailedError('Failed to establish the required connections.'));
                } else {
                    checkReady();
                }
            });

            t.on('peer', this.onPeer.bind(this));
            t.on('connect', () => {
                this.emit('tracker-connect', trk);
                checkReady();
            });
            t.on('disconnect', () => {
                this.emit('warn', new ConnectionFailedError(`Tracker disconnected: ${trk.uri}`));
            });

            this.trackers.add(t);
        }
        this.trackers.forEach(t => t.connect());
    }

    private makeConnector(trk: TrackerOptions): TrackerConnectorInterface {
        const cfg: PeerConfig = Object.assign({}, trk.customPeerOpts||{}, {trickleICE: false});
        const timeout = trk.connectTimeoutMs || DEFAULT_WS_TIMEOUT;
        const maxReconnects = trk.maxReconnectAttempts || 5

        if (trk.isNativeServer) {
            const pubKey = Array.from(this.cryptoKeys.publicKey);
            const sigStr = Array.from(nacl.sign.detached(this.cryptoKeys.publicKey, this.cryptoKeys.secretKey));
            const targId = this.wantedSpecificID || (this.connectionMode === ConnectionTypeOptions.SWARM ? this.infoHash : null);

            return new SpsConnector({
                uri: trk.uri,
                fullId: this.fullID,
                isBlacklisted: this.shouldBlockConnection.bind(this),
                mode: this.connectionMode,
                peerConfig: cfg,
                pubKeySig: sigStr,
                publicKey: pubKey,
                targetHash: targId,
                maxReconnects,
                peerTimeout: this.opts.clientTimeout || DEFAULT_CLIENT_TIMEOUT,
                passCode: trk.passCode || null
            });
        } else {
            const announce = trk.trackerAnnounceInterval || DEFAULT_ANNOUNCE_RATE;
            // WebTorrent requires short IDs. This is okay, because the final step of validation checks against full-length IDs if provided them.
            return new TrackerConnector(trk.uri, this.shortID, this.infoHash, cfg, this.shouldBlockConnection.bind(this), announce, this.wantedPeerCount, timeout, maxReconnects);
        }
    }

    /**
     * Connect to trackers as a Host, listening for client Peers.
     * Clients looking for a specific Host via {@link findHost} will require that this is eventually called by the Host.
     *
     * @param maxPeers Optionally limit the maximum concurrently connected peers.
     * @see {@link findHost}
     */
    host(maxPeers?: number) {
        this.wantedPeerCount = maxPeers || 500;
        this.connectionMode = ConnectionTypeOptions.HOST;
        return this.start(this.peerID);
    }

    /**
     * Connects only to the given Host PeerID.
     * This requires that you have exchanged in advance the Host's ID.
     *
     * For this to work, the Host *must* call {@link host}.
     * If the Host is not yet online, they will be located once they become available.
     * @param hostID The ID of the target host. If the Host is using long-form IDs, make sure this matches!
     * @see {@link host}
     */
    findHost(hostID: string) {
        this.wantedPeerCount = 1;
        this.wantedSpecificID = hostID;
        this.connectionMode = ConnectionTypeOptions.JOIN_HOST;
        return this.start(hostID);
    }

    /**
     * Connect to all Peers within a given "swarm ID".
     *
     * This ID can be any string you'd like,
     * though it is suggested you make it something unique in order to avoid finding unrelated peers.
     * @param swarmID The ID of the swarm to join.
     * @param maxPeers An optional limit on the number of unique connected Peers.
     */
    swarm(swarmID: string, maxPeers?: number) {
        this.wantedPeerCount = maxPeers || 500;
        this.connectionMode = ConnectionTypeOptions.SWARM;
        return this.start(swarmID);
    }

    /**
     * Kill all connections to the tracker servers, and optionally the Peers connected as well.
     * @param error The error to be emitted by this object's "kill" event, or null.
     * @param killPeers If true, also close all active Peer connections.
     */
    kill(error?: Error, killPeers?: boolean) {
        this.killed = true;
        this.trackers.forEach(t => t.kill());
        if (killPeers) {
            for (const p of Object.values(this.connected)) {
                p.close(true);
            }
        }
        this.emit('kill', error||null);
    }

    /**
     * Determine if a given PeerID can connect. Called by TrackerConnectors before a handshake is established.
     * @private
     */
    private shouldBlockConnection(peerID: string, emitSeen: boolean = true) {
        if (emitSeen) {
            this.emit('peer-seen', peerID);
        }
        const shortest = Math.min(peerID.length, this.wantedSpecificID?.length || peerID.length);
        const peerNorm = peerID.substr(0, shortest);
        const wantedNorm = this.wantedSpecificID ? this.wantedSpecificID.substr(0, shortest) : null;

        return this.isBlackListed(peerID)
            || (this.wantedSpecificID && peerNorm !== wantedNorm) // quick initial ID filter.
            || (!!this.connected[peerID])
            || Object.keys(this.blacklist).length >= this.wantedPeerCount;
    }

    /**
     * Check if a client has retried connections enough to be "blacklisted".
     * @param peerID
     * @private
     */
    isBlackListed(peerID: string) {
        return this.blacklist[peerID] && this.blacklist[peerID] > (this.opts.clientMaxRetries || DEFAULT_MAX_RETRIES)
    }

    /**
     * Returns a count of the Trackers currently processing or connected.
     * This will include broken trackers that have not yet timed out.
     * For more reliable detection of tracker activity, subscribe to the emitted tracker events.
     */
    get trackerCount() {
        return this.trackers.size;
    }

    /**
     * A list of all Peers currently connected to this Switchboard instance.
     */
    get connectedPeers() {
        return Object.values(this.connected);
    }

    /**
     * Increases a Peer's failure count - potentially resulting in their blacklisting.
     * If increment is not given, the Peer will be automatically blacklisted.
     * @param peer The peer to (potentially) blacklist.
     * @param increment The amount of failures to increment. Defaults to instantly blacklisting.
     */
    addPeerFailure(peer: ConnectedPeer, increment?: number) {
        if (!increment) increment = this.opts.clientMaxRetries || Infinity;
        if (this.isBlackListed(peer.id)) return;

        if (this.opts.clientBlacklistDuration) {
            this.blacklist[peer.id] = (this.blacklist[peer.id] || 0) + increment;
            if (this.isBlackListed(peer.id) && this.opts.clientBlacklistDuration != Infinity) {
                this.emit('peer-blacklisted', peer);
                setTimeout(() => {
                    delete this.blacklist[peer.id];
                }, this.opts.clientBlacklistDuration);
            }
        }
    }

    /**
     * Triggered when a Tracker finds a peer that has passed the blacklist.
     *
     * This handler initializes and verifies the new Peer's identity, using a binary handshake.
     * @param peer The new Peer that has connected.
     * @private
     */
    private onPeer(peer: ConnectedPeer) {
        if (this.connected[peer.id] || Object.keys(this.connected).length >= this.wantedPeerCount) {
            return peer.close(true);
        }
        this.connected[peer.id] = peer;

        peer.timeoutTracker = setTimeout(() => {
            this.addPeerFailure(peer, 1);
            peer.close();
        }, this.opts.clientTimeout || DEFAULT_CLIENT_TIMEOUT);

        peer.permanent('close', () => {
            delete this.connected[peer.id];
            clearTimeout(peer.timeoutTracker);
        });

        peer.permanent('error', (err: any) => {
            this.emit('peer-error', err);
        });

        peer.once('data', (data: ArrayBuffer) => {
            try {
                clearTimeout(peer.timeoutTracker);
                if (!peer.isSignalStable || !peer.localSdp || !peer.remoteSdp) {
                    throw Error("Cannot validate peer handshake - peer connection is not stable!")
                }

                if (Switchboard.verifyPacket(peer.id, new Uint8Array(data), this.wantedSpecificID, peer.remoteSdp)) {
                    delete this.blacklist[peer.id];
                    this.emit('peer', peer);
                }
            } catch (err) {
                this.emit('warn', err);
                this.addPeerFailure(peer, 1);
                peer.close();
            }
        });

        try {
            if (!peer.localSdp) throw Error("Peer is missing a local SDP, and cannot sign a packet properly!")
            // Send a signed auth packet:
            peer.send(this.makeSigPacket(peer.localSdp));
        } catch (err) {
            this.emit('warn', err);
            peer.fatalError(new ClientAuthError('Failed to send handshake.'));
        }
    }

    /** @internal */
    protected emit(event: 'connected'|'warn'|'peer-error'|'peer'|'kill'|'tracker-connect'|'peer-seen'|'peer-blacklisted', val?: any) {
        super.emit(event, val);
    }

    /**
     * Builds a binary buffer, containing the current public key & a validation signature from the matching private key.
     * @see {@link verifyPacket}
     * @private
     */
    private makeSigPacket(localSdp: string) {
        getLogger('Local SDP: ' + localSdp);
        const pub = this.cryptoKeys.publicKey;
        const sdpHash = new TextEncoder().encode(sha1(Buffer.from(localSdp)));
        const sig = nacl.sign.detached(new BufferWrapper([pub, sdpHash]).generate(), this.cryptoKeys.secretKey);
        const writer = new BufferWrapper();
        writer.writeInt(pub.length);
        writer.writeInt(sdpHash.length);
        writer.write(pub);
        writer.write(sdpHash);
        writer.write(sig);
        return writer.generate();
    }

    /**
     * Attempts to verify that the given packet was signed by, and for, the given peerID.
     *
     * Validates that the packet's public key matches the Peer's ID,
     * then validates that the packet was signed by the corresponding private key.
     *
     * @see {@link makeSigPacket}
     * @param peerID The (short) ID of the Peer responsible for this packet.
     * @param packet The binary packet received.
     * @param wantedID If a specific Host ID is desired, restrict it to this.
     * @param remoteSdp The value of the current SDP config from the Remote connection.
     * @private
     */
    private static verifyPacket(peerID: string, packet: Uint8Array, wantedID: string|null, remoteSdp: string): boolean {
        const reader = new BufferWrapper([packet]);
        const pubLen = reader.readInt();
        const sdpLen = reader.readInt();
        const pub = reader.read(pubLen);
        const sdp = reader.read(sdpLen);
        const sig = reader.readRemaining();
        const fullId = Switchboard.makeFullID(pub);

        if (wantedID && fullId.substr(0, wantedID.length) !== wantedID) {
            throw new ClientAuthError('The full client ID does not match the desired ID!');
        }
        if (!peerID || fullId.substr(0, peerID.length) !== peerID) {
            throw new ClientAuthError(`Mismatch with provided peer ID during auth! (${peerID}, ${fullId})`);
        }
        const match = nacl.sign.detached.verify(new BufferWrapper([pub, sdp]).generate(), sig, pub);
        if (!match) {
            throw new ClientAuthError('The signature did not match the packet created by the client.');
        }

        const hashedRemote = new TextEncoder().encode(sha1(Buffer.from(remoteSdp)));
        debug('Remote SDP:', remoteSdp);

        if (!BufferWrapper.areEqual(sdp, hashedRemote) || !remoteSdp) {
            // This validation is intended to protect against MitM attacks.
            throw new ClientAuthError(`The provided signed SDP hash does not match the current remote SDP hash!`);
        }
        return match;
    }

    /**
     * Generate a (short) ID from the given Public Key.
     *
     * This ID will be a shortened (20 chars) SHA-1 hash.
     * @param pubKey The public key to hash.
     * @private
     */
    private static makeID(pubKey:  Uint8Array): string {
        return Switchboard.makeFullID(pubKey).substr(0, SHORT_ID_LENGTH);
    }

    /**
     * Returns the long-form ID for the given Key, not truncated.
     * @param pubKey
     * @private
     */
    private static makeFullID(pubKey: Uint8Array): string {
        return sha1(Buffer.from(pubKey));
    }

    /**
     * Generate a new "seed", which is an encoded string of 32 random bytes.
     */
    static makeSeed() {
        return bs58.encode(nacl.randomBytes(32));
    }

    /**
     * Get the (full) ID that a given seed string will use.
     * @param seedString The string Seed, can be generated using {@link makeSeed}.
     * @param getFullID If the returned ID should be the full-length ID, or the short version.
     */
    static getIdFromSeed(seedString: string, getFullID: boolean = true) {
        const pub = this.makeCryptoPair(seedString).publicKey;
        if (getFullID) {
            return this.makeFullID(pub);
        }
        return this.makeID(pub);
    }

    /**
     * Accepts a string "seed", and uses it to rehydrate a pair of public/private keys.
     * @param seedString The seed, as generated by {@link makeSeed}.
     * @private
     */
    private static makeCryptoPair(seedString: string) {
        return nacl.sign.keyPair.fromSeed(bs58.decode(seedString));
    }
}

// noinspection JSUnusedGlobalSymbols
export default Switchboard;

// noinspection JSUnusedGlobalSymbols
/**
 * Enable/disable library-wide debug logging. Optionally provide your own custom logging callback.
 * @param enabled If logging should be enabled.
 * @param callback Pass a custom function if you wish to override the default `console.debug` behavior.
 */
export function enableLogging(enabled: boolean, callback: any = console.debug) {
    return setLogging(enabled, callback);
}
