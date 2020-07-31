import nacl from 'tweetnacl';
import Peer from 'simple-peer';
import Subscribable from "./subscribable";
import {ConnectionFailedError} from "./errors";

// noinspection JSUnusedLocalSymbols
/**
 * @hidden The debug-logging method. Defaults to noop.
 */
let debug = (...args: any)=>{};

/**
 * Enable/disable debug logging. Optionally provide your own custom logging callback.
 * @param enabled If logging should be enabled.
 * @param callback Pass a custom function if you wish to override the default `console.debug` behavior.
 */
export function setLogging(enabled: boolean, callback: any = console.debug) {
    if (enabled) {
        debug = callback;
    } else {
        debug = ()=>{};
    }
}

/**
 * Wrapper for the `simple-peer` Peer object, contains the extra metadata that the TrackerConnector will append.
 */
export class PeerWrapper extends Peer {
    private permanentHandlers: Record<string, any[]> = {};

    /**
     * The ID this peer has used to identify themselves, cross-tracker.
     */
    public id: string = '';

    /**
     * Store the ping timeout with each peer.
     */
    public timeoutTracker: any = null;

    /**
     * Register an event that cannot be cleared.
     * Used internally to guarantee certain events (close, etc.) are detected.
     * @param event
     * @param handler
     */
    public permanent(event: string, handler: any) {
        this.permanentHandlers[event] = this.permanentHandlers[event] || [];
        this.permanentHandlers[event].push(handler);
        this.on(event, handler);
    }

    public removeAllListeners(event?: string): this {
        super.removeAllListeners(event);

        const events = event? [event] : Object.keys(this.permanentHandlers);
        events.forEach( event => {
            const handlers = this.permanentHandlers[event];
            if (handlers) {
                handlers.forEach(h => this.on(event, h))
            }
        })

        return this;
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * If this Peer is currently connected.
     */
    get connected(): boolean {
        // @ts-ignore
        return super.connected;
    }
}

/**
 * General wrapper to accommodate the general packet structure exchanged with each Tracker.
 */
export interface AnnouncePacket {
    info_hash: string;
    peer_id: string;
    numwant: number;
    downloaded: number;
    left: number;
    event?: string;
    action: "announce";
    offers?: Offer[];
    offer?: any;
    answer?: any;
    offer_id?: string;
    interval?: number;
    'min interval'?: number;
    'failure reason'?: string;
    'tracker id'?: string;
}

interface Offer {
    offer: any;
    offer_id: string;
}

export interface TrackerConnector {
    /**
     * Triggered when the connection is lost to the Tracker server.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     */
    subscribe(event: 'disconnect', callback: Function): () => void;

    /**
     * Triggered when the connection is established to the Tracker server.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     */
    subscribe(event: 'connect', callback: Function): () => void;

    /**
     * Triggered when a new Peer object is located and connected.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     */
    subscribe(event: 'peer', callback: {(peer: PeerWrapper): void}): () => void;

    /**
     * Triggered when this TrackerConnector is unrecoverably killed.
     * @param event
     * @param callback A function that can receive the Error, if any, that caused termination.
     * @returns A function to call, in order to unsubscribe.
     */
    subscribe(event: 'kill', callback: {(err: Error|null): void}): () => void;
}

/**
 * Naive implementation of the WebsSocket matchmaking protocol used by WebTorrent services.
 *
 * Registers at the given server, then returns Peers (`simple-peer` objects) once they are connected & ready.
 */
export class TrackerConnector extends Subscribable{
    private readonly url: string;
    private readonly peerID: string;
    private readonly infoHash: string;
    private readonly peerConfig: object;
    private readonly isBlacklisted: Function;
    private shouldReconnect: boolean = true;
    private timer: any = null;
    private sock: WebSocket|null = null;
    private peers: Record<string, PeerWrapper> = {};
    private openOffers: Offer[] = [];  // Offers are opaque to this middleman.
    private currentAnnounceInterval: number = 50000;
    private introPending: boolean = true;
    private connectTries: number = 0;
    private trackerID: string|null = null;
    private maxOpenOffers: number = 10;
    private didConnect: boolean = false;

    /**
     * Create and connect to a new Tracker, using a websocket URL.
     * @param trackerURL The "ws" or "wss" tracker URL to join.
     * @param peerID The ID to identify this client. Reuse this across all trackers.
     * @param infoHash The "info hash" to register with the Tracker. This is used as a connection ID.
     * @param peerConfig An object with additional params to pass into each created simple-peer Peer object.
     * @param isBlacklisted A function, which decides if a given Peer ID may connect pre-handshake.
     */
    constructor(trackerURL: string, peerID: string, infoHash: string, peerConfig: object, isBlacklisted: Function) {
        super();
        this.url = trackerURL;
        this.peerID = peerID;
        this.isBlacklisted = isBlacklisted;
        this.infoHash = Buffer.from(infoHash, 'hex').toString('binary');
        this.peerConfig = peerConfig;
    }

    /**
     * If this current tracker's websocket is open.
     */
    get isOpen() {
        return this.sock?.readyState === WebSocket.OPEN;
    }

    /**
     * Connect to this tracker. Creates a new WebSocket & binds callbacks.
     */
    connect() {
        this.sock = new WebSocket(this.url);
        this.sock.onclose = this.reconnect.bind(this);
        this.sock.onerror = this.onError.bind(this);
        this.sock.onopen = this.onConnect.bind(this);
        this.sock.onmessage = this.onMessage.bind(this);
    }

    /**
     * Close the current WebSocket connection, and cleans up all pending offers.
     *
     * This is for internal use only. Use `kill()` instead, when manually disconnecting.
     * @private
     */
    private close() {
        debug('closing tracker socket.');
        this.sock?.close();
        clearInterval(this.timer);
        this.openOffers.map(o => o.offer_id).forEach(oid => this.retractOffer(oid, true));
        this.emit('disconnect');
    }

    /**
     * Called when a the WebSocket disconnects, to trigger automatic reconnection with a rate-limited timer.
     * @private
     */
    private reconnect() {
        if (!this.shouldReconnect) return;

        this.connectTries = Math.min(10, this.connectTries+1);
        setTimeout(() => {
            this.close();
            this.connect();
        }, this.connectTries * 2000);
    }

    /**
     * Send the given Object to the WebSocket tracker.
     * @param message {object} Any serializable object.
     * @private
     */
    private send(message: any) {
        if (this.sock) {
            this.sock.send(JSON.stringify(message));
        }
    }

    /**
     * Called when the WebSocket connects to the tracker.
     * Automatically handles the handshake packet & schedules announcements.
     * @private
     */
    private onConnect() {
        debug('Connecting to tracker:', this.url)
        this.didConnect = true;
        const intro: AnnouncePacket = {
            action: "announce",
            event: "completed",
            downloaded: 0,
            info_hash: this.infoHash,
            left: 0,
            numwant: 50,
            peer_id: this.peerID
        }
        this.introPending = true;
        this.send(intro);
        this.setAnnounceTimer(this.currentAnnounceInterval);
        this.emit('connect');
    }

    /**
     * Called when the tracker experiences an error.
     * If a connection was previously established, reconnects.
     * Otherwise, kills this tracker with an ConnectionFailedError.
     * @param error
     * @private
     */
    private onError(error: Event) {
        debug('WS Error:', error, this.url);
        if (this.didConnect) {
            this.didConnect = false;
            this.reconnect();
        } else {
            this.kill(new ConnectionFailedError('Connection could not be established to websocket host.'));
        }
    }

    /**
     * Called when a message is received from the Tracker.
     * Handles changes in announcement rate, error messages, and peer introductions.
     * @param event {MessageEvent} The websocket message event.
     * @private
     */
    private onMessage(event: MessageEvent) {
        const msg: AnnouncePacket = JSON.parse(event.data);
        const interval: any = msg.interval || msg['min interval'];

        debug('Incoming Tracker Data:', msg);

        if (msg['failure reason']) {
            console.error(msg['failure reason']);
            return this.kill();
        }

        if (interval && interval*1000 !== this.currentAnnounceInterval) {
            this.setAnnounceTimer(interval*1000);
        }

        const trackerID = msg['tracker id']
        if (trackerID) {
            this.trackerID = trackerID
        }

        if (this.introPending) {
            this.introPending = false;
            this.getAnnouncePacket('started', 10).then(packet => {
                this.send(packet);
            }).catch(err => {
                this.kill(err);
            })
        }

        if (msg.peer_id && this.isBlacklisted(msg.peer_id)) {
            debug('Ignoring blacklisted client:', msg.peer_id);
            return;
        }

        if (msg.offer && msg.peer_id && msg.offer_id) {
            debug('Joining peer:', msg.peer_id);
            const peer = this.makePeer(msg.offer_id, false);
            peer.once('signal', answer => {
                const params: any = {
                    action: 'announce',
                    info_hash: this.infoHash,
                    peer_id: this.peerID,
                    to_peer_id: msg.peer_id,
                    answer,
                    offer_id: msg.offer_id
                }
                if (this.trackerID) params.trackerID = this.trackerID;
                peer.id = msg.peer_id;
                this.send(params);
            });
            peer.signal(msg.offer);
        }

        if (msg.answer && msg.peer_id && msg.offer_id) {
            debug('Accepting peer:', msg.offer_id, msg.peer_id);
            const peer = this.peers[msg.offer_id];

            peer.id = msg.peer_id;

            if (peer) {
                peer.signal(msg.answer);
            } else {
                debug(msg);
            }
        }
    }

    /**
     * Stops the current announcement timer, and reschedules a new one.
     * If the given interval is null, does not reschedule.
     * @param interval
     * @private
     */
    private setAnnounceTimer(interval: number|null) {
        debug('Announce Timer interval:', interval, this.url);
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }

        if (interval !== null) {
            this.currentAnnounceInterval = interval;
            this.timer = setInterval(this.reAnnounce.bind(this), interval);
        }
    }

    /**
     * Builds an announcement packet, for the given event.
     * If invites is specified, also generates that amount of WebRTC SDP Offers.
     * @param event The type of event to provide in the packet, or `null` to exclude.
     * @param invites {number} The number of offers that should be asynchronously generated.
     * @private
     */
    private async getAnnouncePacket(event?: "started"|"complete"|null, invites:number = 0): Promise<AnnouncePacket> {
        const ret: AnnouncePacket = {
            action: "announce",
            downloaded: 0,
            info_hash: this.infoHash,
            left: 0,
            numwant: 50,
            peer_id: this.peerID
        }
        if (event) ret.event = event;

        if (invites) {
            this.maxOpenOffers = invites * 2;
            const pending: Promise<Offer>[] = [];
            for (let i=0; i < invites; i++) {
                pending.push(this.createOffer());
            }

            ret.offers = await Promise.all(pending);
        }

        return ret;
    }

    /**
     * Asynchronously generate an SDP Offering, for WebRTC connection establishment.
     *
     * In theory, this returns an object with a small descriptor of the offering & the string contents.
     *
     * In practice, this offering value should be treated as opaque, as it is specific to WebRTC implementation.
     * @private
     */
    private async createOffer(): Promise<Offer> {
        return new Promise((res, rej) => {
            const offerID = Buffer.from(nacl.randomBytes(20)).toString('hex');
            const peer = this.peers[offerID] = this.makePeer(offerID, true);

            peer.once('signal', (offer: any) => {
                const off = {
                    offer,
                    offer_id: offerID
                };
                this.openOffers.push(off)
                while (this.openOffers.length > this.maxOpenOffers) {
                    this.retractOffer(this.openOffers[0].offer_id, true);
                }
                res(off);
            });
            peer.once('error', (err) => {
                this.retractOffer(offerID, true);
                rej(err);
            });
        });
    }

    /**
     * Remove the given offerID, and cancel the corresponding peer if specified.
     *
     * If the offer is not in the "last chance" phase, only removes it from the list of tracked offers.
     * @param offerID {string} The ID to cancel.
     * @param killPeer {boolean} If the offer is no longer valid, cancel the peer if true.
     * @private
     */
    private retractOffer(offerID: string, killPeer: boolean = true) {
        const idx = this.openOffers.findIndex(o => o.offer_id === offerID);

        if (idx >= 0) {
            debug(offerID, '- kill:', killPeer);

            if (killPeer) this.peers[offerID].destroy();

            delete this.peers[offerID];
            this.openOffers.splice(idx, 1);
        }
    }

    /**
     * Generates a simple-peer object, using the config provided in the creation of this Tracker.
     *
     * Automatically registers the Peer to clear its own offering if a connection is established.
     * @param offerID {string} The offer ID that should be used for this peer.
     * @param initiator {boolean} If this Peer will be an initiator - and thus should generate an offer.
     * @private
     */
    private makePeer(offerID: string, initiator: boolean): PeerWrapper {
        const peer = new PeerWrapper({
            config: this.peerConfig,
            trickle: false,
            initiator
        });

        peer.once('connect', () => {
            peer.removeAllListeners('error');
            this.retractOffer(offerID, false);
            this.onPeerConnected(peer)
        });

        return peer;
    }

    /**
     * Triggered by each simple-peer Peer object if it establishes an open connection to another User.
     * @param peer The Peer object that has just become open for data transmission.
     * @private
     */
    private onPeerConnected(peer: PeerWrapper) {
        debug('Tracker connected to peer:', peer, peer.id);
        this.emit('peer', peer);
    }

    /**
     * Called automatically on a timer to send the latest Announcement Packet data to the Tracker.
     * @private
     */
    private async reAnnounce() {
        if (!this.sock) return;

        const packet = await this.getAnnouncePacket(null, 10).catch(this.kill);

        debug(packet);

        this.send(packet);
    }

    protected emit(event: 'disconnect'|'connect'|'peer'|'kill', val?: any) {
        super.emit(event, val);
    }

    /**
     * Kill this WebSocket connection to the Tracker, and disable reconnection.
     *
     * All cleanup handled by the internal `websocket.onclose` handler will also be applied as a result.
     */
    public kill(err?: any) {
        debug('Tracker kill error:', err);
        this.shouldReconnect = false;
        this.close();
        this.emit('kill', err||null);
    }
}
