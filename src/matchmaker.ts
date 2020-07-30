import randombytes from 'randombytes'
import Peer from 'simple-peer';
import Subscribable from "./subscribable";

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
    /**
     * The ID this peer has used to identify themselves, cross-tracker.
     */
    public id: string = '';
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
    offers?: {
        offer: any;
        offer_id: string;
    }[];
    offer?: any;
    answer?: any;
    offer_id?: string;
    interval?: number;
    'min interval'?: number;
    'failure reason'?: string;
    'tracker id'?: string;
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
    private shouldReconnect: boolean = true;
    private timer: any = null;
    private sock: WebSocket|null = null;
    private peers: Record<string, PeerWrapper> = {};
    private openOffers: Record<string, any> = {};  // Offers are opaque to this middleman.
    private openLastOffers: Record<string, any> = {}; // cache of previous offers, which the tracker no longer has.
    private currentAnnounceInterval: number = 50000;
    private introPending: boolean = true;
    private connectTries: number = 0;
    private trackerID: string|null = null;

    /**
     * Create and connect to a new Tracker, using a websocket URL.
     * @param trackerURL The "ws" or "wss" tracker URL to join.
     * @param peerID The ID to identify this client. Reuse this across all trackers.
     * @param infoHash The "info hash" to register with the Tracker. This is used as a connection ID.
     * @param peerConfig An object with additional params to pass into each created simple-peer Peer object.
     */
    constructor(trackerURL: string, peerID: string, infoHash: string, peerConfig: object) {
        super();
        this.url = trackerURL;
        this.peerID = peerID;
        this.infoHash = Buffer.from(infoHash, 'hex').toString('binary');
        this.peerConfig = peerConfig;

        this.connect();
    }

    /**
     * Returns a boolean, representing if this tracker is still viable.
     */
    get isWorking(): boolean {
        return this.shouldReconnect;
    }

    /**
     * Connect to this tracker. Creates a new WebSocket & binds callbacks.
     * @private
     */
    private connect() {
        this.sock = new WebSocket(this.url);
        this.sock.onclose = this.reconnect.bind(this);
        this.sock.onerror = this.kill.bind(this);
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
        this.sock?.close();
        clearInterval(this.timer);
        Object.keys(this.openOffers).forEach(oID => this.retractOffer(oID, true));
        Object.keys(this.openLastOffers).forEach(oID => this.retractOffer(oID, true));
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
     * Called when a message is received from the Tracker.
     * Handles changes in announcement rate, error messages, and peer introductions.
     * @param event {MessageEvent} The websocket message event.
     * @private
     */
    private onMessage(event: MessageEvent) {
        const msg: AnnouncePacket = JSON.parse(event.data);
        const interval: any = msg.interval || msg['min interval'];

        debug(msg);

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
                console.error(err);
            })
        }

        if (msg.offer && msg.peer_id && msg.offer_id) {
            debug(msg.peer_id);
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
            debug(msg.offer_id, msg.peer_id);
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
        debug(interval);
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }

        if (interval !== null) {
            this.currentAnnounceInterval = interval;
            setInterval(this.reAnnounce.bind(this), interval);
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
            for (const oID of Object.keys(this.openLastOffers)) {
                this.retractOffer(oID);
            }

            for (const oID of Object.keys(this.openOffers)) {
                // Cache the previous batch of offers for a bit, just in case somebody is currently trying to join.
                this.openLastOffers[oID] = this.openOffers[oID];
                delete this.openOffers[oID];
            }

            const pending: Promise<any>[] = [];
            for (let i=0; i < invites; i++) {
                pending.push(this.createOffer());
            }

            await Promise.all(pending);

            ret.offers = [];
            for (const oID of Object.keys(this.openOffers)) {
                ret.offers.push({
                    offer: this.openOffers[oID],
                    offer_id: oID
                })
            }
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
    private async createOffer(): Promise<any> {
        return new Promise((res, rej) => {
            const offerID = randombytes(20).toString('hex');
            const peer = this.peers[offerID] = this.makePeer(offerID, true);

            peer.once('signal', (offer: any) => {
                this.openOffers[offerID] = offer;
                res(offer);
            });
            peer.once('error', (err) => {
                peer.destroy();
                this.retractOffer(offerID);
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
        if (this.openOffers[offerID]) {
            debug(offerID, '- kill:', killPeer);

            if (killPeer) this.peers[offerID].destroy();

            if (this.openLastOffers[offerID]) {
                delete this.peers[offerID];
                delete this.openLastOffers[offerID];
            }
            delete this.openOffers[offerID];
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
        debug(peer, peer.id);
        this.emit('peer', peer);
    }

    /**
     * Called automatically on a timer to send the latest Announcement Packet data to the Tracker.
     * @private
     */
    private async reAnnounce() {
        if (!this.sock) return;

        const packet = await this.getAnnouncePacket(null, 10);

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
        this.shouldReconnect = false;
        this.close();
        this.emit('kill', err||null);
    }
}
