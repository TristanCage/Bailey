import type { ILogger } from './logger.js';
export type WorkerTask = {
    type: 'decrypt-media';
    data: {
        buffer: Uint8Array | Buffer;
        cipherKey: Uint8Array | Buffer;
        iv: Uint8Array | Buffer;
        macKey?: Uint8Array | Buffer;
    };
} | {
    type: 'process-image';
    data: {
        buffer: Uint8Array | Buffer;
        width: number;
        height: number;
        quality?: number;
    };
} | {
    type: 'decode-proto';
    data: Uint8Array | Buffer;
    isPinned: boolean;
} | {
    type: 'encrypt-media';
    data: {
        buffer: Uint8Array | Buffer;
        cipherKey: Uint8Array | Buffer;
        iv: Uint8Array | Buffer;
        macKey: Uint8Array | Buffer;
    };
} | {
    type: 'inflate-data';
    data: Uint8Array | Buffer;
};
export declare const makeWorkerPool: (workerPath: string, size: number, logger?: ILogger) => {
    execute<T>(task: WorkerTask, transferList?: any[]): Promise<T>;
    destroy(): void;
};
export type WorkerPool = ReturnType<typeof makeWorkerPool>;
//# sourceMappingURL=worker-pool.d.ts.map