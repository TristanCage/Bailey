
export function makeOfflineNodeProcessor(nodeProcessorMap, deps, batchSize = 10) {
    const nodes = [];
    let isProcessing = false;
    const enqueue = (type, node) => {
        nodes.push({ type, node });
        if (isProcessing) {
            return;
        }
        isProcessing = true;
        const promise = async () => {
            try {
                let processedInBatch = 0;
                while (nodes.length && deps.isWsOpen()) {
                    const { type, node } = nodes.shift();
                    const nodeProcessor = nodeProcessorMap.get(type);
                    if (!nodeProcessor) {
                        deps.onUnexpectedError(new Error(`unknown offline node type: ${type}`), 'processing offline node');
                        continue;
                    }
                    // Wrap each call so one failed node doesn't kill the queue.
                    await nodeProcessor(node).catch(err => {
                        const e = err instanceof Error ? err : new Error(String(err));
                        deps.onUnexpectedError(e, `processing offline ${type}`);
                    });
                    processedInBatch++;
                    deps.onNodeProcessed?.();
                    // Yield to event loop after processing a batch
                    // This prevents blocking the event loop for too long when there are many offline nodes
                    if (processedInBatch >= batchSize) {
                        processedInBatch = 0;
                        await deps.yieldToEventLoop();
                    }
                }
            }
            finally {
                // ALWAYS reset isProcessing even on unexpected throw, otherwise the queue
                // would never drain again on the next enqueue.
                isProcessing = false;
            }
        };
        promise().catch(error => deps.onUnexpectedError(error, 'processing offline nodes'));
    };
    return {
        enqueue,
        
        pending: () => nodes.length
    };
}
//# sourceMappingURL=offline-node-processor.js.map