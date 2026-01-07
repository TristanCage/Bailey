import { parentPort } from 'worker_threads';
import { proto } from '../../WAProto/index.js';
import { createCipheriv, createDecipheriv, createHmac } from 'crypto';
import { inflate } from 'zlib';
import { promisify } from 'util';
const inflatePromise = promisify(inflate);
const sendLog = (level, msg, data) => {
    parentPort?.postMessage({ type: 'log', level, msg, ...data });
};
let imageLib;
const getImageLib = async () => {
    if (!imageLib) {
        sendLog('debug', 'loading image libraries');
        const [sharp, jimp] = await Promise.all([
            import('sharp').catch(() => { }),
            import('jimp').catch(() => { })
        ]);
        imageLib = { sharp, jimp };
    }
    return imageLib;
};
// New implementation of unpadRandomMax16
function unpadRandomMax16(data) {
    if (data.length === 0) {
        throw new Error('unpadRandomMax16 given empty bytes');
    }
    const r = data[data.length - 1];
    if (r > data.length) {
        throw new Error(`unpad given ${data.length} bytes, but pad is ${r}`);
    }
    return data.slice(0, data.length - r);
}
parentPort?.on('message', async (task) => {
    const start = Date.now();
    try {
        let result;
        sendLog('debug', `processing task ${task.type}`);
        switch (task.type) {
            case 'decode-proto': {
                const { data, isPinned } = task;
                const decoded = proto.Message.decode(isPinned ? unpadRandomMax16(data) : data);
                result = proto.Message.toObject(decoded, {
                    enums: String,
                    longs: String,
                    bytes: Buffer,
                    defaults: true,
                    arrays: true,
                    objects: true,
                    oneofs: true
                });
                break;
            }
            case 'decrypt-media': {
                const { buffer: data, cipherKey, iv, macKey } = task.data;
                if (macKey && data.length > 10) {
                    const ciphertext = data.slice(0, -10);
                    const mac = data.slice(-10);
                    const hmac = createHmac('sha256', macKey);
                    hmac.update(iv);
                    hmac.update(ciphertext);
                    const calculatedMac = hmac.digest().slice(0, 10);
                    if (!calculatedMac.equals(mac)) {
                        throw new Error('MAC verification failed');
                    }
                    const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
                    let decrypted = decipher.update(ciphertext);
                    decrypted = Buffer.concat([decrypted, decipher.final()]);
                    result = decrypted;
                }
                else {
                    // Fallback for cases without MAC or extremely short buffers
                    const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
                    let decrypted = decipher.update(data);
                    decrypted = Buffer.concat([decrypted, decipher.final()]);
                    result = decrypted;
                }
                break;
            }
            case 'encrypt-media': {
                const { buffer: data, cipherKey, iv, macKey } = task.data;
                const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
                let encrypted = cipher.update(data);
                encrypted = Buffer.concat([encrypted, cipher.final()]);
                const hmac = createHmac('sha256', macKey);
                hmac.update(iv);
                hmac.update(encrypted);
                const mac = hmac.digest().slice(0, 10);
                result = Buffer.concat([encrypted, mac]);
                break;
            }
            case 'inflate-data': {
                const { data } = task;
                const inflated = await inflatePromise(data);
                result = inflated;
                break;
            }
            case 'process-image': {
                const { buffer: imgBuffer, width, height, quality } = task.data;
                const { sharp: sLib, jimp: jLib } = await getImageLib();
                if (sLib && typeof sLib.default === 'function') {
                    result = await sLib.default(imgBuffer)
                        .resize(width, height)
                        .jpeg({ quality: quality || 50 })
                        .toBuffer();
                }
                else if (jLib && (typeof jLib.Jimp === 'function' || typeof jLib.default?.Jimp === 'function')) {
                    const jimp = jLib.Jimp || jLib.default.Jimp;
                    const image = await jimp.read(imgBuffer);
                    result = await image
                        .resize({ w: width, h: height })
                        .getBuffer('image/jpeg', { quality: quality || 50 });
                }
                else {
                    throw new Error('No image processing library available in worker');
                }
                break;
            }
            default:
                throw new Error(`Unknown task type: ${task.type}`);
        }
        sendLog('debug', `completed task ${task.type}`, { durationMs: Date.now() - start });
        // Use transferList if result is a buffer for better performance
        if (result && (result instanceof Buffer || result instanceof Uint8Array || result.buffer instanceof ArrayBuffer)) {
            const buffer = result.buffer || result;
            parentPort?.postMessage({ result }, [buffer]);
        }
        else {
            parentPort?.postMessage({ result });
        }
    }
    catch (error) {
        sendLog('error', `error in task ${task.type}`, { error: error.stack || error.message });
        parentPort?.postMessage({ error: error.stack || error.message });
    }
});
//# sourceMappingURL=worker.js.map