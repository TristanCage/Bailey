import { isJidBot, isJidMetaAI, isLidUser, isPnUser, jidNormalizedUser, PSA_WID } from '../WABinary/index.js';
import { hmacSign } from './crypto.js';

export const shouldSendCsToken = (jid) => {
    const normalized = jidNormalizedUser(jid);
    if (!normalized) {
        return false;
    }
    
    
    return Boolean((isPnUser(normalized) || isLidUser(normalized)) &&
        normalized !== jidNormalizedUser(PSA_WID) &&
        !isJidBot(jid) &&
        !isJidMetaAI(jid));
};

export const generateCsToken = async ({ jid, nctSalt, getLIDForPN }) => {
    if (!nctSalt?.length || !shouldSendCsToken(jid)) {
        return undefined;
    }
    const normalized = jidNormalizedUser(jid);
    
    let recipientLid;
    if (isLidUser(normalized)) {
        recipientLid = normalized;
    }
    else {
        const lid = await getLIDForPN(normalized);
        recipientLid = lid ? jidNormalizedUser(lid) : undefined;
    }
    
    if (!recipientLid || !isLidUser(recipientLid)) {
        return undefined;
    }
    return hmacSign(Buffer.from(recipientLid), nctSalt, 'sha256');
};
