
// Debugging: chrome://webrtc-internals/


import Subscribable from "./subscribable";

/**
 * These are the options each Peer object accepts in its constructor.
 */
export interface PeerConfig {
    /**
     * If `true`, enable Trickle ICE.
     * If disabled, each peer will gather ICE candidates for {@link trickleTimeout} ms before being considered "ready".
     *
     * This is `false` by default. Switchboard requires that this be disabled.
     */
    trickleICE?: boolean;
    /**
     * If not using Trickle ICE, wait up to this long for ICE Candidate to arrive.
     * For connections that are very slow, you may see more reliable results by increasing this value.
     */
    trickleTimeout?: number;
    /**
     * Options to pass directly into the RTCPeerConnection constructor.
     * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/RTCConfiguration}
     */
    rtcPeerOpts?: RTCConfiguration;
    /**
     * The options to pass directly into {@link https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createAnswer createAnswer()}.
     * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/RTCAnswerOptions}
     */
    rtcAnswerOpts?: RTCAnswerOptions;
    /**
     * The options to pass directly into {@link https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createOffer createOffer()}.
     * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/RTCOfferOptions}
     */
    rtcOfferOpts?: RTCOfferOptions;
}

/** @internal */
const META_CHANNEL = '_meta';


// noinspection JSUnusedGlobalSymbols
export interface Peer {
    /**
     * Triggered when this Peer has created a handshake packet that must be sent to the remote Peer.
     * If `trickle ICE` is enabled, this may also contain ICE candidates.
     *
     * Implementations should not worry about the content of this message, and should just relay it.
     *
     * The remote peer should receive this data, then call {@link handshake handshake(data)} with it to continue the process.
     *
     * Call {@link handshake handshake()} with no arguments to start this process on the initiator's side only.
     *
     * _If you are using Switchboard, these handshake events will be handled automatically for you._
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'handshake', callback: {(data: string): void}): () => void;

    /**
     * Triggered when this Peer has connected. This will only ever trigger once, on the initial connect.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'connect', callback: Function): () => void;

    /**
     * Triggered when this Peer's connection has become stable.
     * This will be triggered multiple times if new Media channels are added/removed.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     * @see {@link addMedia}
     */
    on(event: 'ready', callback: Function): () => void;

    /**
     * Triggered when this Peer's default DataChannel receives a MessageEvent.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'message', callback: {(message: MessageEvent): void}): () => void;

    /**
     * Triggered when this Peer's default DataChannel receives a MessageEvent.
     *
     * This is functionally the same as {@link on on('message')}, and fires with it,
     * except that it receives only the Event data.
     * This callback has been implemented for better cross-compatibility.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'data', callback: {(data: string|ArrayBuffer|Blob|ArrayBufferView): void}): () => void;

    /**
     * Triggered when a new {@link https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel RTCDataChannel} is created.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'dataChannel', callback: {(peer: RTCDataChannel): void}): () => void;

    /**
     * Triggered when a new {@link https://developer.mozilla.org/en-US/docs/Web/API/MediaStream MediaStream} is created from the remote Peer.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'stream', callback: {(peer: MediaStream): void}): () => void;

    /**
     * Triggered when an Error is raised. This does not always mean the Peer must disconnect.
     * @param event
     * @param callback A function that can receive the Error, if any, that caused termination.
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'error', callback: {(err: Error): void}): () => void;

    /**
     * Triggered when this Peer has been closed, either locally or by the remote end.
     * See the 'disconnect' event if you only wish to detect unexpected disconnections.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'close', callback: Function): () => void;

    /**
     * Triggered when this Peer has been unexpectedly disconnected.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     */
    on(event: 'disconnect', callback: Function): () => void;

    /**
     * Triggered when all ICE discovery finishes (or the configured timer expires), if Trickle ICE is enabled.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     * @see {@link PeerConfig}
     */
    on(event: 'iceFinished', callback: Function): () => void;

    /**
     * Triggered when trickle ICE discovers another value, if `trickle ICE` is enabled.
     *
     * If enabled, the `handshake` event already handles emitting these in the format it expects.
     * @param event
     * @param callback
     * @returns A function to call, in order to unsubscribe.
     * @see {@link PeerConfig}
     */
    on(event: 'iceEvent', callback: {(err: RTCPeerConnectionIceEvent): void}): () => void;
}

// noinspection JSUnusedGlobalSymbols
/**
 * This is a wrapper for a RTCPeerConnection.
 * It greatly simplifies the process of interacting with WebRTC, and adds some much-needed features.
 *
 * The largest feature added in this wrapper is the ability to establish new Media channels without re-negotiating over
 * a websocket connection. To accomplish this, the wrapper establishes an internal DataChannel to communicate.
 *
 * The wrapper also creates a second, default DataChannel which can be automatically used for peer communications.
 * Both of these channels are prearranged out-of-band, so they cost very little to create.
 */
export class Peer extends Subscribable{
    private readonly pc: RTCPeerConnection;
    private readonly timers: any[] = [];
    private readonly config: Partial<PeerConfig>;
    private readonly awaitICE: Promise<null>;
    private readonly dataChannels: Record<string, RTCDataChannel> = {};
    private readonly dataSendQueue: Record<string, any[]> = {};
    private readonly pendingCandidates: any[] = [];
    private initiator = false;
    private closed = false;
    private hasConnected = false;

    constructor(config: Partial<PeerConfig>) {
        super();
        this.config = config || {};
        this.pc = new RTCPeerConnection(Object.assign({
            iceServers: [
                {
                    url: "stun:global.stun.twilio.com:3478?transport=udp",
                    urls: "stun:global.stun.twilio.com:3478?transport=udp"
                },
                {
                    url: "stun:stun.l.google.com:19302",
                    urls: "stun:stun.l.google.com:19302"
                }
            ]
        }, this.config.rtcPeerOpts));

        this.addDataChannel(META_CHANNEL, {id: 0, negotiated: true}).onmessage = this.inBand.bind(this);
        this.addDataChannel("default", {id: 1, negotiated: true}).onmessage = message => {
            this.emit('message', message);
            this.emit('data', message.data)
        }

        this.awaitICE = new Promise((res) => {
            this.pc.onicecandidate = (iceEvent: RTCPeerConnectionIceEvent) => {
                this.emit('iceEvent', iceEvent);
                if (iceEvent.candidate === null){
                    res()
                } else if (this.config.trickleICE) {
                    this.emit('handshake', JSON.stringify(iceEvent));
                }
            }
        });
        this.pc.addEventListener('datachannel', ch => {
            this.registerDataChannel(ch.channel);
        });
        this.pc.addEventListener('connectionstatechange', this.onConnectionState.bind(this));
        this.pc.onsignalingstatechange = this.onConnectionState.bind(this);
        this.pc.onnegotiationneeded = async () => {
            if (this.dataChannels[META_CHANNEL].readyState === 'open') {
                await this.pc.setLocalDescription(await this.pc.createOffer());
                this.sendMeta({ description: this.pc.localDescription} );
            }
        }
        this.pc.ontrack = this.onTrack.bind(this);
    }

    /**
     * Emit a ready event, and an Open event if one hasn't already been sent.
     * @private
     */
    private emitReady() {
        this.emit('ready');
        if (!this.hasConnected) {
            this.hasConnected = true;
            this.emit('connect');
        }
    }

    /**
     * Triggered when the connection state changes for the current connection.
     * Handles emitting some events.
     * @param ev
     * @private
     */
    private onConnectionState(ev: Event) {
        const state: string = this.pc.connectionState || this.pc.signalingState;
        switch (state) {
            case "new":
                break;
            case "disconnected":
            case "closed":
                this.close();
                break;
            case "failed":
                this.fatalError(new Error(`Connection error: ${ev}`));
                break;
            default:
                break;
        }
    }

    /**
     * Called when a new Media Stream/Track is added by the remote Peer.
     * @param ev
     * @private
     */
    private onTrack(ev: RTCTrackEvent) {
        if (ev.streams) {
            ev.streams.filter(s => !!s).forEach(s => this.emit('stream', s));
        } else {
            this.emit('stream', new MediaStream([ev.track]));
        }
    }

    /**
     * Permanently close this Peer, and kill any running background timers.
     */
    close(intentional: boolean = true) {
        if (!this.closed) {
            this.closed = true;
            this.timers.forEach(t => clearTimeout(t));
            this.timers.splice(0, this.timers.length);
            this.pc.close();
            this.emit('close');
            if (!intentional) this.emit('disconnect')
        }
    }

    /**
     * If this Peer connection has been terminated permanently.
     */
    get isClosed() {
        return this.closed;
    }

    /**
     * If this Peer connection currently has an open connection.
     */
    get isConnected() {
        return this.pc.connectionState === 'connected';
    }

    /**
     * If this Peer is currently connected, and has its internal channel open for communication.
     */
    get isReady() {
        return !this.isClosed && this.isConnected && this.dataChannels[META_CHANNEL].readyState === 'open';
    }

    /**
     * This function handles all initial signaling steps, processing incoming data to establish a WebRTC Connection.
     * Call this function with no params to start a connection as the `initiator`.
     *
     * Whenever this peer emits a `handshake` event, the data it produces should be relayed to the remote Peer.
     * Whenever the remote Peer sends handshake data, the data should be passed into this local Peer via `handshake(data)`.
     *
     * After an initial back-and-forth (unless Trickle ICE is enabled), no additional Handshake data should be required.
     * Any subsequent negotiations will be handled internally via DataChannels.
     * @param data The data sent from the remote peer's `handshake` event, or none to initiate the handshake.
     * @see {@link https://webrtc.org/getting-started/peer-connections}
     */
    async handshake(data: any = 'initiate') {
        if (this.isClosed) return;

        if (data === 'initiate') {
            this.initiator = true;
            this.emit('handshake', JSON.stringify(await this.makeOffer()))
            return;
        }
        if (typeof data === 'string') {
            data = JSON.parse(data);
        }
        if (data.candidate) {
            if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
                await this.pc.addIceCandidate(data.candidate);
            } else {
                this.pendingCandidates.push(data.candidate);
            }
        }
        if (data.sdp) {
            try {
                await this.pc.setRemoteDescription(new RTCSessionDescription(data));
                this.pendingCandidates.forEach(candidate => {
                    this.pc.addIceCandidate(candidate)
                })
                this.pendingCandidates.splice(0, this.pendingCandidates.length);

                if (this.pc.remoteDescription?.type === 'offer') {
                    this.emit('handshake', JSON.stringify(await this.makeAnswer(new RTCSessionDescription(data))))
                }
            } catch(err) {
                this.fatalError(err);
            }
        }
        if (!data.sdp && !data.candidate) {
            this.fatalError(new Error('handshake received invalid data!'))
        }
    }

    /**
     * handle "in-band" negotiations via the internal metadata DataChannel.
     * @param message
     * @private
     */
    private async inBand(message: MessageEvent) {
        const {description} = JSON.parse(message.data);
        if (description) {
            // Check for 'glare', AKA an incoming offer while we're already waiting on a response:
            if (description.type == "offer" && this.pc.signalingState != "stable") {
                if (this.initiator) return;  // Host ignores this collision, knowing client will handle it.
                // NOTE: Intentional Promise.all: https://blog.mozilla.org/webrtc/perfect-negotiation-in-webrtc/
                await Promise.all([
                    this.pc.setLocalDescription({type: "rollback"}),
                    this.pc.setRemoteDescription(description)
                ]);
            } else {
                await this.pc.setRemoteDescription(description);
            }
            if (description.type == "offer") {
                await this.pc.setLocalDescription(await this.pc.createAnswer());
                this.sendMeta({description: this.pc.localDescription});
            }
        } else {
            this.fatalError(new Error(`Invalid data was sent over the meta channel: ${message.data}`));
        }
    }

    /**
     * Emits a fatal Error, then terminates the Peer.
     * @param err
     * @private
     */
    fatalError(err: Error) {
        if (this.isClosed) return null;
        this.emit('error', err);
        this.close();
        return null;
    }

    /**
     * Build a timer that is managed by this Peer, and cancelled when the Peer closes.
     * @param timeout
     * @param cb
     * @returns A callback to clear the timeout.
     * @private
     */
    private makeTimer(timeout: number, cb: Function) {
        let ret: any;
        const clear = () => {
            clearTimeout(ret);
            const idx = this.timers.indexOf((t: any) => t === ret);
            if (idx >= 0) this.timers.splice(idx, 1);
        }

        cb = cb.bind(this);

        ret = setTimeout(() => {
            cb();
            clear();
        }, timeout);

        this.timers.push(ret);
        return clear;
    }

    /**
     * Wait for trickle ICE to finish, up to a given timeout - starting after the first candidate is received.
     * if `trickleICE` is set, this does not wait.
     */
    private async waitForICE() {
        if (this.config.trickleICE) return null;
        return Promise.race([
            this.awaitICE,
            new Promise((res) => {
                this.makeTimer(this.config.trickleTimeout || 2000, res)
            })
        ]).then(() => {
            this.emit('iceFinished');
        });
    }

    /**
     * Builds a connection request.
     * The non-initiator should call `makeAccept` with this.
     */
    async makeOffer(): Promise<RTCSessionDescription | null> {
        return this.pc.createOffer(this.config.rtcOfferOpts)
            .then(offer => this.pc.setLocalDescription(offer))
            .then(() => this.waitForICE())
            .then(() => this.pc.localDescription)
            .catch(this.fatalError)
    }

    /**
     * Builds an answer in response to a connection request.
     * The initiator peer just needs to `setRemoteDescription` this value, and the connection will be ready.
     * @param incomingDescription
     */
    async makeAnswer(incomingDescription: RTCSessionDescription) {
        return this.pc.setRemoteDescription(incomingDescription)
            .then(() => this.pc.createAnswer(this.config.rtcAnswerOpts))
            .then(ans => this.pc.setLocalDescription(ans))
            .then(() => this.waitForICE())
            .then(() => this.pc.localDescription)
            .catch(this.fatalError)
    }

    /**
     * Internal. Registers event handlers for the channel, and adds it to the tracked list of channels.
     * @param ch
     * @private
     */
    private registerDataChannel(ch: RTCDataChannel) {
        const channelName = ch.label;
        this.dataChannels[channelName] = ch;
        ch.addEventListener('close', () => delete this.dataChannels[channelName]);
        if (channelName !== META_CHANNEL) {
            ch.addEventListener('open', () => this.emit('dataChannel', ch));
        } else {
            ch.addEventListener('open', () => this.emitReady());
            ch.addEventListener('close', () => this.fatalError(new Error('Core data channel died.')));
        }
        ch.addEventListener('error', err => this.fatalError(err.error));
        ch.addEventListener('open', () => {
            const pending = this.dataSendQueue[ch.label] || [];
            for (const d of pending) {
                ch.send(d);
            }
            delete this.dataSendQueue[ch.label];
        });
    }

    /**
     * Establish a new RTCDataChannel
     * @param channelName A shared, unique ID to use for this channel.
     * @param opts {@link https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel See createDataChannel opts}
     * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel RTCDataChannel}
     * @see {@link send}
     */
    addDataChannel(channelName: string, opts?: RTCDataChannelInit): RTCDataChannel {
        if (this.dataChannels[channelName]) {
            throw Error('Cannot create channel name that already exists: ' + channelName);
        }
        const ch = this.pc.createDataChannel(channelName, opts);
        ch.binaryType = "arraybuffer";

        this.registerDataChannel(ch);

        return ch;
    }

    /**
     * Remove the given data channel.
     * @param channelName
     */
    removeDataChannel(channelName: string) {
        const ch = this.dataChannels[channelName];
        if (!ch) return;
        delete this.dataChannels[channelName];
        ch.close();
    }

    /**
     * Add a MediaStream or multiple MediaStreamTracks to this established connection.
     *
     * This requires renegotiation, which is handled internally through a hidden DataChannel.
     * It does not require a middleman service.
     *
     * Resolves when the connection has stabilized after renegotiating the channels.
     * @param media Either an existing MediaStream, or an array of MediaStreamTracks.
     * @param existingStream If `media` is an array of tracks, optionally pass an existing MediaStream to add these tracks into.
     * @returns A MediaStream, which contains the given tracks.
     * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/MediaStream MediaStream}
     * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack MediaStreamTrack}
     */
    async addMedia(media: MediaStream | MediaStreamTrack[], existingStream?: MediaStream) {
        let stream = existingStream || (media instanceof MediaStream ? media : new MediaStream(media));
        let tracks = (media instanceof MediaStream ? media.getTracks() : media);

        for (const track of tracks) {
            this.pc.addTrack(track, stream);
        }

        return new Promise(res => {
            this.once('ready', res);
        }).then(() => stream);
    }

    /**
     * Send data to the connected Peer.
     * @param data The data to send.
     * @param channelName The channel name to use. Defaults to the "default" DataChannel created on startup.
     * @see {@link addDataChannel}
     */
    send(data: string|ArrayBuffer|Blob|ArrayBufferView, channelName: string = 'default') {
        try {
            if (this.dataChannels[channelName].readyState !== 'open') {
                this.dataSendQueue[channelName] = this.dataSendQueue[channelName] || [];
                this.dataSendQueue[channelName].push(data);
            } else {
                // @ts-ignore
                return this.dataChannels[channelName]?.send(data);
            }
        } catch (err) {
            this.fatalError(err);
        }
    }

    /**
     * Internal send method, for ease of use.
     * @param data
     * @private
     */
    private sendMeta(data: any) {
        this.send(JSON.stringify(data), META_CHANNEL);
    }

    emit(event: 'message'|'data'|'dataChannel'|'iceFinished'|'error'|'handshake'|'close'|'stream'|'ready'|'connect'|'iceEvent'|'disconnect', data?: any) {
        super.emit(event, data);
    }
}

export default Peer;

