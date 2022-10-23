/** @internal */
export const SHORT_ID_LENGTH = 20;

/** @internal */
export type ClientIntroPacket = {
    id: string;
    pubKey: number[];
    signature: number[];
    hosting: boolean;
    swarmChannel: string | null;
    hostTarget: string | null;
    passCode: string | null;
}

/** @internal */
export enum WsMessageType {
    MSG = 'MSG',
    JOIN = 'JOIN'
}

/** @internal */
export type WsServerMessage = MsgClientDirect | MsgChannelJoin;

/** @internal */
export type MsgChannelJoin = {
    type: WsMessageType.JOIN,
    data: {
        id: string;
    }
}

/** @internal */
export type MsgClientDirect = {
    type: WsMessageType.MSG,
    from: string;
    targetClient?: string;
    data: string;
}

/** @internal */
export const SPS_VERSION = 1.0;
