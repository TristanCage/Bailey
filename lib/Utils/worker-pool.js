import { Worker } from 'worker_threads';
export const makeWorkerPool = (workerPath, size, logger) => {
    const workers = [];
    const queue = [];
    let activeWorkers = 0;
    logger?.debug({ workerPath }, 'Initializing worker pool');
    const spawnWorker = () => {
        try {
            const worker = new Worker(workerPath);
            worker.on('message', (msg) => {
                if (msg.type === 'log') {
                    const { level, msg: logMsg, ...data } = msg;
                    const logFn = logger?.[level] || logger?.debug;
                    logFn?.({ ...data, workerId: workers.indexOf(worker) }, logMsg);
                    return;
                }
                const currentTask = worker.currentTask;
                if (currentTask) {
                    currentTask.resolve(msg.result);
                    worker.currentTask = null;
                    activeWorkers--;
                    processNext();
                }
            });
            worker.on('error', (err) => {
                logger?.error({ err, workerId: workers.indexOf(worker) }, 'Worker error event');
                const currentTask = worker.currentTask;
                if (currentTask) {
                    currentTask.reject(err);
                }
                activeWorkers--;
                const idx = workers.indexOf(worker);
                if (idx !== -1)
                    workers.splice(idx, 1);
                spawnWorker();
                processNext();
            });
            workers.push(worker);
        }
        catch (err) {
            logger?.error({ err, workerPath }, 'Failed to spawn worker');
        }
    };
    const processNext = () => {
        if (queue.length === 0 || activeWorkers >= size)
            return;
        const taskEntry = queue.shift();
        const worker = workers.find(w => !w.currentTask);
        if (worker) {
            activeWorkers++;
            worker.currentTask = taskEntry;
            worker.postMessage(taskEntry.task, taskEntry.transferList);
        }
    };
    for (let i = 0; i < size; i++) {
        spawnWorker();
    }
    const poolInstance = {
        async execute(task, transferList) {
            return new Promise((resolve, reject) => {
                queue.push({ task, transferList, resolve, reject });
                processNext();
            });
        },
        destroy() {
            workers.forEach(w => w.terminate());
        }
    };
    return poolInstance;
};
//# sourceMappingURL=worker-pool.js.map