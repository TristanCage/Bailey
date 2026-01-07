import { proto } from '../../WAProto/index.js';
import type { Chat, Contact, WAMessage } from '../Types/index.js';
import type { WorkerPool } from './worker-pool.js';
export declare const downloadHistory: (msg: proto.Message.IHistorySyncNotification, options: RequestInit, workerPool?: WorkerPool) => Promise<proto.HistorySync>;
export declare const processHistoryMessage: (item: proto.IHistorySync) => {
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    syncType: proto.HistorySync.HistorySyncType | null | undefined;
    progress: number | null | undefined;
};
export declare const downloadAndProcessHistorySyncNotification: (msg: proto.Message.IHistorySyncNotification, options: RequestInit, workerPool?: WorkerPool) => Promise<{
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    syncType: proto.HistorySync.HistorySyncType | null | undefined;
    progress: number | null | undefined;
}>;
export declare const getHistoryMsg: (message: proto.IMessage) => proto.Message.IHistorySyncNotification;
//# sourceMappingURL=history.d.ts.map