import EventEmitter from 'events';
const BUFFERABLE_EVENT = [
    'messaging-history.set',
    'chats.upsert',
    'chats.update',
    'chats.delete',
    'contacts.upsert',
    'contacts.update',
    'messages.upsert',
    'messages.update',
    'messages.delete',
    'messages.reaction',
    'message-receipt.update',
    'groups.update'
];
const BUFFERABLE_EVENT_SET = new Set(BUFFERABLE_EVENT);
/**
 * The event buffer logically consolidates different events into a single event
 * making the data processing more efficient.
 */
export const makeEventBuffer = (logger) => {
    const ev = new EventEmitter();
    let data = makeBufferData();
    let isBuffering = false;
    let bufferTimeout = null;
    let bufferCount = 0;
    const BUFFER_TIMEOUT_MS = 30000;
    ev.on('event', (map) => {
        for (const event in map) {
            ev.emit(event, map[event]);
        }
    });
    function buffer() {
        if (!isBuffering) {
            logger.debug('Event buffer activated');
            isBuffering = true;
            bufferCount++;
            if (bufferTimeout) {
                clearTimeout(bufferTimeout);
            }
            bufferTimeout = setTimeout(() => {
                if (isBuffering) {
                    logger.warn('Buffer timeout reached, auto-flushing');
                    flush();
                }
            }, BUFFER_TIMEOUT_MS);
        }
        else {
            bufferCount++;
        }
    }
    function flush() {
        if (!isBuffering) {
            return false;
        }
        logger.debug({ bufferCount }, 'Flushing event buffer');
        isBuffering = false;
        bufferCount = 0;
        if (bufferTimeout) {
            clearTimeout(bufferTimeout);
            bufferTimeout = null;
        }
        if (Object.keys(data).length) {
            ev.emit('event', data);
        }
        data = makeBufferData();
        return true;
    }
    return {
        process(handler) {
            const listener = async (map) => {
                await handler(map);
            };
            ev.on('event', listener);
            return () => {
                ev.off('event', listener);
            };
        },
        emit(event, evData) {
            if (isBuffering && BUFFERABLE_EVENT_SET.has(event)) {
                append(data, event, evData);
                return true;
            }
            return ev.emit('event', { [event]: evData });
        },
        isBuffering() {
            return isBuffering;
        },
        buffer,
        flush,
        createBufferedFunction(work) {
            return async (...args) => {
                buffer();
                try {
                    const result = await work(...args);
                    if (bufferCount === 1) {
                        setTimeout(() => {
                            if (isBuffering && bufferCount === 1) {
                                flush();
                            }
                        }, 100);
                    }
                    return result;
                }
                finally {
                    bufferCount = Math.max(0, bufferCount - 1);
                    if (bufferCount === 0) {
                        setTimeout(flush, 100);
                    }
                }
            };
        },
        on: (...args) => ev.on(...args),
        off: (...args) => ev.off(...args),
        removeAllListeners: (...args) => ev.removeAllListeners(...args)
    };
};
const makeBufferData = () => ({});
function append(data, event, eventData) {
    if (event === 'messages.upsert') {
        const typedData = eventData;
        if (!data['messages.upsert']) {
            data['messages.upsert'] = { messages: [], type: typedData.type };
        }
        data['messages.upsert'].messages.push(...typedData.messages);
    }
    else if (event === 'messaging-history.set') {
        if (!data['messaging-history.set']) {
            data['messaging-history.set'] = eventData;
        }
        else {
            const existing = data['messaging-history.set'];
            existing.messages.push(...eventData.messages);
            existing.chats.push(...eventData.chats);
            existing.contacts.push(...eventData.contacts);
        }
    }
    else if (Array.isArray(eventData)) {
        if (!data[event]) {
            data[event] = [];
        }
        data[event].push(...eventData);
    }
    else {
        data[event] = eventData;
    }
}
//# sourceMappingURL=event-buffer.js.map