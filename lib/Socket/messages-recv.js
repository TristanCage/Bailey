import NodeCache from '@cacheable/node-cache';
import { Boom } from '@hapi/boom';
import { randomBytes } from 'crypto';
import Long from 'long';
import { proto } from '../../WAProto/index.js';
import { DEFAULT_CACHE_TTLS, KEY_BUNDLE_TYPE, MIN_PREKEY_COUNT, PLACEHOLDER_MAX_AGE_SECONDS, STATUS_EXPIRY_SECONDS } from '../Defaults/index.js';
import { WAMessageAddressingMode, WAMessageStatus, WAMessageStubType } from '../Types/index.js';
import { aesDecryptCTR, aesEncryptGCM, buildAckStanza, cleanMessage, Curve, makeOfflineNodeProcessor, decodeMediaRetryNode, decodeMessageNode, decryptMessageNode, decryptSecretEncryptedMessage, rewriteSecretEditToProtocolMessage, delay, derivePairingCodeKey, encodeBigEndian, encodeSignedDeviceIdentity, extractAddressingContext, extractE2ESessionFromRetryReceipt, getCallStatusFromNode, getContentType, getHistoryMsg, getNextPreKeys, getPlatformType, getStatusFromReceiptType, handleIdentityChange, hkdf, makeShortcakeFlow, MISSING_KEYS_ERROR_TEXT, NACK_REASONS, NO_MESSAGE_FOUND_ERROR_TEXT, normalizeUsername, SERVER_ERROR_CODES, promiseTimeout, toNumber, unixTimestampSeconds, xmppPreKey, xmppSignedPreKey } from '../Utils/index.js';
import { makeMutex } from '../Utils/make-mutex.js';
import { buildMergedTcTokenIndexWrite, isTcTokenExpired, readTcTokenIndex, resolveIssuanceJid, resolveTcTokenJid } from '../Utils/tc-token-utils.js';
import { areJidsSameUser, binaryNodeToString, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildBuffer, getBinaryNodeChildren, getBinaryNodeChildString, getBinaryNodeChildUInt, isJidBroadcast, isJidGroup, isJidNewsletter, isJidStatusBroadcast, isLidUser, isPnUser, jidDecode, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary/index.js';
import { extractGroupMetadata } from './groups.js';
import { makeMessagesSocket } from './messages-send.js';
export const makeMessagesRecvSocket = (config) => {
    const { logger, retryRequestDelayMs, maxMsgRetryCount, getMessage, shouldIgnoreJid, enableAutoSessionRecreation, ignoreOfflineMessages } = config;
    const sock = makeMessagesSocket(config);
    const { userDevicesCache, devicesMutex, ev, authState, ws, messageMutex, notificationMutex, receiptMutex, signalRepository, query, upsertMessage, resyncAppState, onUnexpectedError, assertSessions, sendNode, relayMessage, sendReceipt, uploadPreKeys, sendPeerDataOperationMessage, messageRetryManager, getPrivacyTokens, disposables, offlineBatch } = sock;
    /** Shortcake passkey-linking flow, only when a `signPasskeyAssertion` is configured. */
    const shortcakeFlow = config.signPasskeyAssertion
        ? makeShortcakeFlow({
            logger,
            query,
            signAssertion: config.signPasskeyAssertion,
            getCreds: () => authState.creds,
            updateCreds: patch => ev.emit('creds.update', patch),
            deviceType: getPlatformType(config.browser[1]),
            emitVerificationCode: code => logger.debug({ code }, 'shortcake verification code')
        })
        : null;
    /** Serializes prologue -> continuation off the notification mutex, so the ack isn't blocked by the handshake. */
    const shortcakeMutex = makeMutex();
    /** Runs the forced-passkey handshake (detached); with no signer, surfaces `passkeyRequired` and warns. */
    const handleShortcakeNotification = (node) => {
        // only the server may drive the Shortcake handshake — a crafted peer
        // notification would otherwise trigger an ADV-secret rotation
        if (node.attrs.from !== S_WHATSAPP_NET) {
            logger.warn({ from: node.attrs.from, type: node.attrs.type }, 'ignoring shortcake notification from non-server JID');
            return;
        }
        if (node.attrs.type === 'passkey_prologue_request') {
            ev.emit('connection.update', { passkeyRequired: { hasSigner: !!shortcakeFlow } });
        }
        if (!shortcakeFlow) {
            if (node.attrs.type === 'passkey_prologue_request') {
                logger.warn({ id: node.attrs.id }, 'server requested passkey prologue but no signPasskeyAssertion configured');
            }
            return;
        }
        // run detached + serialized: the notification is acked immediately, and the
        // handshake (external signer + follow-up IQs) never blocks other notifications
        shortcakeMutex
            .mutex(() => shortcakeFlow.handleIncomingNotification(node))
            .catch(err => logger.error({ err, id: node.attrs.id }, 'shortcake handshake failed'));
    };
    /** this mutex ensures that each retryRequest will wait for the previous one to finish */
    const retryMutex = makeMutex();
    const msgRetryCache = config.msgRetryCounterCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
            useClones: false
        });
    const callOfferCache = config.callOfferCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.CALL_OFFER, // 5 mins
            useClones: false
        });
    const placeholderResendCache = config.placeholderResendCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
            useClones: false
        });
    // Debounce identity-change session refreshes per JID to avoid bursts
    const identityAssertDebounce = new NodeCache({ stdTTL: 5, useClones: false });
    let sendActiveReceipts = false;
    // ── Tctoken lifecycle state ──
    /** Set of JIDs for which we have a stored tctoken — used for pruning */
    const tcTokenKnownJids = new Set();
    /** Debounce timer for persisting the tctoken index */
    let tcTokenIndexTimer;
    /** Last time we pruned expired tctokens (unix seconds) */
    let lastTcTokenPruneTimestamp = 0;
    /** Schedule a debounced save of the tctoken index to persistent storage */
    const scheduleTcTokenIndexSave = () => {
        if (tcTokenIndexTimer)
            clearTimeout(tcTokenIndexTimer);
        tcTokenIndexTimer = setTimeout(async () => {
            try {
                const indexWrite = await buildMergedTcTokenIndexWrite(authState.keys, tcTokenKnownJids);
                await authState.keys.set({ tctoken: indexWrite });
                logger.debug({ count: tcTokenKnownJids.size }, 'persisted tctoken index');
            }
            catch (err) {
                logger.warn({ err }, 'failed to persist tctoken index');
            }
        }, 5000);
    };
    /** Load tctoken index from persistent storage */
    const loadTcTokenIndex = async () => {
        try {
            const persisted = await readTcTokenIndex(authState.keys);
            for (const jid of persisted) {
                tcTokenKnownJids.add(jid);
            }
            if (persisted.length > 0) {
                logger.debug({ count: tcTokenKnownJids.size }, 'loaded tctoken index');
            }
        }
        catch (err) {
            logger.warn({ err }, 'failed to load tctoken index');
        }
    };
    /** Prune expired tctokens from persistent storage (at most once per 24h) */
    const pruneExpiredTcTokens = async () => {
        const now = Math.floor(Date.now() / 1000);
        const ONE_DAY = 24 * 60 * 60;
        if (now - lastTcTokenPruneTimestamp < ONE_DAY)
            return;
        lastTcTokenPruneTimestamp = now;
        try {
            const jids = [...tcTokenKnownJids];
            if (!jids.length)
                return;
            const tokenData = await authState.keys.get('tctoken', jids);
            const toRemove = [];
            for (const jid of jids) {
                const entry = tokenData[jid];
                if (!entry || isTcTokenExpired(entry.timestamp)) {
                    toRemove.push(jid);
                }
            }
            if (toRemove.length) {
                const setData = {};
                for (const jid of toRemove) {
                    setData[jid] = null;
                    tcTokenKnownJids.delete(jid);
                }
                await authState.keys.set({ tctoken: setData });
                scheduleTcTokenIndexSave();
                logger.info({ pruned: toRemove.length, remaining: tcTokenKnownJids.size }, 'pruned expired tctokens');
            }
        }
        catch (err) {
            logger.warn({ err }, 'failed to prune expired tctokens');
        }
    };
    // Load tctoken index on startup
    loadTcTokenIndex().catch(err => logger.warn({ err }, 'failed initial tctoken index load'));
    const fetchMessageHistory = async (count, oldestMsgKey, oldestMsgTimestamp) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated');
        }
        const pdoMessage = {
            historySyncOnDemandRequest: {
                chatJid: oldestMsgKey.remoteJid,
                oldestMsgFromMe: oldestMsgKey.fromMe,
                oldestMsgId: oldestMsgKey.id,
                oldestMsgTimestampMs: oldestMsgTimestamp,
                onDemandMsgCount: count
            },
            peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
        };
        return sendPeerDataOperationMessage(pdoMessage);
    };
    const requestPlaceholderResend = async (messageKey, msgData) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated');
        }
        if (await placeholderResendCache.get(messageKey?.id)) {
            logger.debug({ messageKey }, 'already requested resend');
            return;
        }
        else {
            // Store original message data so PDO response handler can preserve
            // metadata (LID details, timestamps, etc.) that the phone may omit
            await placeholderResendCache.set(messageKey?.id, msgData || true);
        }
        await delay(2000);
        if (!(await placeholderResendCache.get(messageKey?.id))) {
            logger.debug({ messageKey }, 'message received while resend requested');
            return 'RESOLVED';
        }
        const pdoMessage = {
            placeholderMessageResendRequest: [
                {
                    messageKey
                }
            ],
            peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND
        };
        setTimeout(async () => {
            if (await placeholderResendCache.get(messageKey?.id)) {
                logger.debug({ messageKey }, 'PDO message without response after 8 seconds. Phone possibly offline');
                await placeholderResendCache.del(messageKey?.id);
            }
        }, 8000);
        return sendPeerDataOperationMessage(pdoMessage);
    };
    // Handles mex newsletter notifications
    const handleMexNewsletterNotification = async (node) => {
        const mexNode = getBinaryNodeChild(node, 'mex');
        const updateNode = mexNode?.content ? null : getBinaryNodeChild(node, 'update') || getAllBinaryNodeChildren(node)[0];
        const payloadNode = mexNode?.content ? mexNode : updateNode;
        if (!payloadNode?.content) {
            logger.warn({ node }, 'Invalid mex newsletter notification');
            return;
        }
        let data;
        try {
            const payloadContent = payloadNode.content;
            if (Array.isArray(payloadContent)) {
                logger.warn({ payloadNode }, 'Invalid mex newsletter notification payload format');
                return;
            }
            const contentBuf = typeof payloadContent === 'string' ? Buffer.from(payloadContent, 'binary') : Buffer.from(payloadContent);
            data = JSON.parse(contentBuf.toString());
        }
        catch (error) {
            logger.error({ err: error, node }, 'Failed to parse mex newsletter notification');
            return;
        }
        const operation = data?.operation ?? payloadNode?.attrs?.op_name;
        let updates = data?.updates;
        if (!updates) {
            const linkedProfiles = data?.data?.xwa2_notify_linked_profiles;
            if (linkedProfiles) {
                updates = [linkedProfiles];
            }
        }
        if (!updates || !operation) {
            logger.warn({ data }, 'Invalid mex newsletter notification content');
            return;
        }
        logger.info({ operation, updates }, 'got mex newsletter notification');
        switch (operation) {
            case 'NotificationNewsletterUpdate':
                for (const update of updates) {
                    if (update.jid && update.settings && Object.keys(update.settings).length > 0) {
                        ev.emit('newsletter-settings.update', {
                            id: update.jid,
                            update: update.settings
                        });
                    }
                }
                break;
            case 'NotificationNewsletterAdminPromote':
                for (const update of updates) {
                    if (update.jid && update.user) {
                        ev.emit('newsletter-participants.update', {
                            id: update.jid,
                            author: node.attrs.from,
                            user: update.user,
                            new_role: 'ADMIN',
                            action: 'promote'
                        });
                    }
                }
                break;
            case 'NotificationLinkedProfilesUpdates':
                for (const update of updates) {
                    const lid = update?.jid;
                    const addedProfiles = Array.isArray(update?.added_profiles) ? update.added_profiles : [];
                    const mappings = [];
                    for (const profile of addedProfiles) {
                        const pn = typeof profile === 'string' ? profile : (profile?.pn ?? profile?.jid ?? null);
                        if (lid && pn) {
                            const mapping = { lid, pn };
                            ev.emit('lid-mapping.update', mapping);
                            mappings.push(mapping);
                        }
                    }
                    await signalRepository.lidMapping.storeLIDPNMappings(mappings);
                }
                break;
            case 'NotificationAccountReachoutTimelock':
                for (const update of updates) {
                    ev.emit('account-reachout-timelock.update', {
                        enforcement_type: update.enforcement_type,
                        is_active: update.is_active,
                        time_enforcement_ends: update.time_enforcement_ends
                    });
                }
                break;
            default:
                logger.info({ operation, data }, 'Unhandled mex newsletter notification');
                break;
        }
    };
    // Handles newsletter notifications
    const handleNewsletterNotification = async (node) => {
        const from = node.attrs.from;
        const children = getAllBinaryNodeChildren(node);
        const author = node.attrs.participant;
        for (const child of children) {
            logger.debug({ from, child }, 'got newsletter notification');
            switch (child.tag) {
                case 'reaction': {
                    const reactionUpdate = {
                        id: from,
                        server_id: child.attrs.message_id,
                        reaction: {
                            code: getBinaryNodeChildString(child, 'reaction'),
                            count: 1
                        }
                    };
                    ev.emit('newsletter.reaction', reactionUpdate);
                    break;
                }
                case 'view': {
                    const viewUpdate = {
                        id: from,
                        server_id: child.attrs.message_id,
                        count: parseInt(child.content?.toString() || '0', 10)
                    };
                    ev.emit('newsletter.view', viewUpdate);
                    break;
                }
                case 'participant': {
                    const participantUpdate = {
                        id: from,
                        author,
                        user: child.attrs.jid,
                        action: child.attrs.action,
                        new_role: child.attrs.role
                    };
                    ev.emit('newsletter-participants.update', participantUpdate);
                    break;
                }
                case 'update': {
                    const settingsNode = getBinaryNodeChild(child, 'settings');
                    if (settingsNode) {
                        const update = {};
                        const nameNode = getBinaryNodeChild(settingsNode, 'name');
                        if (nameNode?.content)
                            update.name = nameNode.content.toString();
                        const descriptionNode = getBinaryNodeChild(settingsNode, 'description');
                        if (descriptionNode?.content)
                            update.description = descriptionNode.content.toString();
                        ev.emit('newsletter-settings.update', {
                            id: from,
                            update
                        });
                    }
                    break;
                }
                case 'message': {
                    const plaintextNode = getBinaryNodeChild(child, 'plaintext');
                    if (plaintextNode?.content) {
                        try {
                            const contentBuf = typeof plaintextNode.content === 'string'
                                ? Buffer.from(plaintextNode.content, 'binary')
                                : Buffer.from(plaintextNode.content);
                            const messageProto = proto.Message.decode(contentBuf).toJSON();
                            const fullMessage = proto.WebMessageInfo.fromObject({
                                key: {
                                    remoteJid: from,
                                    id: child.attrs.message_id || child.attrs.server_id,
                                    fromMe: false // TODO: is this really true though
                                },
                                message: messageProto,
                                messageTimestamp: +child.attrs.t
                            }).toJSON();
                            await upsertMessage(fullMessage, 'append');
                            logger.debug('Processed plaintext newsletter message');
                        }
                        catch (error) {
                            logger.error({ error }, 'Failed to decode plaintext newsletter message');
                        }
                    }
                    break;
                }
                default:
                    logger.warn({ node, child }, 'Unknown newsletter notification child');
                    break;
            }
        }
    };
    const sendMessageAck = async (node, errorCode) => {
        // creds.me is unset while pairing; notifications (e.g. companion_reg_refresh) still need their ack
        const stanza = buildAckStanza(node, errorCode, authState.creds.me?.id);
        logger.debug({ recv: { tag: node.tag, attrs: node.attrs }, sent: stanza.attrs }, 'sent ack');
        await sendNode(stanza);
    };
    const rejectCall = async (callId, callFrom) => {
        const rejectNode = {
            tag: 'reject',
            attrs: {
                'call-id': callId,
                'call-creator': callFrom,
                count: '0'
            },
            // whatsmeow 592721a0: call rejects carry no tctoken
            content: undefined
        };
        const stanza = {
            tag: 'call',
            attrs: {
                from: authState.creds.me.id,
                to: callFrom
            },
            content: [rejectNode]
        };
        await query(stanza);
    };
    const sendRetryRequest = async (node, forceIncludeKeys = false) => {
        const { fullMessage } = decodeMessageNode(node, authState.creds.me.id, authState.creds.me.lid || '');
        const { key: msgKey } = fullMessage;
        const msgId = msgKey.id;
        if (messageRetryManager) {
            // Check if we've exceeded max retries using the new system
            if (messageRetryManager.hasExceededMaxRetries(msgId)) {
                logger.debug({ msgId }, 'reached retry limit with new retry manager, clearing');
                messageRetryManager.markRetryFailed(msgId);
                return;
            }
            // Increment retry count using new system
            const retryCount = messageRetryManager.incrementRetryCount(msgId);
            // Use the new retry count for the rest of the logic
            const key = `${msgId}:${msgKey?.participant}`;
            await msgRetryCache.set(key, retryCount);
        }
        else {
            // Fallback to old system
            const key = `${msgId}:${msgKey?.participant}`;
            let retryCount = (await msgRetryCache.get(key)) || 0;
            if (retryCount >= maxMsgRetryCount) {
                logger.debug({ retryCount, msgId }, 'reached retry limit, clearing');
                await msgRetryCache.del(key);
                return;
            }
            retryCount += 1;
            await msgRetryCache.set(key, retryCount);
        }
        const key = `${msgId}:${msgKey?.participant}`;
        const retryCount = (await msgRetryCache.get(key)) || 1;
        const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds;
        const fromJid = node.attrs.from;
        // Check if we should recreate the session
        let shouldRecreateSession = false;
        let recreateReason = '';
        if (enableAutoSessionRecreation && messageRetryManager && retryCount > 1) {
            try {
                // Check if we have a session with this JID
                const sessionId = signalRepository.jidToSignalProtocolAddress(fromJid);
                const hasSession = await signalRepository.validateSession(fromJid);
                const errorCode = messageRetryManager.parseRetryErrorCode(node.attrs.error);
                const result = messageRetryManager.shouldRecreateSession(fromJid, hasSession.exists, errorCode);
                shouldRecreateSession = result.recreate;
                recreateReason = result.reason;
                if (shouldRecreateSession) {
                    logger.debug({ fromJid, retryCount, reason: recreateReason }, 'recreating session for retry');
                    // Delete existing session to force recreation
                    await authState.keys.set({ session: { [sessionId]: null } });
                    forceIncludeKeys = true;
                }
            }
            catch (error) {
                logger.warn({ error, fromJid }, 'failed to check session recreation');
            }
        }
        if (retryCount <= 2) {
            // Use new retry manager for phone requests if available
            if (messageRetryManager) {
                // Schedule phone request with delay (like whatsmeow)
                messageRetryManager.schedulePhoneRequest(msgId, async () => {
                    try {
                        const requestId = await requestPlaceholderResend(msgKey);
                        logger.debug(`sendRetryRequest: requested placeholder resend (${requestId}) for message ${msgId} (scheduled)`);
                    }
                    catch (error) {
                        logger.warn({ error, msgId }, 'failed to send scheduled phone request');
                    }
                });
            }
            else {
                // Fallback to immediate request
                const msgId = await requestPlaceholderResend(msgKey);
                logger.debug(`sendRetryRequest: requested placeholder resend for message ${msgId}`);
            }
        }
        const deviceIdentity = encodeSignedDeviceIdentity(account, true);
        try {
            await delay(retryRequestDelayMs || 250);
            await authState.keys.transaction(async () => {
                const receipt = {
                    tag: 'receipt',
                    attrs: {
                        id: msgId,
                        type: 'retry',
                        to: node.attrs.from
                    },
                    content: [
                        {
                            tag: 'retry',
                            attrs: {
                                count: retryCount.toString(),
                                id: node.attrs.id,
                                t: node.attrs.t,
                                v: '1',
                                // ADD ERROR FIELD
                                error: '0'
                            }
                        },
                        {
                            tag: 'registration',
                            attrs: {},
                            content: encodeBigEndian(authState.creds.registrationId)
                        }
                    ]
                };
                if (node.attrs.recipient) {
                    receipt.attrs.recipient = node.attrs.recipient;
                }
                if (node.attrs.participant) {
                    receipt.attrs.participant = node.attrs.participant;
                }
                if (retryCount > 1 || forceIncludeKeys || shouldRecreateSession) {
                    const { update, preKeys } = await getNextPreKeys(authState, 1);
                    const [keyId] = Object.keys(preKeys);
                    const key = preKeys[+keyId];
                    const content = receipt.content;
                    content.push({
                        tag: 'keys',
                        attrs: {},
                        content: [
                            { tag: 'type', attrs: {}, content: Buffer.from(KEY_BUNDLE_TYPE) },
                            { tag: 'identity', attrs: {}, content: identityKey.public },
                            xmppPreKey(key, +keyId),
                            xmppSignedPreKey(signedPreKey),
                            { tag: 'device-identity', attrs: {}, content: deviceIdentity }
                        ]
                    });
                    ev.emit('creds.update', update);
                }
                await sendNode(receipt);
                logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt');
            }, authState?.creds?.me?.id || 'sendRetryRequest');
        }
        catch (txError) {
            logger.error({ msgId, error: txError }, 'sendRetryRequest failed');
            // Don't rethrow - allow message processing to continue
        }
    };
    const handleEncryptNotification = async (node) => {
        const from = node.attrs.from;
        if (from === S_WHATSAPP_NET) {
            const countChild = getBinaryNodeChild(node, 'count');
            const count = +countChild.attrs.value;
            const shouldUploadMorePreKeys = count < MIN_PREKEY_COUNT;
            logger.debug({ count, shouldUploadMorePreKeys }, 'recv pre-key count');
            if (shouldUploadMorePreKeys) {
                await uploadPreKeys();
            }
        }
        else {
            const result = await handleIdentityChange(node, {
                meId: authState.creds.me?.id,
                meLid: authState.creds.me?.lid,
                validateSession: signalRepository.validateSession,
                assertSessions,
                debounceCache: identityAssertDebounce,
                logger
            });
            if (result.action === 'session_refreshed') {
                // Re-issue tctoken after identity change if we previously issued one
                // Matches WAWebSendTcTokenWhenDeviceIdentityChange
                try {
                    const normalizedJid = jidNormalizedUser(from);
                    const tcJid = await resolveTcTokenJid(normalizedJid, signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping));
                    const tcTokenData = await authState.keys.get('tctoken', [tcJid]);
                    const senderTs = tcTokenData?.[tcJid]?.senderTimestamp;
                    // Only re-issue if we previously sent a token AND it's still valid
                    if (senderTs !== null && senderTs !== undefined && !isTcTokenExpired(senderTs)) {
                        logger.debug({ jid: normalizedJid, senderTimestamp: senderTs }, 'identity changed, re-issuing tctoken');
                        // AB prop 14303 controls whether the issuance target should be the LID or the PN.
                        const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping);
                        const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping);
                        const issueJid = await resolveIssuanceJid(normalizedJid, sock.serverProps.lidTrustedTokenIssueToLid, getLIDForPN, getPNForLID);
                        // Pass original senderTimestamp to match WA Web
                        getPrivacyTokens([issueJid], senderTs).catch(err => {
                            logger.debug({ jid: normalizedJid, issueJid, err: err?.message }, 'failed to re-issue tctoken after identity change');
                        });
                    }
                }
                catch (err) {
                    logger.warn({ from, err: err?.message }, 'error checking tctoken for re-issuance after identity change');
                }
            }
            else if (result.action === 'no_identity_node') {
                logger.info({ node }, 'unknown encrypt notification');
            }
        }
    };
    const handleGroupNotification = (fullNode, child, msg) => {
        // TODO: Support PN/LID (Here is only LID now)
        const actingParticipantLid = fullNode.attrs.participant;
        const actingParticipantPn = fullNode.attrs.participant_pn;
        const actingParticipantUsername = fullNode.attrs.participant_username;
        const affectedParticipantLid = getBinaryNodeChild(child, 'participant')?.attrs?.jid || actingParticipantLid;
        const affectedParticipantPn = getBinaryNodeChild(child, 'participant')?.attrs?.phone_number || actingParticipantPn;
        switch (child?.tag) {
            case 'create':
                const metadata = extractGroupMetadata(child);
                // whatsmeow 1142895b: the <group> in a create notification may omit addressing_mode;
                // fall back to the one on the enclosing <notification>
                if (!getBinaryNodeChild(child, 'group')?.attrs.addressing_mode && fullNode.attrs.addressing_mode) {
                    metadata.addressingMode =
                        fullNode.attrs.addressing_mode === 'lid' ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN;
                }
                msg.messageStubType = WAMessageStubType.GROUP_CREATE;
                msg.messageStubParameters = [metadata.subject];
                msg.key = { participant: metadata.owner, participantAlt: metadata.ownerPn };
                ev.emit('chats.upsert', [
                    {
                        id: metadata.id,
                        name: metadata.subject,
                        conversationTimestamp: metadata.creation
                    }
                ]);
                ev.emit('groups.upsert', [
                    {
                        ...metadata,
                        author: actingParticipantLid,
                        authorPn: actingParticipantPn,
                        authorUsername: actingParticipantUsername
                    }
                ]);
                break;
            case 'ephemeral':
            case 'not_ephemeral':
                msg.message = {
                    protocolMessage: {
                        type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
                        ephemeralExpiration: +(child.attrs.expiration || 0)
                    }
                };
                break;
            case 'modify':
                const oldNumber = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid);
                msg.messageStubParameters = oldNumber || [];
                msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER;
                break;
            case 'promote':
            case 'demote':
            case 'remove':
            case 'add':
            case 'leave':
                const stubType = `GROUP_PARTICIPANT_${child.tag.toUpperCase()}`;
                msg.messageStubType = WAMessageStubType[stubType];
                const participants = getBinaryNodeChildren(child, 'participant').map(({ attrs }) => {
                    // TODO: Store LID MAPPINGS
                    return {
                        id: attrs.jid,
                        phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
                        lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
                        username: attrs.participant_username || attrs.username || undefined,
                        admin: (attrs.type || null)
                    };
                });
                // Auto-populate username mapping from group participant data
                const usernamePairs = participants
                    .filter(p => p.username && p.id)
                    .map(p => ({ username: p.username, jid: p.id }));
                if (usernamePairs.length) {
                    signalRepository.usernameMapping.storeUsernameMappings(usernamePairs).catch(() => {});
                }
                if (participants.length === 1 &&
                    // if recv. "remove" message and sender removed themselves
                    // mark as left
                    (areJidsSameUser(participants[0].id, actingParticipantLid) ||
                        areJidsSameUser(participants[0].id, actingParticipantPn)) &&
                    child.tag === 'remove') {
                    msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_LEAVE;
                }
                msg.messageStubParameters = participants.map(a => JSON.stringify(a));
                break;
            case 'subject':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_SUBJECT;
                msg.messageStubParameters = [child.attrs.subject];
                break;
            case 'description':
                const description = getBinaryNodeChild(child, 'body')?.content?.toString();
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_DESCRIPTION;
                msg.messageStubParameters = description ? [description] : undefined;
                break;
            case 'announcement':
            case 'not_announcement':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_ANNOUNCE;
                msg.messageStubParameters = [child.tag === 'announcement' ? 'on' : 'off'];
                break;
            case 'locked':
            case 'unlocked':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_RESTRICT;
                msg.messageStubParameters = [child.tag === 'locked' ? 'on' : 'off'];
                break;
            case 'invite':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_INVITE_LINK;
                msg.messageStubParameters = [child.attrs.code];
                break;
            case 'member_add_mode':
                const addMode = child.content;
                if (addMode) {
                    msg.messageStubType = WAMessageStubType.GROUP_MEMBER_ADD_MODE;
                    msg.messageStubParameters = [addMode.toString()];
                }
                break;
            case 'membership_approval_mode':
                const approvalMode = getBinaryNodeChild(child, 'group_join');
                if (approvalMode) {
                    msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE;
                    msg.messageStubParameters = [approvalMode.attrs.state];
                }
                break;
            case 'created_membership_requests':
                msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD;
                msg.messageStubParameters = [
                    JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
                    'created',
                    child.attrs.request_method
                ];
                break;
            case 'revoked_membership_requests':
                const isDenied = areJidsSameUser(affectedParticipantLid, actingParticipantLid);
                // TODO: LIDMAPPING SUPPORT
                msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD;
                msg.messageStubParameters = [
                    JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
                    isDenied ? 'revoked' : 'rejected'
                ];
                break;
        }
    };
    const handleDevicesNotification = async (node) => {
        const [child] = getAllBinaryNodeChildren(node);
        const from = jidNormalizedUser(node.attrs.from);
        if (!child) {
            logger.debug({ from }, 'devices notification missing child, skipping');
            return;
        }
        const tag = child.tag;
        const deviceHash = child.attrs.device_hash;
        const devices = getBinaryNodeChildren(child, 'device');
        if (areJidsSameUser(from, authState.creds.me.id) || areJidsSameUser(from, authState.creds.me.lid)) {
            const deviceJids = devices.map(d => d.attrs.jid);
            logger.info({ deviceJids }, 'got my own devices');
        }
        if (!devices.length) {
            logger.debug({ from, tag }, 'no devices in notification, skipping');
            return;
        }
        const decoded = [];
        for (const d of devices) {
            const jid = d.attrs.jid;
            if (!jid)
                continue;
            const parts = jidDecode(jid);
            if (!parts) {
                logger.debug({ jid }, 'failed to decode device jid, skipping');
                continue;
            }
            decoded.push({ jid, user: parts.user, server: parts.server, device: parts.device });
        }
        if (!decoded.length)
            return;
        await devicesMutex.mutex(async () => {
            const byUser = new Map();
            for (const d of decoded) {
                const list = byUser.get(d.user) || [];
                list.push(d);
                byUser.set(d.user, list);
            }
            for (const [user, entries] of byUser) {
                if (tag === 'update') {
                    logger.debug({ user }, `${user}'s device list updated, dropping cached devices`);
                    await userDevicesCache?.del(user);
                    continue;
                }
                if (tag === 'remove') {
                    await signalRepository.deleteSession(entries.map(e => e.jid));
                }
                const existingCache = (await userDevicesCache?.get(user)) || [];
                if (!existingCache.length) {
                    // No baseline yet; skip applying the delta so getUSyncDevices can
                    // later fetch the full device list. Caching just the notification
                    // entries would make a partial list look authoritative.
                    logger.debug({ user, tag }, 'device list not cached, deferring to USync refresh');
                    continue;
                }
                const affected = new Set(entries.map(e => e.device));
                let updatedDevices;
                switch (tag) {
                    case 'add':
                        logger.info({ deviceHash, count: entries.length }, 'devices added');
                        updatedDevices = [
                            ...existingCache.filter(d => !affected.has(d.device)),
                            ...entries.map(e => ({ user: e.user, server: e.server, device: e.device }))
                        ];
                        break;
                    case 'remove':
                        logger.info({ deviceHash, count: entries.length }, 'devices removed');
                        updatedDevices = existingCache.filter(d => !affected.has(d.device));
                        break;
                    default:
                        logger.debug({ tag }, 'Unknown device list change tag');
                        continue;
                }
                if (updatedDevices.length === 0) {
                    await userDevicesCache?.del(user);
                }
                else {
                    await userDevicesCache?.set(user, updatedDevices);
                }
            }
        });
    };
    const processNotification = async (node) => {
        const result = {};
        const [child] = getAllBinaryNodeChildren(node);
        const nodeType = node.attrs.type;
        const from = jidNormalizedUser(node.attrs.from);
        switch (nodeType) {
            case 'newsletter':
                await handleNewsletterNotification(node);
                break;
            case 'mex':
                await handleMexNewsletterNotification(node);
                break;
            case 'w:gp2':
                // TODO: HANDLE PARTICIPANT_PN
                handleGroupNotification(node, child, result);
                break;
            case 'mediaretry':
                const event = decodeMediaRetryNode(node);
                ev.emit('messages.media-update', [event]);
                break;
            case 'encrypt':
                await handleEncryptNotification(node);
                break;
            case 'devices':
                try {
                    await handleDevicesNotification(node);
                }
                catch (error) {
                    logger.error({ error, node }, 'failed to handle devices notification');
                }
                break;
            case 'server_sync':
                const update = getBinaryNodeChild(node, 'collection');
                if (update) {
                    const name = update.attrs.name;
                    await resyncAppState([name], false);
                }
                break;
            case 'picture':
                const setPicture = getBinaryNodeChild(node, 'set');
                const delPicture = getBinaryNodeChild(node, 'delete');
                ev.emit('contacts.update', [
                    {
                        id: jidNormalizedUser(node?.attrs?.from) || (setPicture || delPicture)?.attrs?.hash || '',
                        imgUrl: setPicture ? 'changed' : 'removed'
                    }
                ]);
                if (isJidGroup(from)) {
                    const node = setPicture || delPicture;
                    result.messageStubType = WAMessageStubType.GROUP_CHANGE_ICON;
                    if (setPicture) {
                        result.messageStubParameters = [setPicture.attrs.id];
                    }
                    result.participant = node?.attrs.author;
                    result.key = {
                        ...(result.key || {}),
                        participant: setPicture?.attrs.author
                    };
                }
                break;
            case 'account_sync':
                if (child.tag === 'disappearing_mode') {
                    const newDuration = +child.attrs.duration;
                    const timestamp = +child.attrs.t;
                    logger.info({ newDuration }, 'updated account disappearing mode');
                    ev.emit('creds.update', {
                        accountSettings: {
                            ...authState.creds.accountSettings,
                            defaultDisappearingMode: {
                                ephemeralExpiration: newDuration,
                                ephemeralSettingTimestamp: timestamp
                            }
                        }
                    });
                }
                else if (child.tag === 'blocklist') {
                    const blocklists = getBinaryNodeChildren(child, 'item');
                    for (const { attrs } of blocklists) {
                        const blocklist = [attrs.jid];
                        const type = attrs.action === 'block' ? 'add' : 'remove';
                        ev.emit('blocklist.update', { blocklist, type });
                    }
                }
                break;
            case 'link_code_companion_reg':
                const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg');
                const ref = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_ref'));
                const primaryIdentityPublicKey = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub'));
                const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_wrapped_primary_ephemeral_pub'));
                if (primaryEphemeralPublicKeyWrapped.length < 80) {
                    throw new Boom(`unexpected length of link_code_pairing_wrapped_primary_ephemeral_pub: ${primaryEphemeralPublicKeyWrapped.length}`, { statusCode: 400 });
                }
                const codePairingPublicKey = await decipherLinkPublicKey(primaryEphemeralPublicKeyWrapped);
                const companionSharedKey = Curve.sharedKey(authState.creds.pairingEphemeralKeyPair.private, codePairingPublicKey);
                const random = randomBytes(32);
                const linkCodeSalt = randomBytes(32);
                const linkCodePairingExpanded = hkdf(companionSharedKey, 32, {
                    salt: linkCodeSalt,
                    info: 'link_code_pairing_key_bundle_encryption_key'
                });
                const encryptPayload = Buffer.concat([
                    Buffer.from(authState.creds.signedIdentityKey.public),
                    primaryIdentityPublicKey,
                    random
                ]);
                const encryptIv = randomBytes(12);
                const encrypted = aesEncryptGCM(encryptPayload, linkCodePairingExpanded, encryptIv, Buffer.alloc(0));
                const encryptedPayload = Buffer.concat([linkCodeSalt, encryptIv, encrypted]);
                const identitySharedKey = Curve.sharedKey(authState.creds.signedIdentityKey.private, primaryIdentityPublicKey);
                const identityPayload = Buffer.concat([companionSharedKey, identitySharedKey, random]);
                authState.creds.advSecretKey = Buffer.from(hkdf(identityPayload, 32, { info: 'adv_secret' })).toString('base64');
                await query({
                    tag: 'iq',
                    attrs: {
                        to: S_WHATSAPP_NET,
                        type: 'set',
                        id: sock.generateMessageTag(),
                        xmlns: 'md'
                    },
                    content: [
                        {
                            tag: 'link_code_companion_reg',
                            attrs: {
                                jid: authState.creds.me.id,
                                stage: 'companion_finish'
                            },
                            content: [
                                {
                                    tag: 'link_code_pairing_wrapped_key_bundle',
                                    attrs: {},
                                    content: encryptedPayload
                                },
                                {
                                    tag: 'companion_identity_public',
                                    attrs: {},
                                    content: authState.creds.signedIdentityKey.public
                                },
                                {
                                    tag: 'link_code_pairing_ref',
                                    attrs: {},
                                    content: ref
                                }
                            ]
                        }
                    ]
                });
                authState.creds.registered = true;
                ev.emit('creds.update', authState.creds);
                break;
            case 'passkey_prologue_request':
            case 'crsc_continuation':
                handleShortcakeNotification(node);
                break;
            case 'privacy_token':
                await handlePrivacyTokenNotification(node);
                break;
            case 'companion_reg_refresh':
                handleCompanionRegRefresh(node);
                break;
        }
        if (Object.keys(result).length) {
            return result;
        }
    };
    /**
     * whatsmeow 9ec8f76d / WA Web companion_reg_refresh: the server asks the still-unpaired
     * companion to rotate its ADV secret; socket.ts re-shows the current QR with the new one.
     */
    const handleCompanionRegRefresh = (node) => {
        if (node.attrs.from !== S_WHATSAPP_NET) {
            logger.warn({ from: node.attrs.from }, 'ignoring companion_reg_refresh from non-server JID');
            return;
        }
        if (!getBinaryNodeChild(node, 'companion_reg_refresh') && !getBinaryNodeChild(node, 'pair-device-rotate-qr')) {
            logger.debug({ node }, 'unrecognized companion_reg_refresh notification');
            return;
        }
        ev.emit('creds.update', { advSecretKey: randomBytes(32).toString('base64') });
    };
    const handlePrivacyTokenNotification = async (node) => {
        const tokensNode = getBinaryNodeChild(node, 'tokens');
        const from = jidNormalizedUser(node.attrs.from);
        if (!tokensNode)
            return;
        // WA Web uses: senderLid ?? toLid(from) for the storage key
        // The sender_lid attribute provides the LID directly when available
        const senderLid = node.attrs.sender_lid && isLidUser(jidNormalizedUser(node.attrs.sender_lid))
            ? jidNormalizedUser(node.attrs.sender_lid)
            : undefined;
        const storageJid = senderLid ??
            (await resolveTcTokenJid(from, signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)));
        const tokenNodes = getBinaryNodeChildren(tokensNode, 'token');
        for (const tokenNode of tokenNodes) {
            if (tokenNode.attrs.type !== 'trusted_contact' || !(tokenNode.content instanceof Uint8Array)) {
                continue;
            }
            const { timestamp } = tokenNode.attrs;
            logger.debug({
                from,
                storageJid,
                timestamp,
                tcToken: tokenNode.content
            }, 'received trusted contact token');
            // Preserve existing senderTimestamp to avoid racing with fire-and-forget
            const existingData = await authState.keys.get('tctoken', [storageJid]);
            const existingEntry = existingData[storageJid];
            // Timestamp monotonicity guard — only store if incoming timestamp >= existing
            const existingTs = existingEntry?.timestamp ? Number(existingEntry.timestamp) : 0;
            const incomingTs = timestamp ? Number(timestamp) : 0;
            if (existingTs > 0 && incomingTs > 0 && existingTs > incomingTs) {
                logger.debug({ storageJid, existingTs, incomingTs }, 'skipping tctoken store — existing timestamp is newer');
                continue;
            }
            await authState.keys.set({
                tctoken: { [storageJid]: { ...existingEntry, token: Buffer.from(tokenNode.content), timestamp } }
            });
            if (!tcTokenKnownJids.has(storageJid)) {
                tcTokenKnownJids.add(storageJid);
                scheduleTcTokenIndexSave();
            }
        }
    };
    async function decipherLinkPublicKey(data) {
        const buffer = toRequiredBuffer(data);
        const salt = buffer.slice(0, 32);
        const secretKey = await derivePairingCodeKey(authState.creds.pairingCode, salt);
        const iv = buffer.slice(32, 48);
        const payload = buffer.slice(48, 80);
        return aesDecryptCTR(payload, secretKey, iv);
    }
    function toRequiredBuffer(data) {
        if (data === undefined) {
            throw new Boom('Invalid buffer', { statusCode: 400 });
        }
        return data instanceof Buffer ? data : Buffer.from(data);
    }
    const willSendMessageAgain = async (id, participant) => {
        const key = `${id}:${participant}`;
        const retryCount = (await msgRetryCache.get(key)) || 0;
        return retryCount < maxMsgRetryCount;
    };
    const updateSendMessageAgainCount = async (id, participant) => {
        const key = `${id}:${participant}`;
        const newValue = ((await msgRetryCache.get(key)) || 0) + 1;
        await msgRetryCache.set(key, newValue);
    };
    const sendMessagesAgain = async (key, ids, retryNode, receiptNode) => {
        const remoteJid = key.remoteJid;
        const participant = key.participant || remoteJid;
        const retryCount = +retryNode.attrs.count || 1;
        const msgId = ids[0];
        // Try to get messages from cache first, then fallback to getMessage
        const msgs = [];
        for (const id of ids) {
            let msg;
            // Try to get from retry cache first if enabled
            if (messageRetryManager) {
                const cachedMsg = messageRetryManager.getRecentMessage(remoteJid, id);
                if (cachedMsg) {
                    msg = cachedMsg.message;
                    logger.debug({ jid: remoteJid, id }, 'found message in retry cache');
                    // Mark retry as successful since we found the message
                    messageRetryManager.markRetrySuccess(id);
                }
            }
            // Fallback to getMessage if not found in cache
            if (!msg) {
                msg = await getMessage({ ...key, id });
                if (msg) {
                    logger.debug({ jid: remoteJid, id }, 'found message via getMessage');
                    // Also mark as successful if found via getMessage
                    if (messageRetryManager) {
                        messageRetryManager.markRetrySuccess(id);
                    }
                }
            }
            msgs.push(msg);
        }
        // if it's the primary jid sending the request
        // just re-send the message to everyone
        // prevents the first message decryption failure
        const sendToAll = !jidDecode(participant)?.device;
        const sessionId = signalRepository.jidToSignalProtocolAddress(participant);
        let injectedFromBundle = false;
        const bundle = extractE2ESessionFromRetryReceipt(receiptNode);
        if (bundle) {
            try {
                await signalRepository.injectE2ESession({ jid: participant, session: bundle });
                injectedFromBundle = true;
                logger.debug({ participant, retryCount }, 'injected session from retry receipt key bundle');
            }
            catch (error) {
                logger.warn({ error, participant }, 'failed to inject session from retry receipt');
            }
        }
        if (!injectedFromBundle) {
            const receivedRegId = getBinaryNodeChildUInt(receiptNode, 'registration', 4);
            if (typeof receivedRegId === 'number' && Number.isInteger(receivedRegId)) {
                const info = await signalRepository.getSessionInfo(participant);
                if (info && info.registrationId !== 0 && info.registrationId !== receivedRegId) {
                    logger.info({ participant, stored: info.registrationId, received: receivedRegId }, 'reg id mismatch on retry without bundle, deleting session');
                    await authState.keys.set({ session: { [sessionId]: null } });
                }
            }
        }
        const BASE_KEY_CHECK_RETRY = 2;
        if (msgId && messageRetryManager) {
            const info = await signalRepository.getSessionInfo(participant);
            if (info) {
                if (retryCount === BASE_KEY_CHECK_RETRY) {
                    messageRetryManager.saveBaseKey(sessionId, msgId, info.baseKey);
                }
                else if (retryCount > BASE_KEY_CHECK_RETRY) {
                    if (messageRetryManager.hasSameBaseKey(sessionId, msgId, info.baseKey)) {
                        logger.warn({ participant, retryCount }, 'base key collision on retry, forcing fresh session');
                        await authState.keys.set({ session: { [sessionId]: null } });
                    }
                    messageRetryManager.deleteBaseKey(sessionId, msgId);
                }
            }
        }
        let shouldRecreateSession = false;
        let recreateReason = '';
        if (enableAutoSessionRecreation && messageRetryManager && retryCount > 1 && !injectedFromBundle) {
            try {
                const hasSession = await signalRepository.validateSession(participant);
                const errorCode = messageRetryManager.parseRetryErrorCode(retryNode.attrs.error);
                const result = messageRetryManager.shouldRecreateSession(participant, hasSession.exists, errorCode);
                shouldRecreateSession = result.recreate;
                recreateReason = result.reason;
                if (shouldRecreateSession) {
                    logger.debug({ participant, retryCount, reason: recreateReason }, 'recreating session for outgoing retry');
                    await authState.keys.set({ session: { [sessionId]: null } });
                }
            }
            catch (error) {
                logger.warn({ error, participant }, 'failed to check session recreation for outgoing retry');
            }
        }
        if (!injectedFromBundle) {
            await assertSessions([participant], true);
        }
        if (isJidGroup(remoteJid)) {
            await authState.keys.set({
                'sender-key-memory': {
                    [remoteJid]: null,
                    [`${remoteJid}:${authState.creds.me?.id}`]: null,
                    [`${remoteJid}:${authState.creds.me?.lid}`]: null
                }
            });
        }
        logger.debug({ participant, sendToAll, shouldRecreateSession, recreateReason, injectedFromBundle }, 'prepared session for retry resend');
        for (const [i, msg] of msgs.entries()) {
            if (!ids[i])
                continue;
            if (msg && (await willSendMessageAgain(ids[i], participant))) {
                await updateSendMessageAgainCount(ids[i], participant);
                const msgRelayOpts = { messageId: ids[i] };
                if (sendToAll) {
                    msgRelayOpts.useUserDevicesCache = false;
                }
                else {
                    msgRelayOpts.participant = {
                        jid: participant,
                        count: +retryNode.attrs.count
                    };
                }
                await relayMessage(key.remoteJid, msg, msgRelayOpts);
            }
            else {
                logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available');
            }
        }
    };
    const handleReceipt = async (node) => {
        const { attrs, content } = node;
        const isLid = attrs.from.includes('lid');
        const isNodeFromMe = areJidsSameUser(attrs.participant || attrs.from, isLid ? authState.creds.me?.lid : authState.creds.me?.id);
        const remoteJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient;
        const fromMe = !attrs.recipient || ((attrs.type === 'retry' || attrs.type === 'sender') && isNodeFromMe);
        const key = {
            remoteJid,
            id: '',
            fromMe,
            participant: attrs.participant,
            // WA Web WAWebHandleMsgReceiptParser (zapo 471ca18a)
            participantUsername: normalizeUsername(attrs.participant_username)
        };
        if (attrs.offline) {
            logger.debug({ remoteJid }, 'ignoring offline receipt');
            await sendMessageAck(node);
            return;
        }
        const ids = [attrs.id];
        if (Array.isArray(content)) {
            const items = getBinaryNodeChildren(content[0], 'item');
            ids.push(...items.map(i => i.attrs.id));
        }
        try {
            await Promise.all([
                receiptMutex.mutex(async () => {
                    const status = getStatusFromReceiptType(attrs.type);
                    if (typeof status !== 'undefined' &&
                        // basically, we only want to know when a message from us has been delivered to/read by the other person
                        // or another device of ours has read some messages
                        (status >= proto.WebMessageInfo.Status.SERVER_ACK || !isNodeFromMe)) {
                        if (isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid)) {
                            if (attrs.participant) {
                                const updateKey = status === proto.WebMessageInfo.Status.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp';
                                ev.emit('message-receipt.update', ids.map(id => ({
                                    key: { ...key, id },
                                    receipt: {
                                        userJid: jidNormalizedUser(attrs.participant),
                                        [updateKey]: +attrs.t
                                    }
                                })));
                            }
                        }
                        else {
                            ev.emit('messages.update', ids.map(id => ({
                                key: { ...key, id },
                                update: { status, messageTimestamp: toNumber(+(attrs.t ?? 0)) }
                            })));
                        }
                    }
                    if (attrs.type === 'retry') {
                        // correctly set who is asking for the retry
                        key.participant = key.participant || attrs.from;
                        const retryNode = getBinaryNodeChild(node, 'retry');
                        if (ids[0] && key.participant && (await willSendMessageAgain(ids[0], key.participant))) {
                            if (key.fromMe) {
                                try {
                                    await updateSendMessageAgainCount(ids[0], key.participant);
                                    logger.debug({ attrs, key }, 'recv retry request');
                                    await sendMessagesAgain(key, ids, retryNode, node);
                                }
                                catch (error) {
                                    logger.error({ key, ids, trace: error instanceof Error ? error.stack : 'Unknown error' }, 'error in sending message again');
                                }
                            }
                            else {
                                logger.info({ attrs, key }, 'recv retry for not fromMe message');
                            }
                        }
                        else {
                            logger.info({ attrs, key }, 'will not send message again, as sent too many times');
                        }
                    }
                })
            ]);
        }
        finally {
            await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack receipt'));
        }
    };
    const handleNotification = async (node) => {
        const remoteJid = node.attrs.from;
        if (ignoreOfflineMessages && node.attrs.offline) {
            logger.debug({ remoteJid, id: node.attrs.id }, 'ignored offline notification');
            await sendMessageAck(node);
            return;
        }
        try {
            await Promise.all([
                notificationMutex.mutex(async () => {
                    const msg = await processNotification(node);
                    if (msg) {
                        const fromMe = areJidsSameUser(node.attrs.participant || remoteJid, authState.creds.me.id);
                        const { senderAlt: participantAlt, addressingMode } = extractAddressingContext(node);
                        msg.key = {
                            remoteJid,
                            fromMe,
                            participant: node.attrs.participant,
                            participantAlt,
                            participantUsername: node.attrs.participant_username,
                            addressingMode,
                            id: node.attrs.id,
                            ...(msg.key || {})
                        };
                        msg.participant ?? (msg.participant = node.attrs.participant);
                        msg.messageTimestamp = +node.attrs.t;
                        const fullMsg = proto.WebMessageInfo.fromObject(msg);
                        await upsertMessage(fullMsg, 'append');
                    }
                })
            ]);
        }
        finally {
            await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack notification'));
        }
    };
    const handleMessage = async (node) => {
        const msgId = node.attrs.id;
        const from = node.attrs.from;
        if (ignoreOfflineMessages && node.attrs.offline) {
            logger.debug({ key: node.attrs.key }, 'ignored offline message');
            await sendMessageAck(node, NACK_REASONS.UnhandledError);
            return;
        }
        const encNode = getBinaryNodeChild(node, 'enc');
        // TODO: temporary fix for crashes and issues resulting of failed msmsg decryption
        if (encNode?.attrs.type === 'msmsg') {
            logger.debug({ key: node.attrs.key }, 'ignored msmsg');
            await sendMessageAck(node, NACK_REASONS.MissingMessageSecret);
            return;
        }
        const { fullMessage: msg, category, author, decrypt } = decryptMessageNode(node, authState.creds.me.id, authState.creds.me.lid || '', signalRepository, config);
        if (node.tag === 'status') {
            msg.key.isNewsletterStatus = true;
        }
        const alt = msg.key.participantAlt || msg.key.remoteJidAlt;
        // store new mappings we didn't have before
        if (!!alt) {
            const altServer = jidDecode(alt)?.server;
            const primaryJid = msg.key.participant || msg.key.remoteJid;
            if (altServer === 'lid') {
                if (!(await signalRepository.lidMapping.getPNForLID(alt))) {
                    await signalRepository.lidMapping.storeLIDPNMappings([{ lid: alt, pn: primaryJid }]);
                    await signalRepository.migrateSession(primaryJid, alt);
                }
            }
            else {
                await signalRepository.lidMapping.storeLIDPNMappings([{ lid: primaryJid, pn: alt }]);
                await signalRepository.migrateSession(alt, primaryJid);
            }
        }
        else {
            // proactive migration if we have a mapping but the current message didn't provide alt JID
            const primaryJid = msg.key.participant || msg.key.remoteJid;
            if (primaryJid && isPnUser(primaryJid)) {
                const lid = await signalRepository.lidMapping.getLIDForPN(primaryJid);
                if (lid) {
                    await signalRepository.migrateSession(primaryJid, lid);
                }
            }
        }
        if (msg.key?.remoteJid && msg.key?.id && messageRetryManager) {
            messageRetryManager.addRecentMessage(msg.key.remoteJid, msg.key.id, msg.message);
            logger.debug({
                jid: msg.key.remoteJid,
                id: msg.key.id
            }, 'Added message to recent cache for retry receipts');
        }
        // `acked` tracks whether sendMessageAck has run for this node within the
        // mutex body. The catch handler below uses it to decide whether to send
        // a NACK on uncaught error (without it, an early-throw before any ack
        // would silently drop the message and the server would retry forever).
        let acked = false;
        try {
            await messageMutex.mutex(async () => {
                await decrypt();
                // message failed to decrypt
                if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category !== 'peer') {
                    if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT) {
                        acked = true;
                        return sendMessageAck(node);
                    }
                    if (msg.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
                        // Message arrived without encryption (e.g. CTWA ads messages).
                        // Check if this is eligible for placeholder resend (matching WA Web filters).
                        const unavailableNode = getBinaryNodeChild(node, 'unavailable');
                        const unavailableType = unavailableNode?.attrs?.type;
                        if (unavailableType === 'bot_unavailable_fanout' ||
                            unavailableType === 'hosted_unavailable_fanout' ||
                            unavailableType === 'view_once_unavailable_fanout') {
                            logger.debug({ msgId: msg.key.id, unavailableType }, 'skipping placeholder resend for excluded unavailable type');
                            acked = true;
                            return sendMessageAck(node);
                        }
                        const messageAge = unixTimestampSeconds() - toNumber(msg.messageTimestamp);
                        if (messageAge > PLACEHOLDER_MAX_AGE_SECONDS) {
                            logger.debug({ msgId: msg.key.id, messageAge }, 'skipping placeholder resend for old message');
                            acked = true;
                            return sendMessageAck(node);
                        }
                        const cleanKey = {
                            remoteJid: msg.key.remoteJid,
                            fromMe: msg.key.fromMe,
                            id: msg.key.id,
                            participant: msg.key.participant
                        };
                        const msgData = {
                            key: msg.key,
                            messageTimestamp: msg.messageTimestamp,
                            pushName: msg.pushName,
                            participant: msg.participant,
                            verifiedBizName: msg.verifiedBizName
                        };
                        requestPlaceholderResend(cleanKey, msgData)
                            .then(requestId => {
                            if (requestId && requestId !== 'RESOLVED') {
                                logger.debug({ msgId: msg.key.id, requestId }, 'requested placeholder resend for unavailable message');
                                ev.emit('messages.update', [
                                    {
                                        key: msg.key,
                                        update: { messageStubParameters: [NO_MESSAGE_FOUND_ERROR_TEXT, requestId] }
                                    }
                                ]);
                            }
                        })
                            .catch(err => {
                            logger.warn({ err, msgId: msg.key.id }, 'failed to request placeholder resend for unavailable message');
                        });
                        acked = true;
                        await sendMessageAck(node);
                        // Don't return — fall through to upsertMessage so the stub is emitted
                    }
                    else {
                        // Skip retry for expired status messages (>24h old)
                        if (isJidStatusBroadcast(msg.key.remoteJid)) {
                            const messageAge = unixTimestampSeconds() - toNumber(msg.messageTimestamp);
                            if (messageAge > STATUS_EXPIRY_SECONDS) {
                                logger.debug({ msgId: msg.key.id, messageAge, remoteJid: msg.key.remoteJid }, 'skipping retry for expired status message');
                                acked = true;
                                return sendMessageAck(node);
                            }
                        }
                        const errorMessage = msg?.messageStubParameters?.[0] || '';
                        const isPreKeyError = errorMessage.includes('PreKey');
                        // Check for specific "No session found" or "No SenderKeyRecord found" error to trigger session reset
                        // Include "Bad MAC" and "Invalid PreKey" as they indicate session desync
                        const isSessionError = errorMessage.includes('No session found') ||
                            errorMessage.includes('No SenderKeyRecord found') ||
                            errorMessage.includes('Bad MAC') ||
                            errorMessage.includes('Invalid PreKey') ||
                            errorMessage.includes('InvalidMessageException') ||
                            errorMessage.includes('old counter');
                        logger.debug(`[handleMessage] Attempting retry request for failed decryption, isSessionError=${isSessionError}`);
                        (async () => {
                            try {
                                if (!ws.isOpen) {
                                    logger.debug({ node }, 'Connection closed, skipping retry');
                                    return;
                                }
                                // Handle pre-key errors with upload and delay
                                if (isPreKeyError) {
                                    logger.info({ error: errorMessage }, 'PreKey error detected, uploading and retrying');
                                    try {
                                        logger.debug('Uploading pre-keys for error recovery');
                                        await uploadPreKeys(5);
                                        logger.debug('Waiting for server to process new pre-keys');
                                        await delay(1000);
                                    }
                                    catch (uploadErr) {
                                        logger.error({ uploadErr }, 'Pre-key upload failed, proceeding with retry anyway');
                                    }
                                }
                                // Handle Session Errors by wiping session to force full re-negotiation
                                let forceIncludeKeys = false;
                                const retryKey = `${msg.key.id}:${msg.key.participant || node.attrs.participant || msg.key.remoteJid}`;
                                const retryCount = (await msgRetryCache.get(retryKey)) || 0;
                                // Parity with whatsmeow: force include keys if retry count > 1
                                if (retryCount >= 1) {
                                    forceIncludeKeys = true;
                                }
                                if (isSessionError) {
                                    try {
                                        const senderJid = msg.key.participant || node.attrs.participant || msg.key.remoteJid;
                                        if (senderJid && !isJidGroup(senderJid)) {
                                            const sessionId = signalRepository.jidToSignalProtocolAddress(senderJid);
                                            await authState.keys.set({ session: { [sessionId]: null } });
                                            // ALSO wipe the Sender Key Memory for this participant + group/broadcast (Legacy Fix)
                                            if (msg.key.remoteJid && (isJidGroup(msg.key.remoteJid) || isJidBroadcast(msg.key.remoteJid))) {
                                                const address = signalRepository.jidToSignalProtocolAddress(senderJid);
                                                const [name, device] = address.split('.');
                                                const senderKeyName = `${msg.key.remoteJid}::${name}::${device}`;
                                                await authState.keys.set({ 'sender-key': { [senderKeyName]: null } });
                                            }
                                            forceIncludeKeys = true;
                                        }
                                    }
                                    catch (sessErr) {
                                        logger.error({ sessErr }, 'Failed to wipe session for error recovery');
                                    }
                                }
                                const encNode = getBinaryNodeChild(node, 'enc');
                                await sendRetryRequest(node, !encNode || forceIncludeKeys);
                                if (retryRequestDelayMs) {
                                    await delay(retryRequestDelayMs);
                                }
                            }
                            catch (err) {
                                logger.error({ err, isPreKeyError }, 'Failed to handle retry, attempting basic retry');
                                // Still attempt retry even if pre-key upload failed
                                try {
                                    const encNode = getBinaryNodeChild(node, 'enc');
                                    await sendRetryRequest(node, !encNode);
                                }
                                catch (retryErr) {
                                    logger.error({ retryErr }, 'Failed to send retry after error handling');
                                }
                            }
                            await sendMessageAck(node, NACK_REASONS.UnhandledError);
                        })().catch(err => {
                            logger.error({ err }, 'Uncaught error in retry async block');
                        });
                    }
                }
                else {
                    if (messageRetryManager && msg.key.id) {
                        messageRetryManager.cancelPendingPhoneRequest(msg.key.id);
                    }
                    const isNewsletter = isJidNewsletter(msg.key.remoteJid);
                    if (!isNewsletter) {
                        // no type in the receipt => message delivered
                        let type = undefined;
                        let participant = msg.key.participant;
                        if (category === 'peer') {
                            // special peer message
                            type = 'peer_msg';
                        }
                        else if (msg.key.fromMe) {
                            // message was sent by us from a different device
                            type = 'sender';
                            // need to specially handle this case
                            if (isLidUser(msg.key.remoteJid) || isLidUser(msg.key.remoteJidAlt)) {
                                participant = author; // TODO: investigate sending receipts to LIDs and not PNs
                            }
                        }
                        else if (!sendActiveReceipts) {
                            type = 'inactive';
                        }
                        await sendReceipt(msg.key.remoteJid, participant, [msg.key.id], type);
                        // send ack for history message
                        const isAnyHistoryMsg = getHistoryMsg(msg.message);
                        if (isAnyHistoryMsg) {
                            const jid = jidNormalizedUser(msg.key.remoteJid);
                            await sendReceipt(jid, undefined, [msg.key.id], 'hist_sync'); // TODO: investigate
                        }
                    }
                    else {
                        acked = true;
                        await sendMessageAck(node);
                        logger.debug({ key: msg.key }, 'processed newsletter message without receipts');
                    }
                }
                if (msg.messageStubType !== proto.WebMessageInfo.StubType.CIPHERTEXT) {
                    // decrypt secret encrypted messages (e.g. message/event edits) and emit the
                    // decrypted content instead of the opaque secret envelope
                    if (msg.message?.secretEncryptedMessage) {
                        const secretEnc = msg.message.secretEncryptedMessage;
                        const decrypted = await decryptSecretEncryptedMessage(secretEnc, {
                            getMessage: config.getMessage,
                            signalRepository,
                            meId: authState.creds.me.id,
                            meLid: authState.creds.me.lid || undefined,
                            msgKey: msg.key,
                            logger
                        });
                        if (decrypted) {
                            // carry over messageContextInfo if the decrypted message lacks it
                            if (msg.message.messageContextInfo && !decrypted.messageContextInfo) {
                                decrypted.messageContextInfo = msg.message.messageContextInfo;
                            }
                            // rewrite a MESSAGE_EDIT to the plaintext protocolMessage shape so it emits
                            // messages.update (updates the original) instead of a fresh message
                            msg.message = rewriteSecretEditToProtocolMessage(decrypted, secretEnc);
                        }
                        // else: keep the raw secret message as-is (helper already logged a warning)
                    }
                    cleanMessage(msg, authState.creds.me.id, authState.creds.me.lid);
                    await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify');
                }
            });
        }
        catch (error) {
            logger.error({ error }, 'ERROR in handleMessage');
            if (!acked) {
                await sendMessageAck(node, NACK_REASONS.UnhandledError).catch(ackErr => logger.error({ ackErr }, 'failed to ack message after error'));
            }
        }
    };
    const handleCall = async (node) => {
        try {
            const { attrs } = node;
            const [infoChild] = getAllBinaryNodeChildren(node);
            if (!infoChild) {
                throw new Boom('Missing call info in call node');
            }
            const status = getCallStatusFromNode(infoChild);
            const callId = infoChild.attrs['call-id'];
            const from = infoChild.attrs.from || infoChild.attrs['call-creator'];
            const call = {
                chatId: attrs.from,
                from,
                callerPn: infoChild.attrs['caller_pn'],
                id: callId,
                date: new Date(+attrs.t * 1000),
                offline: !!attrs.offline,
                status
            };
            if (status === 'relaylatency') {
                const latencyValue = infoChild.attrs.latency || infoChild.attrs['latency_ms'] || infoChild.attrs['latency-ms'];
                const latencyMs = latencyValue ? Number(latencyValue) : undefined;
                if (Number.isFinite(latencyMs)) {
                    call.latencyMs = latencyMs;
                }
            }
            if (status === 'offer') {
                call.isVideo = !!getBinaryNodeChild(infoChild, 'video');
                call.isGroup = infoChild.attrs.type === 'group' || !!infoChild.attrs['group-jid'];
                call.groupJid = infoChild.attrs['group-jid'];
                await callOfferCache.set(call.id, call);
            }
            const existingCall = await callOfferCache.get(call.id);
            // use existing call info to populate this event
            if (existingCall) {
                call.isVideo = existingCall.isVideo;
                call.isGroup = existingCall.isGroup;
                call.callerPn = call.callerPn || existingCall.callerPn;
            }
            // delete data once call has ended
            if (status === 'reject' || status === 'accept' || status === 'timeout' || status === 'terminate') {
                await callOfferCache.del(call.id);
            }
            ev.emit('call', [call]);
        }
        catch (error) {
            logger.error({ error, node: binaryNodeToString(node) }, 'error in handling call');
        }
        finally {
            await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack call'));
        }
    };
    const handleBadAck = async ({ attrs }) => {
        const key = { remoteJid: attrs.from, fromMe: true, id: attrs.id };
        // WARNING: REFRAIN FROM ENABLING THIS FOR NOW. IT WILL CAUSE A LOOP
        // // current hypothesis is that if pash is sent in the ack
        // // it means -- the message hasn't reached all devices yet
        // // we'll retry sending the message here
        // if(attrs.phash) {
        // 	logger.info({ attrs }, 'received phash in ack, resending message...')
        // 	const msg = await getMessage(key)
        // 	if(msg) {
        // 		await relayMessage(key.remoteJid!, msg, { messageId: key.id!, useUserDevicesCache: false })
        // 	} else {
        // 		logger.warn({ attrs }, 'could not send message again, as it was not found')
        // 	}
        // }
        // error in acknowledgement,
        // device could not display the message
        if (attrs.error) {
            if (attrs.error === SERVER_ERROR_CODES.MessageAccountRestriction) {
                // 463 = 1:1 message missing privacy token (tctoken). Usually means the
                // account is restricted: WhatsApp blocks starting new chats but preserves
                // existing ones, since established chats already carry a tctoken.
                // WA Web prevents this client-side (disables the compose bar).
                // No retry — retrying counts as another "reach out" and worsens the restriction.
                logger.warn({ msgId: attrs.id, from: attrs.from }, 'error 463: message rejected — missing tctoken (will be available for next send)');
                // Auto-recover: issue our privacy token to the contact so the next
                // 1:1 send carries a tctoken. Deduped per target JID to avoid a
                // flood of issuance IQs when several messages fail 463 at once.
                const ackFrom = attrs.from;
                if (ackFrom && !inFlight463Recoveries.has(ackFrom)) {
                    inFlight463Recoveries.add(ackFrom);
                    void (async () => {
                        try {
                            // AB prop 14303 controls whether issuance targets the LID or the PN.
                            const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping);
                            const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping);
                            const issueJid = await resolveIssuanceJid(ackFrom, sock.serverProps.lidTrustedTokenIssueToLid, getLIDForPN, getPNForLID);
                            await getPrivacyTokens([issueJid], unixTimestampSeconds());
                            logger.debug({ from: ackFrom }, 'completed 463 token recovery issuance');
                        }
                        catch (err) {
                            logger.debug({ from: ackFrom, err: err?.message }, 'failed 463 token recovery issuance');
                        }
                        finally {
                            inFlight463Recoveries.delete(ackFrom);
                        }
                    })();
                }
            }
            else if (attrs.error === SERVER_ERROR_CODES.SmaxInvalid) {
                logger.warn({ msgId: attrs.id, from: attrs.from }, 'smax-invalid (479): stanza rejected by server — likely stale device session or malformed addressing');
            }
            else {
                logger.warn({ attrs }, 'received error in ack');
            }
            if (attrs.error === '479' && isJidGroup(key.remoteJid)) {
                const remoteJid = key.remoteJid;
                await authState.keys.set({
                    'sender-key-memory': {
                        [remoteJid]: null,
                        [`${remoteJid}:${authState.creds.me?.id}`]: null,
                        [`${remoteJid}:${authState.creds.me?.lid}`]: null
                    }
                });
                logger.info({ remoteJid }, 'cleared sender-key-memory due to 479 error');
            }
            ev.emit('messages.update', [
                {
                    key,
                    update: {
                        status: WAMessageStatus.ERROR,
                        messageStubParameters: [attrs.error]
                    }
                }
            ]);
            // resend the message with device_fanout=false, use at your own risk
            // if (attrs.error === '475') {
            // 	const msg = await getMessage(key)
            // 	if (msg) {
            // 		await relayMessage(key.remoteJid!, msg, {
            // 			messageId: key.id!,
            // 			useUserDevicesCache: false,
            // 			additionalAttributes: {
            // 				device_fanout: 'false'
            // 			}
            // 		})
            // 	}
            // }
        }
    };
    /// processes a node with the given function
    /// and adds the task to the existing buffer if we're buffering events
    const processNodeWithBuffer = async (node, identifier, exec) => {
        ev.buffer();
        await execTask();
        ev.flush();
        function execTask() {
            return exec(node, false).catch(err => onUnexpectedError(err, identifier));
        }
    };
    /**
     * whatsmeow a2381054: channel (newsletter) statuses are processed like newsletter
     * messages; any other top-level <status> is only acked (class=status).
     */
    const handleStatus = async (node) => {
        if (isJidNewsletter(node.attrs.from)) {
            await handleMessage(node);
            return;
        }
        await sendMessageAck(node);
    };
    const offlineNodeProcessor = makeOfflineNodeProcessor(new Map([
        ['message', handleMessage],
        ['call', handleCall],
        ['receipt', handleReceipt],
        ['notification', handleNotification],
        ['status', handleStatus]
    ]), {
        isWsOpen: () => ws.isOpen,
        onUnexpectedError,
        yieldToEventLoop: () => new Promise(resolve => setImmediate(resolve)),
        onNodeProcessed: () => offlineBatch.onBacklogProcessed()
    });
    // WA Web WAWebOfflineHandler (zapo 8be4b0b8): the pull loop holds its next request while more than one
    // window of offline stanzas waits here; socket.ts reports each offline stanza as it reaches the handlers
    offlineBatch.setBacklogCounter(() => offlineNodeProcessor.pending());
    const processNode = async (type, node, identifier, exec) => {
        // Fast path: ack and drop ignored JIDs before entering the buffer/queue
        const from = node.attrs.from;
        let ignoreJid = from;
        if (type === 'receipt' && from) {
            const attrs = node.attrs;
            const isLid = attrs.from.includes('lid');
            const isNodeFromMe = areJidsSameUser(attrs.participant || attrs.from, isLid ? authState.creds.me?.lid : authState.creds.me?.id);
            ignoreJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient;
        }
        if (ignoreJid && ignoreJid !== S_WHATSAPP_NET && shouldIgnoreJid(ignoreJid)) {
            await sendMessageAck(node, type === 'message' ? NACK_REASONS.UnhandledError : undefined);
            return;
        }
        const isOffline = !!node.attrs.offline;
        if (isOffline) {
            offlineNodeProcessor.enqueue(type, node);
        }
        else {
            await processNodeWithBuffer(node, identifier, exec);
        }
    };
    // recv a message
    ws.on('CB:message', async (node) => {
        await processNode('message', node, 'processing message', handleMessage);
    });
    ws.on('CB:call', async (node) => {
        await processNode('call', node, 'handling call', handleCall);
    });
    ws.on('CB:receipt', async (node) => {
        await processNode('receipt', node, 'handling receipt', handleReceipt);
    });
    ws.on('CB:notification', async (node) => {
        await processNode('notification', node, 'handling notification', handleNotification);
    });
    ws.on('CB:status', async (node) => {
        await processNode('status', node, 'handling status', handleStatus);
    });
    ws.on('CB:ack,class:message', (node) => {
        handleBadAck(node).catch(error => onUnexpectedError(error, 'handling bad ack'));
    });
    const onCall = async ([call]) => {
        if (!call) {
            return;
        }
        // missed call + group call notification message generation
        if (call.status === 'timeout' || (call.status === 'offer' && call.isGroup)) {
            const msg = {
                key: {
                    remoteJid: call.chatId,
                    id: call.id,
                    fromMe: false
                },
                messageTimestamp: unixTimestampSeconds(call.date)
            };
            if (call.status === 'timeout') {
                if (call.isGroup) {
                    msg.messageStubType = call.isVideo
                        ? WAMessageStubType.CALL_MISSED_GROUP_VIDEO
                        : WAMessageStubType.CALL_MISSED_GROUP_VOICE;
                }
                else {
                    msg.messageStubType = call.isVideo ? WAMessageStubType.CALL_MISSED_VIDEO : WAMessageStubType.CALL_MISSED_VOICE;
                }
            }
            else {
                msg.message = { call: { callKey: Buffer.from(call.id) } };
            }
            const protoMsg = proto.WebMessageInfo.fromObject(msg);
            await upsertMessage(protoMsg, call.offline ? 'append' : 'notify');
        }
    };
    /** dedupe in-flight 463 recovery token issuance by target JID */
    const inFlight463Recoveries = new Set();
    const onConnectionUpdate = ({ isOnline }) => {
        if (typeof isOnline !== 'undefined') {
            sendActiveReceipts = isOnline;
            logger.trace(`sendActiveReceipts set to "${sendActiveReceipts}"`);
            // Prune expired tctokens when coming online (at most once per 24h)
            if (isOnline) {
                pruneExpiredTcTokens().catch(err => logger.warn({ err }, 'failed to prune tctokens on connection online'));
            }
        }
    };
    ev.on('call', onCall);
    ev.on('connection.update', onConnectionUpdate);
    disposables.push(() => ev.off('call', onCall));
    disposables.push(() => ev.off('connection.update', onConnectionUpdate));
    // Clean up tctoken index timer on socket close
    disposables.push(() => {
        if (tcTokenIndexTimer) {
            clearTimeout(tcTokenIndexTimer);
            tcTokenIndexTimer = undefined;
        }
    });
    return {
        ...sock,
        sendMessageAck,
        sendRetryRequest,
        rejectCall,
        fetchMessageHistory,
        requestPlaceholderResend,
        messageRetryManager
    };
};
//# sourceMappingURL=messages-recv.js.map