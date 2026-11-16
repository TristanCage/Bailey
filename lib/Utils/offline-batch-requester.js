
export const OFFLINE_BATCH_SIZE = 200;

export const OFFLINE_BATCH_DEBOUNCE_MS = 100;

export const OFFLINE_BATCH_IDLE_TIMEOUT_MS = 60000;

export const OFFLINE_BATCH_MAX_RETRIES = 3;

export const makeOfflineBatchRequester = ({ sendNode, logger, batchSize = OFFLINE_BATCH_SIZE, debounceMs = OFFLINE_BATCH_DEBOUNCE_MS, idleTimeoutMs = OFFLINE_BATCH_IDLE_TIMEOUT_MS, maxRetries = OFFLINE_BATCH_MAX_RETRIES, onIdleTimeout }) => {
    let active = false;
    
    let requestInFlight = false;
    
    let requestWaiting = false;
    
    let lastRequestAt;
    let retries = 0;
    
    let resume = 0;
    
    let requestSeq = 0;
    let backlog = () => 0;
    let stanzaCheckTimer;
    let debounceTimer;
    let idleTimer;
    const clearTimers = () => {
        clearTimeout(stanzaCheckTimer);
        stanzaCheckTimer = undefined;
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
        clearTimeout(idleTimer);
        idleTimer = undefined;
    };
    const stop = () => {
        active = false;
        requestInFlight = false;
        requestWaiting = false;
        clearTimers();
    };
    
    const armIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimer = undefined;
            logger.warn({ idleTimeoutMs }, 'offline delivery went idle, no longer requesting offline batches');
            stop();
            onIdleTimeout?.();
        }, idleTimeoutMs);
    };
    
    const now = () => performance.now();
    const armDebounce = (delay = debounceMs) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            check();
        }, delay);
    };
    const request = async () => {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
        requestInFlight = true;
        requestWaiting = false;
        lastRequestAt = now();
        const requestResume = resume;
        const seq = ++requestSeq;
        logger.debug({ count: batchSize, backlog: backlog() }, 'requesting offline batch');
        try {
            await sendNode({
                tag: 'ib',
                attrs: {},
                content: [{ tag: 'offline_batch', attrs: { count: batchSize.toString() } }]
            });
            if (requestResume === resume) {
                retries = 0;
            }
        }
        catch (error) {
            if (requestResume !== resume || !active || seq !== requestSeq) {
                return;
            }
            retries += 1;
            if (retries > maxRetries) {
                
                logger.warn({ error, retries }, 'offline batch request kept failing, giving up');
                return;
            }
            
            requestInFlight = false;
            logger.debug({ error, retries }, 'offline batch request failed, retrying');
            requestWaiting = true;
            armDebounce();
        }
    };
    
    const check = () => {
        if (!active) {
            return;
        }
        
        const backlogFits = backlog() <= batchSize;
        
        const due = requestWaiting &&
            !requestInFlight &&
            backlogFits &&
            lastRequestAt !== undefined &&
            now() - lastRequestAt >= debounceMs;
        if (((requestInFlight || requestWaiting) && !due) || !backlogFits) {
            
            
            if (requestWaiting && !requestInFlight && backlogFits && !debounceTimer && lastRequestAt !== undefined) {
                armDebounce(Math.max(1, Math.ceil(debounceMs - (now() - lastRequestAt))));
            }
            return;
        }
        requestWaiting = true;
        
        if (due || lastRequestAt === undefined) {
            void request();
        }
        else {
            armDebounce();
        }
    };
    return {
        
        start() {
            clearTimers();
            resume += 1;
            active = true;
            requestInFlight = false;
            requestWaiting = false;
            lastRequestAt = undefined;
            retries = 0;
            armIdleTimer();
        },
        
        onOfflineStanza() {
            if (!active) {
                return;
            }
            requestInFlight = false;
            armIdleTimer();
            
            if (!stanzaCheckTimer) {
                stanzaCheckTimer = setTimeout(() => {
                    stanzaCheckTimer = undefined;
                    check();
                }, 0);
            }
        },
        
        onBacklogProcessed() {
            if (!active) {
                return;
            }
            armIdleTimer();
            check();
        },
        
        setBacklogCounter(counter) {
            backlog = counter;
        },
        
        stop,
        isActive: () => active
    };
};
