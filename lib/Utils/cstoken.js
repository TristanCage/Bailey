import { isJidBot, isJidMetaAI, isLidUser, isPnUser, jidNormalizedUser, PSA_WID } from '../WABinary/index.js';
import { hmacSign } from './crypto.js';

export const shouldSendCsToken = (jid) => {
    const normalized = jidNormalizedUser(jid);
    if (!normalized) {
        return false;
    }
    // PSA sender: whatsmeow compares the user part (0); normalize the constant too
    // since jidNormalizedUser rewrites c.us -> s.whatsapp.net
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
    // resolve the recipient's LID — the token is bound to it, not the PN
    let recipientLid;
    if (isLidUser(normalized)) {
        recipientLid = normalized;
    }
    else {
        const lid = await getLIDForPN(normalized);
        recipientLid = lid ? jidNormalizedUser(lid) : undefined;
    }
    // must resolve to a LID JID, else no token
    if (!recipientLid || !isLidUser(recipientLid)) {
        return undefined;
    }
    return hmacSign(Buffer.from(recipientLid), nctSalt, 'sha256');
};
//# sourceMappingURL=cstoken.js.map