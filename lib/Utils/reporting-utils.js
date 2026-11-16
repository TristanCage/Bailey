import { createHmac } from 'crypto';
import { proto } from '../../WAProto/index.js';
import { isJidInterop, jidNormalizedUser } from '../WABinary/index.js';
import { hkdf } from './crypto.js';
import { normalizeMessageContent } from './messages.js';

const reportingFields = [
    { f: 1 },
    {
        f: 3,
        s: [{ f: 2 }, { f: 3 }, { f: 8 }, { f: 11 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 25 }]
    },
    { f: 4, s: [{ f: 1 }, { f: 16 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
    { f: 5, s: [{ f: 3 }, { f: 4 }, { f: 5 }, { f: 16 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
    { f: 6, s: [{ f: 1 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 30 }] },
    { f: 7, s: [{ f: 2 }, { f: 7 }, { f: 10 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 20 }] },
    { f: 8, s: [{ f: 2 }, { f: 7 }, { f: 9 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 21 }] },
    { f: 9, s: [{ f: 2 }, { f: 6 }, { f: 7 }, { f: 13 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 20 }] },
    { f: 12, s: [{ f: 1 }, { f: 2 }, { f: 14, m: true }, { f: 15 }] },
    { f: 18, s: [{ f: 6 }, { f: 16 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
    {
        f: 26,
        s: [
            { f: 4 },
            { f: 5 },
            { f: 8 },
            { f: 13 },
            { f: 17, s: [{ f: 21 }, { f: 22 }] },
            { f: 26, s: [{ f: 2 }, { f: 7 }, { f: 9 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 21 }] }
        ]
    },
    { f: 28, s: [{ f: 1 }, { f: 2 }, { f: 4 }, { f: 5 }, { f: 6 }, { f: 7, s: [{ f: 21 }, { f: 22 }] }] },
    { f: 37, s: [{ f: 1, m: true }] },
    {
        f: 49,
        s: [
            { f: 2 },
            { f: 3, s: [{ f: 1 }, { f: 2 }] },
            { f: 5, s: [{ f: 21 }, { f: 22 }] },
            { f: 8, s: [{ f: 1 }, { f: 2 }] }
        ]
    },
    { f: 53, s: [{ f: 1, m: true }] },
    { f: 55, s: [{ f: 1, m: true }] },
    { f: 58, s: [{ f: 1, m: true }] },
    { f: 59, s: [{ f: 1, m: true }] },
    {
        f: 60,
        s: [
            { f: 2 },
            { f: 3, s: [{ f: 1 }, { f: 2 }] },
            { f: 5, s: [{ f: 21 }, { f: 22 }] },
            { f: 8, s: [{ f: 1 }, { f: 2 }] }
        ]
    },
    {
        f: 64,
        s: [
            { f: 2 },
            { f: 3, s: [{ f: 1 }, { f: 2 }] },
            { f: 5, s: [{ f: 21 }, { f: 22 }] },
            { f: 8, s: [{ f: 1 }, { f: 2 }] }
        ]
    },
    { f: 66, s: [{ f: 2 }, { f: 6 }, { f: 7 }, { f: 13 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 20 }] },
    { f: 74, s: [{ f: 1, m: true }] },
    { f: 87, s: [{ f: 1, m: true }] },
    { f: 88, s: [{ f: 1 }, { f: 2, s: [{ f: 1 }] }, { f: 3, s: [{ f: 21 }, { f: 22 }] }] },
    { f: 92, s: [{ f: 1, m: true }] },
    { f: 93, s: [{ f: 1, m: true }] },
    { f: 103, s: [{ f: 1, m: true }] },
    {
        f: 111,
        s: [
            { f: 2 },
            { f: 3, s: [{ f: 1 }, { f: 2 }] },
            { f: 5, s: [{ f: 21 }, { f: 22 }] },
            { f: 8, s: [{ f: 1 }, { f: 2 }] }
        ]
    },
    { f: 115, s: [{ f: 1 }, { f: 2, s: [{ f: 1 }] }, { f: 3, s: [{ f: 21 }, { f: 22 }] }] },
    {
        f: 119,
        s: [
            { f: 2 },
            { f: 3, s: [{ f: 1 }, { f: 2 }] },
            { f: 5, s: [{ f: 21 }, { f: 22 }] },
            { f: 8, s: [{ f: 1 }, { f: 2 }] }
        ]
    },
    { f: 121, s: [{ f: 2, s: [{ f: 1 }, { f: 2 }] }] },
    { f: 122 },
    { f: 129, s: [{ f: 5, s: [{ f: 21 }, { f: 22 }] }] },
    { f: 134, s: [{ f: 1, m: true }] }
];
const compileReportingFields = (fields) => {
    const map = new Map();
    for (const f of fields) {
        map.set(f.f, {
            m: f.m,
            children: f.s ? compileReportingFields(f.s) : undefined
        });
    }
    return map;
};
const compiledReportingFields = compileReportingFields(reportingFields);
const ENC_SECRET_REPORT_TOKEN = 'Report Token';

const REPORTING_TOKEN_VERSION = '2';
const WIRE = {
    VARINT: 0,
    FIXED64: 1,
    BYTES: 2,
    FIXED32: 5
};
const { REVOKE, MESSAGE_EDIT, MESSAGE_UNSCHEDULE } = proto.Message.ProtocolMessage.Type;
const { SecretEncType } = proto.Message.SecretEncryptedMessage;

const ENCRYPTED_ADDON_TYPES = [
    SecretEncType.MESSAGE_EDIT,
    SecretEncType.EVENT_EDIT,
    SecretEncType.POLL_EDIT,
    SecretEncType.POLL_ADD_OPTION
];

export const shouldIncludeReportingToken = (message) => {
    const content = normalizeMessageContent(message) ?? message;
    if (content.reactionMessage ||
        content.encReactionMessage ||
        content.encEventResponseMessage ||
        content.pollUpdateMessage ||
        content.pinInChatMessage ||
        content.keepInChatMessage ||
        content.encCommentMessage) {
        return false;
    }
    const protocolType = content.protocolMessage?.type;
    if (protocolType === REVOKE || protocolType === MESSAGE_UNSCHEDULE || protocolType === MESSAGE_EDIT) {
        return false;
    }
    return (!content.secretEncryptedMessage || !ENCRYPTED_ADDON_TYPES.includes(content.secretEncryptedMessage.secretEncType));
};

const generateMsgSecretKey = (modificationType, origMsgId, origMsgSender, modificationSender, origMsgSecret) => hkdf(origMsgSecret, 32, { info: origMsgId + origMsgSender + modificationSender + modificationType });

const extractReportingTokenContent = (data, cfg) => {
    const out = [];
    let i = 0;
    while (i < data.length) {
        const tag = decodeVarint(data, i);
        
        if (!tag.ok || tag.value >= 0x100000000) {
            return null;
        }
        const fieldNum = Math.floor(tag.value / 8);
        const wireType = tag.value % 8;
        const fieldStart = i;
        i += tag.bytes;
        let valueStart = i;
        let end;
        if (wireType === WIRE.VARINT) {
            const v = decodeVarint(data, i);
            if (!v.ok) {
                return null;
            }
            end = i + v.bytes;
        }
        else if (wireType === WIRE.FIXED64) {
            end = i + 8;
        }
        else if (wireType === WIRE.FIXED32) {
            end = i + 4;
        }
        else if (wireType === WIRE.BYTES) {
            const len = decodeVarint(data, i);
            if (!len.ok) {
                return null;
            }
            valueStart = i + len.bytes;
            end = valueStart + len.value;
        }
        else {
            return null;
        }
        if (end > data.length) {
            return null;
        }
        i = end;
        const fieldCfg = cfg.get(fieldNum);
        if (!fieldCfg) {
            continue;
        }
        if (fieldCfg.m || fieldCfg.children) {
            if (wireType !== WIRE.BYTES) {
                continue;
            }
            const sub = extractReportingTokenContent(data.subarray(valueStart, end), fieldCfg.m ? compiledReportingFields : fieldCfg.children);
            if (sub === null) {
                return null;
            }
            if (sub.length > 0) {
                out.push({
                    num: fieldNum,
                    bytes: Buffer.concat([encodeVarint(tag.value), encodeVarint(sub.length), sub])
                });
            }
            continue;
        }
        out.push({ num: fieldNum, bytes: data.subarray(fieldStart, end) });
    }
    out.sort((a, b) => a.num - b.num);
    return Buffer.concat(out.map(f => f.bytes));
};
const BAD_VARINT = { value: 0, bytes: 0, ok: false };

const decodeVarint = (buffer, offset) => {
    let value = 0;
    for (let n = 0; n < 10 && offset + n < buffer.length; n++) {
        const current = buffer[offset + n];
        if (n === 9 && current > 1) {
            return BAD_VARINT;
        }
        value += (current & 0x7f) * 2 ** (7 * n);
        if ((current & 0x80) === 0) {
            return value <= Number.MAX_SAFE_INTEGER ? { value, bytes: n + 1, ok: true } : BAD_VARINT;
        }
    }
    return BAD_VARINT;
};
const encodeVarint = (value) => {
    const parts = [];
    let remaining = value >>> 0;
    while (remaining > 0x7f) {
        parts.push((remaining & 0x7f) | 0x80);
        remaining >>>= 7;
    }
    parts.push(remaining);
    return Buffer.from(parts);
};

export const getMessageReportingToken = async (msgProtobuf, message, key) => {
    const msgSecret = message.messageContextInfo?.messageSecret;
    
    const sender = jidNormalizedUser(key.participant || (key.fromMe ? undefined : key.remoteJid) || undefined);
    const chat = jidNormalizedUser(key.remoteJid || undefined);
    if (!msgSecret || !key.id || !sender || !chat || isJidInterop(chat)) {
        return null;
    }
    const reportingSecret = generateMsgSecretKey(ENC_SECRET_REPORT_TOKEN, key.id, sender, chat, msgSecret);
    const content = extractReportingTokenContent(msgProtobuf, compiledReportingFields);
    if (!content || content.length === 0) {
        return null;
    }
    const reportingToken = createHmac('sha256', reportingSecret).update(content).digest().subarray(0, 16);
    return {
        tag: 'reporting',
        attrs: {},
        content: [
            {
                tag: 'reporting_token',
                attrs: { v: REPORTING_TOKEN_VERSION },
                content: reportingToken
            }
        ]
    };
};
