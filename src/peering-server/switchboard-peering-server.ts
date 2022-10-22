import WebSocket, {Server} from "ws";
import nacl from "tweetnacl";
import sha1 from "sha1";
import {ClientIntroPacket, MsgClientDirect, SHORT_ID_LENGTH, WsMessageType, WsServerMessage} from "../shared";
import Timeout = NodeJS.Timeout;

/**
 * @internal
 * @hidden
 */
type SocketInfo = {
    ws: WebSocket;
    isAlive: boolean;
    shortId: string | null;
    id: string | null;
    channel: string | null;
    hosting: boolean;
}

/**
 * @internal
 * @hidden
 */
type ChannelInfo = {
    count: number;
    ids: Map<string, true>;
}


let PASS_CODE: string | null = null;
const clients = new Map<string, SocketInfo>();
const channels: Record<string, ChannelInfo> = {};


async function validate(ws: WebSocket, sockInfo: SocketInfo) {
    const introPacket: ClientIntroPacket = await readWait(ws, 15000);

    if (PASS_CODE && introPacket.passCode !== PASS_CODE) {
        throw new Error('Passcode mismatch.');
    }

    const pubBytes = new Uint8Array(introPacket.pubKey);
    const sigBytes = new Uint8Array(introPacket.signature);
    const match = nacl.sign.detached.verify(pubBytes, sigBytes, pubBytes);
    const longId = sha1(Buffer.from(introPacket.pubKey));

    if (!match) {
        throw new Error('Failed to validate signature for given client public key!');
    }

    if (introPacket.id !== longId) {
        throw new Error(`The given ID from the client does not match the hash value! (${introPacket.id} != ${longId})`)
    }

    sockInfo.id = longId;
    sockInfo.shortId = longId.substr(0, SHORT_ID_LENGTH);
    sockInfo.channel = introPacket.swarmChannel ? `#${introPacket.swarmChannel}` : null;  // Prepend to channelID, so that "host-[HostID]" can function as guaranteed special channels.
    sockInfo.hosting = introPacket.hosting;

    clients.set(sockInfo.id, sockInfo);
    clients.set(sockInfo.shortId, sockInfo);

    if (sockInfo.channel && !introPacket.hostTarget) {
        sendChannel(sockInfo.channel, {type: WsMessageType.JOIN, data: {id: sockInfo.id}});
    }

    if (introPacket.hostTarget) {
        sockInfo.channel = 'host-' + introPacket.hostTarget;
        const host = clients.get(introPacket.hostTarget);
        if (host && host.hosting && host.id) {
            sendClient(sockInfo.id, {type: WsMessageType.JOIN, data: {id: host.id}});
        }
    }

    if (sockInfo.channel) addChannelListener(sockInfo.channel, sockInfo.id);

    if (introPacket.hosting) {
        sendChannel( 'host-' + sockInfo.shortId, {type: WsMessageType.JOIN, data: {id: sockInfo.shortId}})
        sendChannel( 'host-' + sockInfo.id, {type: WsMessageType.JOIN, data: {id: sockInfo.id}})
    }
}

function onClientMessage(ws: WebSocket, message: string, sockId: string) {
    console.debug(`Message:`, `[${sockId}]`, message.substr(0,  50) + '...');
    try {
        // All messages here should be handshake stages, targeted at a specific User ID.
        const packet: MsgClientDirect = JSON.parse(message);
        if (packet.targetClient) {
            sendClient(packet.targetClient, {
                type: WsMessageType.MSG,
                from: sockId,
                data: packet.data
            });
        }
    } catch (err) {
        console.error(err);
        ws.terminate();
    }
}

function channel(id: string) {
    return channels[id] = channels[id] || {
        ids: new Map<string, true>(),
        count: 0
    };
}

function addChannelListener(channelId: string, clientId: string) {
    const ch = channel(channelId);
    ch.ids.set(clientId, true);
    ch.count++;
}

function removeChannelListener(channelId: string, clientId: string) {
    const ch = channel(channelId);
    ch.ids.delete(clientId);

    if (--ch.count <= 0) {
        delete channels[channelId];
    }
}

function readWait(ws: WebSocket, timeout = 0): Promise<any> {
    return new Promise((res, rej) => {
        let to: Timeout|null = null;
        if (timeout) {
            to = setTimeout(() => {
                console.warn("Read timed out for client.");
                ws.close();
            }, timeout)
        }
        function onMsg(data: any) {
            if (timeout && to) clearTimeout(to);
            ws.off('message', onMsg);
            ws.off('close', rej);
            res(JSON.parse(data.toString()));
        }
        ws.on('close', rej);
        ws.on('message', onMsg);
    })
}

function sendClient(id: string, data: WsServerMessage) {
    const c = clients.get(id);
    return c && c.ws.send(JSON.stringify(data));
}

function sendChannel(channel: string, data: WsServerMessage) {
    channels[channel]?.ids.forEach((_, id) => {
        sendClient(id, data)
    });
}

export function startServer(password: string | null | undefined, port: number, pingWithText: boolean = true, pingFreq = 30000) {
    PASS_CODE = password || null;

    const wss = new Server({ port });

    wss.on('connection', function connection(ws: WebSocket) {
        const sockInfo: SocketInfo = {
            ws,
            isAlive: true,
            shortId: null,
            id: null,
            channel: null,
            hosting: false,
        }

        ws.on('close', () => {
            console.debug("Disconnected:", sockInfo.id);
            if (sockInfo.id) {
                clients.delete(sockInfo.id);
                if (sockInfo.channel) removeChannelListener(sockInfo.channel, sockInfo.id);
            }
            if (sockInfo.shortId) {
                clients.delete(sockInfo.shortId);
            }
        });

        ws.on('pong', () => {
            sockInfo.isAlive = true;
        });

        // @ts-ignore
        console.debug(`Connected:`, sockInfo.ws._socket?.remoteAddress);

        validate(ws, sockInfo).then(() => {
            console.debug(`Validated:`, sockInfo.id);

            ws.on('message', data => {
                const str = data.toString();
                sockInfo.isAlive = true;
                if (str === 'pong') return;
                if (sockInfo.id) onClientMessage(ws, str, sockInfo.id)
            });

        }).catch(err => {
            console.error('Validation Error:', err.message);
            try {
                ws.send('dc');
            } catch (_ignored){}
            ws.terminate();
        })
    });

    let interval = setInterval(function ping() {
        clients.forEach(function each(client, key) {
            if (key === client.shortId) return;
            if (!client.isAlive) {
                console.debug("Socket missed ping:", client.id);
                return client.ws.terminate();
            }
            client.isAlive = false;
            pingWithText ? client.ws.send('ping') : client.ws.ping();
        });
    }, pingFreq);

    wss.on('close', function close() {
        clearInterval(interval);
        console.log("WebSocket server closed.");
    });

    console.log("WebSocket server started.", wss.address());

    return wss;
}

if (require.main === module) {
    startServer(process.env.SWITCHBOARD_PASSCODE, 8080);
}
