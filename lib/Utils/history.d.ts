import { proto } from '../../WAProto/index.js';
import type { Chat, Contact, LIDMapping, WAMessage } from '../Types/index.js';
import type { ILogger } from './logger.js';
export declare const downloadHistory: (msg: proto.Message.IHistorySyncNotification, options: RequestInit) => Promise<proto.HistorySync>;
export declare const processHistoryMessage: (item: proto.IHistorySync, logger?: ILogger) => {
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    lidPnMappings: LIDMapping[];
    tcTokens: {
        jid: string;
        token: Uint8Array;
        timestamp: number;
        senderTimestamp: number;
    }[];
    nctSalt: Uint8Array<ArrayBufferLike> | undefined;
    companionMetaNonce: string | undefined;
    pastParticipants: proto.IPastParticipants[] | null | undefined;
    syncType: proto.HistorySync.HistorySyncType | null | undefined;
    progress: number | null | undefined;
};
export declare const downloadAndProcessHistorySyncNotification: (msg: proto.Message.IHistorySyncNotification, options: RequestInit, logger?: ILogger) => Promise<{
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    lidPnMappings: LIDMapping[];
    tcTokens: {
        jid: string;
        token: Uint8Array;
        timestamp: number;
        senderTimestamp: number;
    }[];
    nctSalt: Uint8Array<ArrayBufferLike> | undefined;
    companionMetaNonce: string | undefined;
    pastParticipants: proto.IPastParticipants[] | null | undefined;
    syncType: proto.HistorySync.HistorySyncType | null | undefined;
    progress: number | null | undefined;
}>;
export declare const getHistoryMsg: (message: proto.IMessage) => proto.Message.IHistorySyncNotification;
/**
 * A downloaded (non-inline) history chunk leaves a blob on the media server that WA Web
 * (WAWebHandleHistorySyncChunk) and whatsmeow (6723e556) delete once the chunk is processed.
 */
export declare const shouldDeleteHistorySyncBlob: (notification: proto.Message.IHistorySyncNotification) => boolean;
//# sourceMappingURL=history.d.ts.map