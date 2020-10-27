import {TrackerConnector, ConnectedPeer, setLogging} from './tracker'
import Subscribable from "./subscribable";
import {ClientAuthError, ConnectionFailedError} from "./errors";
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import sha1 from 'sha1';
import {PeerConfig} from "./peer";

/**
 * These are the options that the Switchboard accepts as configuration.
 */
export interface SBClientOptions {
    /**
     * A list of strings and/or {@link TrackerOptions} config objects.
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
}

/** Custom configuration for client Trackers. */
export interface TrackerOptions {
    /** The WebSocket URI to join. */
    uri: string;
    /** If true, the whole Switchboard will fail (and disconnect from all trackers) if this tracker fails to connect. */
    isRequired?: boolean;
    /** Optionally overwrite client values passed into each `simple-peer` Peer created by this tracker. */
    customPeerOpts?: PeerConfig;
    /**
     * The interval, in milliseconds, that each tracker should re-announce.
     * Don't change this unless you know what you're doing.
     */
    trackerAnnounceInterval?: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_CLIENT_TIMEOUT = 150000;
const SHORT_ID_LENGTH = 20;
const DEFAULT_TRACKERS: string[] = [
    'wss://tracker.sloppyta.co:443/announce',
    'wss://tracker.files.fm:7073/announce',
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz'
];
const DEFAULT_ANNOUNCE_RATE = 50000;


// noinspection JSUnusedGlobalSymbols
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
     * If this is emitted, the Switchboard is dead.
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
    private trackers: Set<TrackerConnector> = new Set();
    private connected: Record<string, ConnectedPeer> = {};
    private infoHash: string = '';
    private killed: boolean = false;
    private wantedPeerCount: number = 0;
    private wantedSpecificID: string|null = null;
    private _fullID: string|null = null;

    /**
     * Creates a new Switchboard matchmaker.
     *
     * To start finding peers, call one of: [{@link host}, {@link findHost}, {@link swarm}].
     * @param opts Extra optional config values that this instance will use.
     * @see {@link SBClientOptions}
     */
    constructor(opts?: SBClientOptions) {
        super();

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
     * If additional security is desired when connecting to specific IDs, use {@link fullID}.
     * @see {@link makeID}
     */
    get peerID(): string {
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
    private start(swarmID: string) {
        this.infoHash = sha1(swarmID);

        let canEmit = true;
        const checkReady = () => {
            if (canEmit && Array.from(this.trackers).every(t => t.isOpen)) {
                canEmit = false;
                this.emit('connected', Array.from(this.trackers));
            }
        }

        for (const trk of this.trackerOpts) {
            const cfg: PeerConfig = trk.customPeerOpts||{};
            const announce = trk.trackerAnnounceInterval || DEFAULT_ANNOUNCE_RATE;
            const t = new TrackerConnector(trk.uri, this.peerID, this.infoHash, cfg, this.shouldBlockConnection.bind(this), announce, this.wantedPeerCount);

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

    /**
     * Connect to trackers as a Host, listening for client Peers.
     * Clients looking for a specific Host via {@link findHost} will require that this is eventually called by the Host.
     *
     * @param maxPeers Optionally limit the maximum concurrently connected peers.
     * @see {@link findHost}
     */
    host(maxPeers?: number) {
        this.wantedPeerCount = maxPeers || 500;
        this.start(this.peerID);
    }

    /**
     * Connects only to the given Host PeerID.
     * This requires that you have exchanged in advance the Host's ID.
     *
     * For this to work, the Host *must* call {@link host}.
     * If the Host is not yet online, they will be located once they become available.
     * @param hostID
     * @see {@link host}
     */
    findHost(hostID: string) {
        this.wantedPeerCount = 1;
        this.wantedSpecificID = hostID;
        this.start(hostID);
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
        this.start(swarmID);
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
     * @param peerID
     * @private
     */
    private shouldBlockConnection(peerID: string) {
        this.emit('peer-seen', peerID);
        return this.isBlackListed(peerID)
            || (this.wantedSpecificID && peerID !== this.wantedSpecificID.substr(0, peerID.length)) // quick initial short-ID filter.
            || this.connected[peerID]
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
     * Increases a Peer's failure count - potentially resulting in their blacklisting.
     * If increment is not given, the Peer will be automatically blacklisted.
     * @param peer The peer to (potentially) blacklist.
     * @param increment The amount of failures to increment. Defaults to instantly blacklisting.
     */
    addPeerFailure(peer: ConnectedPeer, increment?: number) {
        if (!increment) increment = this.opts.clientMaxRetries || Infinity;
        if (this.isBlackListed(peer.id)) return;

        if (this.opts.clientBlacklistDuration) {
            this.blacklist[peer.id] = this.blacklist[peer.id] || 0;
            this.blacklist[peer.id] += increment;
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
                if (Switchboard.verifyPacket(peer.id, new Uint8Array(data), this.wantedSpecificID)) {
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
            // Send a signed auth packet:
            peer.send(this.makeSigPacket());
        } catch (err) {
            this.emit('warn', err);
            peer.fatalError(new ClientAuthError('Failed to send handshake.'));
        }
    }

    /**
     * Builds a binary buffer, containing the current public key & a validation signature from the matching private key.
     * @see {@link verifyPacket}
     * @private
     */
    private makeSigPacket() {
        const pub = this.cryptoKeys.publicKey;
        const sig = nacl.sign.detached(pub, this.cryptoKeys.secretKey);
        const ret = new Uint8Array(1 + pub.length + sig.length);
        ret.set([pub.length]);
        ret.set(pub, 1);
        ret.set(sig, pub.length+1);
        return ret;
    }

    protected emit(event: 'connected'|'warn'|'peer-error'|'peer'|'kill'|'tracker-connect'|'peer-seen'|'peer-blacklisted', val?: any) {
        super.emit(event, val);
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
     * @private
     */
    private static verifyPacket(peerID: string, packet: Uint8Array, wantedID: string|null): boolean {
        const pubLen = packet.slice(0,1)[0];
        const pub = packet.slice(1, pubLen+1);
        const sig = packet.slice(1+pubLen);

        if (wantedID && Switchboard.makeFullID(pub).substr(0, wantedID.length) !== wantedID) {
            throw new ClientAuthError('The full client ID does not match the desired ID!');
        }
        if (Switchboard.makeID(pub) !== peerID) {
            throw new ClientAuthError('Mismatch with provided peer ID during auth!');
        }
        const match = nacl.sign.detached.verify(pub, sig, pub);
        if (!match) {
            throw new ClientAuthError('The signature did not match the packet created by the client.');
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
