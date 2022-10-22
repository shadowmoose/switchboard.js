import Subscribable from "./subscribable";
import {ClientIntroPacket, MsgChannelJoin, MsgClientDirect, WsMessageType, WsServerMessage} from "./shared";
import {ConnectedPeer, TrackerConnectorInterface} from "./tracker";
import {PeerConfig} from "./peer";
import {getLogger} from "./logger";

/** @internal **/
export enum ConnectionTypeOptions {
    HOST = 'HOST',
    JOIN_HOST = 'JOIN_HOST',
    SWARM = 'SWARM'
}

const debug = getLogger('sb-connector');

/**
 * The props expected by SwitchboardServerConnector
 * @internal
 * @hidden
 */
export interface SpsOptions {
    uri: string,
    fullId: string,
    publicKey: number[],
    pubKeySig: number[],
    mode: ConnectionTypeOptions,
    targetHash: string | null,
    peerConfig: PeerConfig,
    isBlacklisted: Function,
    maxReconnects: number,
    peerTimeout: number,
    passCode: string | null,
}

/**
 * Implementation for a more direct matchmaker, which uses the custom Switchboard Peering Server protocol.
 *
 * Registers at the given server, then returns Peers (`simple-peer` objects) once they are connected & ready.
 * @internal
 * @hidden
 */
export class SpsConnector extends Subscribable implements TrackerConnectorInterface {
    private readonly uri: string;
    private readonly introPacket: ClientIntroPacket;
    private readonly peerConfig: PeerConfig;
    private sock: WebSocket | null = null;
    private didConnect = false;
    private shouldReconnect = true;
    private retries = 0;
    private peers = new Map<string, ConnectedPeer>();
    private readonly fullId: string;
    private readonly isBlacklisted: Function;
    private readonly peerTimeout: number;
    private readonly maxReconnects: number;

    constructor(opts: SpsOptions) {
        super();
        this.uri = opts.uri;
        this.peerConfig = opts.peerConfig;
        this.fullId = opts.fullId;
        this.isBlacklisted = opts.isBlacklisted;
        this.maxReconnects = opts.maxReconnects;
        this.peerTimeout = opts.peerTimeout;

        this.introPacket = {
            hostTarget: opts.mode === ConnectionTypeOptions.JOIN_HOST ? opts.targetHash : null,
            hosting: opts.mode === ConnectionTypeOptions.HOST,
            id: opts.fullId,
            pubKey: opts.publicKey,
            signature: opts.pubKeySig,
            swarmChannel: opts.mode === ConnectionTypeOptions.SWARM ? opts.targetHash : null,
            passCode: opts.passCode
        }
    }

    connect() {
        this.openConnection().then(sock => this.attachSock(sock));
    }

    get isOpen() {
        return this.sock?.readyState === WebSocket.OPEN;
    }

    private openConnection(): Promise<WebSocket> {
        return new Promise((res, rej) => {
            const ws = new WebSocket(this.uri);
            function fail(reason: any) {
                ws.close();
                rej(reason);
            }
            ws.onclose = fail.bind(this);
            ws.onerror = fail.bind(this);
            ws.onopen = () => res(ws);
        })
    }

    private async attachSock(ws: WebSocket) {
        ws.onclose = (err) => {
            debug(err);
            if (this.didConnect) this.emit('disconnect');
            this.reconnect();
        }

        ws.onerror = (err) => {
            debug('WebSock Error:', err);
            ws.close();
        }
        ws.onmessage = this.handleMessage.bind(this);

        this.didConnect = true;
        this.retries = 0;
        this.sock = ws;
        this.emit('connect');

        debug("Sending intro packet.", this.introPacket);
        this.send(this.introPacket);

        return this.sock;
    }

    private reconnect() {
        if (!this.shouldReconnect || !this.didConnect) {
            return this.kill('Cannot establish connection.');
        }
        setTimeout(() => {
            this.retries+=1;

            if (this.retries > this.maxReconnects) {
                return this.kill("Reached maximum allowed reconnect retries.");
            }
            if (!this.shouldReconnect) {
                return this.kill('Cannot establish connection.');
            }

            this.openConnection()
                .then(sock => this.attachSock(sock))
                .catch(err => {
                    debug('Error reconnecting to WebSock:', err);
                    this.reconnect();
                });
        }, Math.min(5, this.retries) * 2000);
    }

    private send(data: Object) {
        this.sock?.send(JSON.stringify(data));
    }

    protected emit(event: 'disconnect'|'connect'|'peer'|'kill', val?: any) {
        super.emit(event, val);
    }

    private async handleMessage(msg: MessageEvent) {
        const raw = msg.data;
        if (raw === 'dc') return this.kill('Invalid server credentials.');
        if (raw === 'ping') return this.sock?.send('pong');
        if (typeof raw !== 'string') return;
        const packet: WsServerMessage = JSON.parse(raw);

        debug('WS Message:', packet);

        switch (packet.type) {
            case WsMessageType.JOIN:
                await this.sendHandshake(packet);
                break;
            case WsMessageType.MSG:
                await this.handleHandshake(packet);
                break;
            default:
                debug('Unknown packet type:', packet);
        }
    }

    private async sendHandshake(pkt: MsgChannelJoin) {
        const np = this.makePeer(pkt.data.id);

        await np.handshake('', true);
    }

    private async handleHandshake(pkt: MsgClientDirect) {
        const p = this.getOrMakePeer(pkt.from);

        // Check blacklist:
        if (pkt.from && this.isBlacklisted(pkt.from)) {
            debug('Ignoring blacklisted client:', pkt.from);
            return;
        }

        return p.handshake(pkt.data, false);
    }

    private getOrMakePeer(targetId: string) {
        const p = this.peers.get(targetId);
        if (p) return p;

        return this.makePeer(targetId);
    }

    private makePeer(targetId: string) {
        const peer = new ConnectedPeer({
            ...this.peerConfig,
            trickleICE: false
        });

        peer.id = targetId;

        peer.once('connect', () => {
            clearTimeout(peer.timeoutTracker);
            peer.removeAllListeners('error');
            debug('WS Tracker connected to peer:', peer, peer.id);
            this.peers.delete(targetId);
            this.emit('peer', peer);
        });

        peer.permanent('close', () => {
            const p = this.peers.get(targetId);
            if (p) {
                p.close();
            }
            this.peers.delete(targetId);
        });

        peer.on('handshake', hs => {
            const invitePacket: MsgClientDirect = {
                data: hs,
                from: this.fullId,
                targetClient: targetId,
                type: WsMessageType.MSG
            }

            return this.send(invitePacket);
        });

        peer.timeoutTracker = setTimeout(() => {
            debug("Peer timed out waiting for websocket response.");
            peer.close();
        }, this.peerTimeout);

        this.peers.set(targetId, peer);
        return peer;
    }

    /**
     * Kill this WebSocket connection to the Tracker, and disable reconnection.
     *
     * All cleanup handled by the internal `websocket.onclose` handler will also be applied as a result.
     */
    public kill(err?: any) {
        debug('KILLED: Tracker kill error:', err);
        this.shouldReconnect = false;
        try {
            this.sock?.close();
        } catch (ignored) {}
        this.peers.forEach(p => {
            p.fatalError(new Error('Disconnected from signaling server socket.'));
        })
        this.emit('kill', err||null);
    }
}
