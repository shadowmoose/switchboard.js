import WebSocket, {Server} from "ws";
import nacl from "tweetnacl";
import sha1 from "sha1";
import {
    ClientIntroPacket,
    MsgClientDirect,
    SHORT_ID_LENGTH,
    SPS_VERSION,
    WsMessageType,
    WsServerMessage
} from "./shared";
import Timeout = NodeJS.Timeout;
import {getLogger, setLogging} from "./logger";
const convict = require('convict');

export {setLogging} from './logger';
const debug = getLogger('server');

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


const clients = new Map<string, SocketInfo>();
const channels: Record<string, ChannelInfo> = {};


async function validate(ws: WebSocket, sockInfo: SocketInfo, passCode: string | null) {
    const introPacket: ClientIntroPacket = await readWait(ws, 15000);

    if (passCode && introPacket.passCode !== passCode) {
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
    debug(`Message:`, `[${sockId}]`, message.substr(0,  50) + '...');
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
        debug(err);
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
                debug("Read timed out for client.");
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

/** @internal */
type WsServerOpts = {
    passCode: string | null;
    port: number;
    host: string;
    pingWithText: boolean;
    pingFrequency: number;
    statPrintFrequency: number;
}

export function startServer(opts: WsServerOpts) {
    const {passCode, port, host, pingWithText, pingFrequency, statPrintFrequency} = opts;
    const wss = new Server({ port, host });

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
            debug("Disconnected:", sockInfo.id);
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
        debug(`Connected:`, sockInfo.ws._socket?.remoteAddress);

        validate(ws, sockInfo, passCode).then(() => {
            debug(`Validated:`, sockInfo.id);

            ws.on('message', data => {
                const str = data.toString();
                sockInfo.isAlive = true;
                if (str === 'pong') return;
                if (sockInfo.id) onClientMessage(ws, str, sockInfo.id)
            });

        }).catch(err => {
            debug('Validation Error:', err.message);
            try {
                ws.send('dc');
            } catch (_ignored){}
            ws.terminate();
        })
    });

    const pingInterval = setInterval(function ping() {
        clients.forEach(function each(client, key) {
            if (key === client.shortId) return;
            if (!client.isAlive) {
                debug("Socket missed ping:", client.id);
                return client.ws.terminate();
            }
            client.isAlive = false;
            pingWithText ? client.ws.send('ping') : client.ws.ping();
        });
    }, pingFrequency * 1000);

    const statPrint = statPrintFrequency ? setInterval(() => {
        const mem = process.memoryUsage();
        const formatMemoryUsage = (data: number) => `${Math.round(data / 1024 / 1024 * 100) / 100} MB`;
        debug('(STATS)', `channels: ${Object.keys(channels).length.toLocaleString()}`, '|', 'clients:', (clients.size/2).toLocaleString(), '|', 'memory used:', formatMemoryUsage(mem.heapUsed));
    }, statPrintFrequency * 1000) : null;

    wss.on('close', function close() {
        clearInterval(pingInterval);
        if (statPrint) clearInterval(statPrint);
        debug("WebSocket server closed.");
    });

    return wss;
}



if (require.main === module) {
    const argConfig = {
        host: {
            doc: 'The host address to bind.',
            format: 'String',
            default: 'localhost',
            env: 'SPS_HOST',
            arg: 'host'
        },
        port: {
            doc: 'The port to bind.',
            format: 'port',
            default: 8080,
            env: 'SPS_PORT',
            arg: 'port'
        },
        pass: {
            doc: 'The passcode to use for this server.',
            format: 'String',
            default: '',
            env: 'SPS_PASS',
            arg: 'pass'
        },
        quiet: {
            doc: 'Silence the logging when running standalone.',
            format: 'Boolean',
            default: false,
            env: 'SPS_QUIET',
            arg: 'quiet'
        },
        statPrintFreq: {
            doc: 'How frequently, in seconds, to print server stats. Use 0 to disable.',
            format: 'Number',
            default: 60,
            env: 'SPS_STAT_FREQ',
            arg: 'stats'
        },
        pingWithText: {
            doc: 'If true, sends pings using actual WebSocket messages.',
            format: 'Boolean',
            default: true,
            env: 'SPS_PING_TEXT',
            arg: 'ping_text'
        },
        pingFreq: {
            doc: 'How frequently, in seconds, to ping connected clients.',
            format: 'Number',
            default: 60,
            env: 'SPS_PING_FREQ',
            arg: 'ping'
        },
    };
    const config = convict(argConfig);
    config.validate({allowed: 'strict'});

    console.log(`\t[ Switchboard Peering Server - v${SPS_VERSION} ]`)

    if (process.argv.includes('-h') || process.argv.includes('--help')) {
        console.log("Supported Arguments/Environment variables:");

        let eg = 'ts-node --transpile-only src/peering-server.ts ';

        Object.entries(argConfig).forEach(ent => {
            const v = ent[1];
            console.log(`\t--${v.arg} [${v.format}]`, `(env:${v.env})`, v.doc, `Default "${v.default}"`);
            eg += `--${v.arg} "${v.default}" `
        });
        console.log("EG:", eg.trim());
        process.exit(0);
    }

    setLogging(!config.get('quiet'), console.log);
    startServer({
        host: config.get('host'),
        port: config.get('port'),
        passCode: config.get('pass'),
        pingFrequency: config.get('pingFreq'),
        pingWithText: config.get('pingWithText'),
        statPrintFrequency: config.get('statPrintFreq')
    });

    console.log("WebSocket server started.", `ws://${config.get('host')}:${config.get('port')}`);
}
