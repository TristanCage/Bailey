import NodeCache from '@cacheable/node-cache';
import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { DEFAULT_CACHE_TTLS, DEFAULT_ORIGIN, MEDIA_PATH_MAP, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js';
import { aggregateMessageKeysNotFromMe, assertMediaContent, assertMeId, bindWaitForEvent, buildTcTokenFromJid, resolveIssuanceJid, decryptMediaRetryData, downloadContentFromMessage, encodeNewsletterMessage, encodeSignedDeviceIdentity, encodeWAMessage, encryptMediaRetryRequest, extractDeviceJids, generateCsToken, generateMessageIDV2, generateParticipantHashV2, generateWAMessage, getMediaType, getRawMediaUploadData, getStatusCodeForMediaRetry, getUrlFromDirectPath, getWANewsletterUploadToServer, getWAUploadToServer, isTcTokenExpired, MessageRetryManager, normalizeMessageContent, parseAndInjectE2ESessions, prepareNewsletterMedia, resolveTcTokenJid, shouldSendNewTcToken, toBuffer, toPhashDeviceString, unixTimestampSeconds } from '../Utils/index.js';
import { getUrlInfo } from '../Utils/link-preview.js';
import { makeKeyedMutex, makeMutex } from '../Utils/make-mutex.js';
import { getMessageReportingToken, shouldIncludeReportingToken } from '../Utils/reporting-utils.js';
import { areJidsSameUser, getBinaryNodeChild, getBinaryNodeChildren, isHostedLidUser, isHostedPnUser, isJidGroup, isLidUser, isPnUser, jidDecode, jidEncode, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary/index.js';
import { USyncQuery, USyncUser } from '../WAUSync/index.js';
import { makeNewsletterSocket } from './newsletter.js';
export const makeMessagesSocket = (config) => {
    const { logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview, options: httpRequestOptions, patchMessageBeforeSending, cachedGroupMetadata, enableRecentMessageCache, maxMsgRetryCount } = config;
    const sock = makeNewsletterSocket(config);
    const { ev, authState, messageMutex, signalRepository, upsertMessage, query, fetchPrivacySettings, sendNode, groupMetadata, groupToggleEphemeral } = sock;
    const userDevicesCache = config.userDevicesCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
            useClones: false
        });
    /** Serializes writes to userDevicesCache across USync refresh and device-notification handling. */
    const devicesMutex = makeMutex();
    const peerSessionsCache = new NodeCache({
        stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES,
        useClones: false
    });
    // In-memory throttle for OUR tctoken issuance (one per 7-day bucket per contact).
    // MUST be in-memory: issuance is fire-and-forget AFTER the send transaction commits,
    // so a key-store write there inherits the committed transaction's async context and
    // is silently dropped (never flushed). Mirrors whatsmeow tcTokenSenderTS.
    const tcTokenSenderTsCache = new NodeCache({
        stdTTL: 4 * 604800, // ~28 days (4 tctoken buckets)
        useClones: false
    });
    // Initialize message retry manager if enabled
    const messageRetryManager = enableRecentMessageCache ? new MessageRetryManager(logger, maxMsgRetryCount) : null;
    // Prevent race conditions in Signal session encryption by user
    const encryptionMutex = makeKeyedMutex();
    let mediaConn;
    const refreshMediaConn = async (forceGet = false) => {
        // a failed media_conn query must not poison every later media request on this socket
        const media = await mediaConn?.catch(() => undefined);
        if (!media || forceGet || new Date().getTime() - media.fetchDate.getTime() > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await query({
                    tag: 'iq',
                    attrs: {
                        type: 'set',
                        xmlns: 'w:m',
                        to: S_WHATSAPP_NET
                    },
                    content: [{ tag: 'media_conn', attrs: {} }]
                });
                const mediaConnNode = getBinaryNodeChild(result, 'media_conn');
                // TODO: explore full length of data that whatsapp provides
                const node = {
                    hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
                        hostname: attrs.hostname,
                        maxContentLengthBytes: +attrs.maxContentLengthBytes
                    })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                };
                logger.debug('fetched media conn');
                return node;
            })();
        }
        return mediaConn;
    };
    /**
     * generic send receipt function
     * used for receipts of phone call, read, delivery etc.
     * */
    const sendReceipt = async (jid, participant, messageIds, type) => {
        if (!messageIds || messageIds.length === 0) {
            throw new Boom('missing ids in receipt');
        }
        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0]
            }
        };
        const isReadReceipt = type === 'read' || type === 'read-self';
        if (isReadReceipt) {
            node.attrs.t = unixTimestampSeconds().toString();
        }
        if (type === 'sender' && (isPnUser(jid) || isLidUser(jid))) {
            node.attrs.recipient = jid;
            node.attrs.to = participant;
        }
        else {
            node.attrs.to = jid;
            if (participant) {
                node.attrs.participant = participant;
            }
        }
        if (type) {
            node.attrs.type = type;
        }
        const remainingMessageIds = messageIds.slice(1);
        if (remainingMessageIds.length) {
            node.content = [
                {
                    tag: 'list',
                    attrs: {},
                    content: remainingMessageIds.map(id => ({
                        tag: 'item',
                        attrs: { id }
                    }))
                }
            ];
        }
        logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages');
        await sendNode(node);
    };
    /** Correctly bulk send receipts to multiple chats, participants */
    const sendReceipts = async (keys, type) => {
        const recps = aggregateMessageKeysNotFromMe(keys);
        for (const { jid, participant, messageIds } of recps) {
            await sendReceipt(jid, participant, messageIds, type);
        }
    };
    /** Bulk read messages. Keys can be from different chats & participants */
    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings();
        // based on privacy settings, we have to change the read type
        const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self';
        await sendReceipts(keys, readType);
    };
    /** Fetch all the devices we've to send a message to */
    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = [];
        if (!useCache) {
            logger.debug('not using cache for devices');
        }
        const toFetch = [];
        const jidsWithUser = jids
            .map(jid => {
            const decoded = jidDecode(jid);
            const user = decoded?.user;
            const device = decoded?.device;
            const isExplicitDevice = typeof device === 'number' && device >= 0;
            if (isExplicitDevice && user) {
                deviceResults.push({
                    user,
                    device,
                    jid
                });
                return null;
            }
            jid = jidNormalizedUser(jid);
            return { jid, user };
        })
            .filter(jid => jid !== null);
        let mgetDevices;
        if (useCache && userDevicesCache.mget) {
            const usersToFetch = jidsWithUser.map(j => j?.user).filter(Boolean);
            mgetDevices = await userDevicesCache.mget(usersToFetch);
        }
        const results = await Promise.all(jidsWithUser.map(async ({ jid, user }) => {
            if (useCache) {
                const devices = mgetDevices?.[user] || (userDevicesCache.mget ? undefined : await userDevicesCache.get(user));
                if (devices) {
                    const devicesWithJid = devices.map(d => ({
                        ...d,
                        jid: jidEncode(d.user, d.server, d.device)
                    }));
                    logger.trace({ user }, 'using cache for devices');
                    return devicesWithJid;
                }
            }
            return jid;
        }));
        for (const item of results) {
            if (typeof item === 'string') {
                toFetch.push(item);
            }
            else {
                deviceResults.push(...item);
            }
        }
        if (!toFetch.length) {
            return deviceResults;
        }
        const requestedLidUsers = new Set();
        for (const jid of toFetch) {
            if (isLidUser(jid) || isHostedLidUser(jid)) {
                const user = jidDecode(jid)?.user;
                if (user)
                    requestedLidUsers.add(user);
            }
        }
        const query = new USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol();
        for (const jid of toFetch) {
            query.withUser(new USyncUser().withId(jid)); // todo: investigate - the idea here is that <user> should have an inline lid field with the lid being the pn equivalent
        }
        const result = await sock.executeUSyncQuery(query);
        if (result) {
            // TODO: LID MAP this stuff (lid protocol will now return lid with devices)
            const lidResults = result.list.filter(a => !!a.lid);
            if (lidResults.length > 0) {
                logger.trace('Storing LID maps from device call');
                await signalRepository.lidMapping.storeLIDPNMappings(lidResults.map(a => ({ lid: a.lid, pn: a.id })));
                // Force-refresh sessions for newly mapped LIDs to align identity addressing
                try {
                    const lids = lidResults.map(a => a.lid);
                    if (lids.length) {
                        await assertSessions(lids);
                    }
                }
                catch (e) {
                    logger.warn({ e, count: lidResults.length }, 'failed to assert sessions for newly mapped LIDs');
                }
            }
            const extracted = extractDeviceJids(result?.list, authState.creds.me.id, authState.creds.me.lid, ignoreZeroDevices);
            const deviceMap = {};
            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || [];
                deviceMap[item.user]?.push(item);
            }
            // Process each user's devices as a group for bulk LID migration
            for (const [user, userDevices] of Object.entries(deviceMap)) {
                const isLidUser = requestedLidUsers.has(user);
                // Process all devices for this user
                for (const item of userDevices) {
                    const finalJid = isLidUser
                        ? jidEncode(user, item.server, item.device)
                        : jidEncode(item.user, item.server, item.device);
                    deviceResults.push({
                        ...item,
                        jid: finalJid
                    });
                    logger.debug({
                        user: item.user,
                        device: item.device,
                        finalJid,
                        usedLid: isLidUser
                    }, 'Processed device with LID priority');
                }
            }
            await devicesMutex.mutex(async () => {
                if (userDevicesCache.mset) {
                    // if the cache supports mset, we can set all devices in one go
                    await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })));
                }
                else {
                    for (const key in deviceMap) {
                        if (deviceMap[key])
                            await userDevicesCache.set(key, deviceMap[key]);
                    }
                }
            });
            const userDeviceUpdates = {};
            for (const [userId, devices] of Object.entries(deviceMap)) {
                if (devices && devices.length > 0) {
                    userDeviceUpdates[userId] = devices.map(d => d.device?.toString() || '0');
                }
            }
            if (Object.keys(userDeviceUpdates).length > 0) {
                try {
                    await authState.keys.set({ 'device-list': userDeviceUpdates });
                    logger.debug({ userCount: Object.keys(userDeviceUpdates).length }, 'stored user device lists for bulk migration');
                }
                catch (error) {
                    logger.warn({ error }, 'failed to store user device lists');
                }
            }
        }
        return deviceResults;
    };
    /**
     * Update Member Label
     */
    const updateMemberLabel = (jid, memberLabel) => {
        return relayMessage(jid, {
            protocolMessage: {
                type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
                memberLabel: {
                    label: memberLabel?.slice(0, 30),
                    labelTimestamp: unixTimestampSeconds()
                }
            }
        }, {
            additionalNodes: [
                {
                    tag: 'meta',
                    attrs: {
                        tag_reason: 'user_update',
                        appdata: 'member_tag'
                    },
                    content: undefined
                }
            ]
        });
    };
    const assertSessions = async (jids, force) => {
        let didFetchNewSession = false;
        const uniqueJids = [...new Set(jids)]; // Deduplicate JIDs
        const jidsRequiringFetch = [];
        logger.debug({ jids }, 'assertSessions call with jids');
        const sessionsToValidate = [];
        for (const jid of uniqueJids) {
            const signalId = signalRepository.jidToSignalProtocolAddress(jid);
            const cachedSession = peerSessionsCache.get(signalId);
            if (cachedSession !== undefined) {
                if (cachedSession && !force) {
                    continue; // Session exists in cache
                }
            }
            sessionsToValidate.push(jid);
        }
        if (sessionsToValidate.length > 0) {
            const validationResults = await signalRepository.validateSessions(sessionsToValidate);
            for (const jid of sessionsToValidate) {
                const result = validationResults[jid];
                const hasSession = !!result?.exists;
                const signalId = signalRepository.jidToSignalProtocolAddress(jid);
                peerSessionsCache.set(signalId, hasSession);
                if (hasSession && !force) {
                    continue;
                }
                jidsRequiringFetch.push(jid);
            }
        }
        if (jidsRequiringFetch.length) {
            // LID if mapped, otherwise original
            const wireJids = [
                ...jidsRequiringFetch.filter(jid => !!isLidUser(jid) || !!isHostedLidUser(jid)),
                ...((await signalRepository.lidMapping.getLIDsForPNs(jidsRequiringFetch.filter(jid => !!isPnUser(jid) || !!isHostedPnUser(jid)))) || []).map(a => a.lid)
            ];
            logger.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions');
            const result = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'encrypt',
                    type: 'get',
                    to: S_WHATSAPP_NET
                },
                content: [
                    {
                        tag: 'key',
                        attrs: {},
                        content: wireJids.map(jid => {
                            const attrs = { jid };
                            if (force)
                                attrs.reason = 'identity';
                            return { tag: 'user', attrs };
                        })
                    }
                ]
            });
            await parseAndInjectE2ESessions(result, signalRepository);
            didFetchNewSession = true;
            // Cache fetched sessions using wire JIDs
            for (const wireJid of wireJids) {
                const signalId = signalRepository.jidToSignalProtocolAddress(wireJid);
                peerSessionsCache.set(signalId, true);
            }
        }
        return didFetchNewSession;
    };
    /**
     * Send an arbitrary message to your own account (all your other devices), with
     * the `peer` category. Mirrors whatsmeow's SendMessage(ownID, msg, {Peer:true}).
     * Useful for app-state key resync, on-demand history sync, and other self-directed
     * protocol messages.
     */
    const sendPeerMessage = async (message, opts = {}) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated');
        }
        const meJid = jidNormalizedUser(authState.creds.me.id);
        return relayMessage(meJid, message, {
            additionalAttributes: {
                category: 'peer',
                push_priority: 'high_force',
                ...opts.additionalAttributes
            },
            additionalNodes: opts.additionalNodes
        });
    };
    const sendPeerDataOperationMessage = async (pdoMessage) => {
        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        };
        return sendPeerMessage(protocolMessage, {
            // Marks history-sync on-demand peer messages so the server skips push-notification
            // delivery for them; mirrors whatsmeow's send.preparePeerMessageNode (5465030).
            additionalAttributes: { privacy_sensitive: '1' },
            additionalNodes: [{ tag: 'meta', attrs: { appdata: 'default' } }]
        });
    };
    const createParticipantNodes = async (recipientJids, message, extraAttrs, dsmMessage) => {
        if (!recipientJids.length) {
            return { nodes: [], shouldIncludeDeviceIdentity: false };
        }
        const patched = await patchMessageBeforeSending(message, recipientJids);
        const patchedMessages = Array.isArray(patched)
            ? patched
            : recipientJids.map(jid => ({ recipientJid: jid, message: patched }));
        let shouldIncludeDeviceIdentity = false;
        const meId = authState.creds.me.id;
        const meLid = authState.creds.me?.lid;
        const meLidUser = meLid ? jidDecode(meLid)?.user : null;
        const encryptionPromises = patchedMessages.map(async ({ recipientJid: jid, message: patchedMessage }) => {
            try {
                if (!jid)
                    return null;
                let msgToEncrypt = patchedMessage;
                const { user: targetUser } = jidDecode(jid);
                const { user: ownPnUser } = jidDecode(meId);
                const ownLidUser = meLidUser;
                const isOwnUser = targetUser === ownPnUser || (ownLidUser && targetUser === ownLidUser);
                const isExactSenderDevice = jid === meId || (meLid && jid === meLid);
                if (isExactSenderDevice) {
                    return null;
                }
                if (dsmMessage) {
                    if (isOwnUser) {
                        msgToEncrypt = dsmMessage;
                        logger.debug({ jid, targetUser }, 'Using DSM for own device');
                    }
                }
                const bytes = encodeWAMessage(msgToEncrypt);
                const mutexKey = jid;
                const node = await encryptionMutex.mutex(mutexKey, async () => {
                    const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data: bytes });
                    if (type === 'pkmsg') {
                        shouldIncludeDeviceIdentity = true;
                    }
                    return {
                        tag: 'to',
                        attrs: { jid },
                        content: [
                            {
                                tag: 'enc',
                                attrs: { v: '2', type, ...(extraAttrs || {}) },
                                content: ciphertext
                            }
                        ]
                    };
                });
                return node;
            }
            catch (err) {
                logger.error({ jid, err }, 'Failed to encrypt for recipient');
                return null;
            }
        });
        const nodes = (await Promise.all(encryptionPromises)).filter(node => node !== null);
        if (recipientJids.length > 0 && nodes.length === 0) {
            throw new Boom('All encryptions failed', { statusCode: 500 });
        }
        return { nodes, shouldIncludeDeviceIdentity };
    };
    const getPrivacyTokens = async (jids, timestamp) => {
        const t = (timestamp ?? unixTimestampSeconds()).toString();
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'privacy'
            },
            content: [
                {
                    tag: 'tokens',
                    attrs: {},
                    content: jids.map(jid => ({
                        tag: 'token',
                        attrs: {
                            jid: jidNormalizedUser(jid),
                            t,
                            type: 'trusted_contact'
                        }
                    }))
                }
            ]
        });
        return result;
    };
    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList }) => {
        const meId = assertMeId(authState.creds);
        const meLid = authState.creds.me?.lid;
        msgId = msgId || generateMessageIDV2(meId);
        // Logging infrastructure for tracking relayMessage performance
        const shouldLog = process.env.BAILEYS_RELAY_LOGGING === 'true' || process.env.BAILEYS_RELAY_LOGGING === '1';
        const startMs = Date.now();
        const logSteps = [];
        const addLogStep = (name) => {
            if (shouldLog)
                logSteps.push({ name, time: Date.now() - startMs });
        };
        let isCompleted = false;
        const logDetailedCycle = (status) => {
            if (!shouldLog || isCompleted)
                return;
            const totalTime = Date.now() - startMs;
            logger.error({ msgId, jid, status, totalTime, steps: logSteps }, `relayMessage ${status}`);
        };
        const timeout = shouldLog ? setTimeout(() => logDetailedCycle('timeout'), 30000) : undefined;
        addLogStep('start');
        try {
            const isRetryResend = Boolean(participant?.jid);
            let shouldIncludeDeviceIdentity = isRetryResend;
            const statusJid = 'status@broadcast';
            let { user, server } = jidDecode(jid);
            const isPn = server === 's.whatsapp.net';
            // WA Web WAWebSendMsgCreateFanoutStanza (whatsmeow 4f8f64e0): a LID-migrated client sends 1:1
            // messages to the LID and names the phone number in peer_recipient_pn; PN chats stay PN.
            // Peer messages go to our own PN unless AB prop 24184 (default false) moves them to the LID
            // (WA Web WAWebUserPrefsMeUser.getMeDeviceForOutgoingPeerMessage).
            const isPeerCategory = additionalAttributes?.category === 'peer';
            const translatePnToLid = !isPeerCategory || sock.serverProps.peerMessageLidOutgoing;
            let peerRecipientPn;
            if (isPn && translatePnToLid && !isRetryResend && !isJidGroup(jid) && jid !== statusJid) {
                const lid = await signalRepository.lidMapping.getLIDForPN(jid);
                if (lid) {
                    const decoded = jidDecode(lid);
                    if (decoded) {
                        logger.debug({ pn: jid, lid }, 'translated PN to LID for message');
                        if (!isPeerCategory) {
                            peerRecipientPn = jidNormalizedUser(jid);
                        }
                        user = decoded.user;
                        server = decoded.server;
                        jid = lid;
                    }
                }
            }
            else if (server === 'lid' && !isPeerCategory && !isRetryResend) {
                const pn = await signalRepository.lidMapping.getPNForLID(jid);
                if (pn) {
                    peerRecipientPn = jidNormalizedUser(pn);
                }
            }
            addLogStep('jid_decode_and_lid_mapping');
            const isGroup = server === 'g.us';
            const isStatus = jid === statusJid;
            const isLid = server === 'lid';
            const isNewsletter = server === 'newsletter';
            const isGroupOrStatus = isGroup || isStatus;
            const finalJid = jid;
            msgId = msgId || generateMessageIDV2(meId);
            useUserDevicesCache = useUserDevicesCache !== false;
            useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus;
            const participants = [];
            const destinationJid = !isStatus ? finalJid : statusJid;
            const binaryNodeContent = [];
            const devices = [];
            let reportingMessage;
            const meMsg = {
                deviceSentMessage: {
                    destinationJid,
                    message
                },
                messageContextInfo: message.messageContextInfo
            };
            const extraAttrs = {};
            if (participant) {
                if (!isGroup && !isStatus) {
                    additionalAttributes = { ...additionalAttributes, device_fanout: 'false' };
                }
                const { user: decodedUser, device } = jidDecode(participant.jid);
                devices.push({
                    user: decodedUser,
                    device,
                    jid: participant.jid
                });
            }
            await authState.keys.transaction(async () => {
                // WA Web WAWebBackendJobsCommon.mediaTypeFromProtobuf (zapo 27ed73cd): unwrap view-once /
                // ephemeral / document-with-caption first, and send `gif` for gif-playback video
                const mediaType = getMediaType(normalizeMessageContent(message) ?? message);
                if (mediaType && ['image', 'video', 'gif', 'audio', 'ptt', 'document', 'sticker'].includes(mediaType)) {
                    extraAttrs['mediatype'] = mediaType;
                }
                if (isNewsletter) {
                    let patched = patchMessageBeforeSending ? await patchMessageBeforeSending(message, []) : message;
                    if (Array.isArray(patched)) {
                        patched = patched[0] || message;
                    }
                    // newsletter media messages require some specific cleaning to render correctly
                    const normalizedContent = normalizeMessageContent(patched);
                    const mediaType = normalizedContent ? getMediaType(normalizedContent) : '';
                    let mediaHandle;
                    if (mediaType) {
                        const mediaMessage = normalizedContent[`${mediaType}Message`];
                        if (mediaMessage && typeof mediaMessage === 'object') {
                            // if it's an encrypted media message, we need to convert it
                            if (mediaMessage.mediaKey) {
                                const stream = await downloadContentFromMessage(mediaMessage, mediaType);
                                const buffer = await toBuffer(stream);
                                const { message: converted, handle } = await prepareNewsletterMedia(buffer, {
                                    upload: getWANewsletterUploadToServer(config, refreshMediaConn),
                                    mediaTypeOverride: mediaType,
                                    logger
                                });
                                patched = converted;
                                mediaHandle = handle;
                                // copy over any caption/contextInfo/metadata from the original message
                                const newMediaMessage = patched[`${mediaType}Message`];
                                newMediaMessage.caption = mediaMessage.caption;
                                newMediaMessage.contextInfo = mediaMessage.contextInfo;
                                newMediaMessage.mimetype = mediaMessage.mimetype;
                                newMediaMessage.jpegThumbnail = mediaMessage.jpegThumbnail;
                                if (mediaType === 'audio' || mediaType === 'ptt') {
                                    newMediaMessage.ptt = !!mediaMessage.ptt;
                                    newMediaMessage.seconds = mediaMessage.seconds;
                                    newMediaMessage.waveform = mediaMessage.waveform;
                                }
                            }
                            // newsletter media often fails if sidecar or other metadata is present
                            delete mediaMessage.scansSidecar;
                            delete mediaMessage.scanLengths;
                            delete mediaMessage.streamingSidecar;
                            delete mediaMessage.qrUrl;
                            if (mediaMessage.mediaKey && !mediaHandle) {
                                throw new Boom('Encrypted media not supported in newsletters without conversion', { statusCode: 400 });
                            }
                        }
                    }
                    const bytes = encodeNewsletterMessage(patched);
                    const newsletterMediaTypes = ['image', 'video', 'audio', 'ptt', 'gif', 'sticker', 'document', 'url'];
                    const plaintextAttrs = (mediaType && newsletterMediaTypes.includes(mediaType)) ? { mediatype: mediaType } : {};
                    if (mediaHandle) {
                        additionalAttributes = { ...additionalAttributes, 'media_id': mediaHandle };
                    }
                    if (mediaType === 'reaction' && patched.reactionMessage) {
                        const reaction = patched.reactionMessage;
                        binaryNodeContent.push({
                            tag: 'reaction',
                            attrs: {
                                code: reaction.text || ''
                            }
                        });
                        // reactions also require the server_id in the message attribute
                        const serverId = reaction.key?.serverId;
                        if (serverId) {
                            additionalAttributes = { ...additionalAttributes, 'server_id': serverId };
                        }
                    }
                    else {
                        binaryNodeContent.push({
                            tag: 'plaintext',
                            attrs: plaintextAttrs,
                            content: bytes
                        });
                    }
                    const stanza = {
                        tag: 'message',
                        attrs: {
                            to: jid,
                            id: msgId,
                            type: getMessageType(patched),
                            ...(additionalAttributes || {})
                        },
                        content: binaryNodeContent
                    };
                    await sendNode(stanza);
                    return;
                }
                const msgContent = normalizeMessageContent(message);
                const isPoll = !!msgContent?.pollCreationMessage ||
                    !!msgContent?.pollCreationMessageV2 ||
                    !!msgContent?.pollCreationMessageV3 ||
                    !!msgContent?.pollUpdateMessage;
                if (isPoll || !!msgContent?.reactionMessage || !!msgContent?.pinInChatMessage || !!msgContent?.keepInChatMessage) {
                    extraAttrs['decrypt-fail'] = 'hide';
                }
                if (isGroupOrStatus && !isRetryResend) {
                    const groupData = await (async () => {
                        let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined;
                        if (groupData && Array.isArray(groupData?.participants)) {
                            logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata');
                        }
                        else if (!isStatus) {
                            groupData = await groupMetadata(jid);
                        }
                        addLogStep('group_metadata_resolve');
                        return groupData;
                    })();
                    const participantsList = groupData ? groupData.participants.map(p => p.id) : [];
                    if (isStatus && statusJidList) {
                        participantsList.push(...statusJidList);
                    }
                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false);
                    devices.push(...additionalDevices);
                    addLogStep('usync_devices_fetch');
                    logger.debug({ jid, participantsList: participantsList.length, deviceCount: devices.length }, 'group devices resolved');
                    if (groupData?.ephemeralDuration && groupData.ephemeralDuration > 0) {
                        additionalAttributes = {
                            ...additionalAttributes,
                            expiration: groupData.ephemeralDuration.toString()
                        };
                    }
                    const groupAddressingMode = additionalAttributes?.['addressing_mode'] || groupData?.addressingMode || 'lid';
                    const groupSenderIdentity = groupAddressingMode === 'lid' && meLid ? meLid : meId;
                    const senderKeyMemoryId = `${jid}:${groupSenderIdentity}`;
                    const phashList = devices.map(d => toPhashDeviceString(d.jid));
                    if (isGroup) {
                        additionalAttributes = {
                            ...additionalAttributes,
                            addressing_mode: groupAddressingMode,
                            phash: generateParticipantHashV2(phashList)
                        };
                        logger.debug({ jid, deviceCount: devices.length, phash: additionalAttributes.phash }, 'generated phash for group');
                    }
                    const senderKeyMap = await (async () => {
                        if (!participant && !isStatus) {
                            const result = await authState.keys.get('sender-key-memory', [senderKeyMemoryId]);
                            return result[senderKeyMemoryId] || {};
                        }
                        return {};
                    })();
                    const senderKeyRecipients = [];
                    for (const device of devices) {
                        const deviceJid = device.jid;
                        const hasKey = !!senderKeyMap[deviceJid];
                        const isExactSenderDevice = deviceJid === meId || (meLid && deviceJid === meLid);
                        if ((!hasKey || !!participant) &&
                            !isExactSenderDevice &&
                            !isHostedLidUser(deviceJid) &&
                            !isHostedPnUser(deviceJid) &&
                            device.device !== 99) {
                            senderKeyRecipients.push(deviceJid);
                        }
                    }
                    if (senderKeyRecipients.length) {
                        await assertSessions(senderKeyRecipients);
                    }
                    await authState.keys.transaction(async () => {
                        const patched = await patchMessageBeforeSending(message);
                        if (Array.isArray(patched)) {
                            throw new Boom('Per-jid patching is not supported in groups');
                        }
                        const bytes = encodeWAMessage(patched);
                        reportingMessage = patched;
                        logger.debug({ destinationJid, groupAddressingMode, groupSenderIdentity }, 'encrypting group message');
                        const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
                            group: destinationJid,
                            data: bytes,
                            meId: groupSenderIdentity
                        });
                        if (senderKeyRecipients.length) {
                            logger.debug({ senderKeyJids: senderKeyRecipients }, 'sending new sender key');
                            const senderKeyMsg = {
                                senderKeyDistributionMessage: {
                                    axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                                    groupId: destinationJid
                                }
                            };
                            const result = await createParticipantNodes(senderKeyRecipients, senderKeyMsg, extraAttrs);
                            shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity;
                            participants.push(...result.nodes);
                        }
                        binaryNodeContent.push({
                            tag: 'enc',
                            attrs: { v: '2', type: 'skmsg', ...extraAttrs },
                            content: ciphertext
                        });
                        // Update sender key memory with newly sent keys
                        for (const recipient of senderKeyRecipients) {
                            senderKeyMap[recipient] = true;
                        }
                        await authState.keys.set({ 'sender-key-memory': { [senderKeyMemoryId]: senderKeyMap } });
                    }, jid);
                }
                else {
                    // ADDRESSING CONSISTENCY: Match own identity to conversation context
                    // TODO: investigate if this is true
                    let ownId = meId;
                    if (isLid && meLid) {
                        ownId = meLid;
                        logger.debug({ to: jid, ownId }, 'Using LID identity for @lid conversation');
                    }
                    else {
                        logger.debug({ to: jid, ownId }, 'Using PN identity for @s.whatsapp.net conversation');
                    }
                    const { user: ownUser } = jidDecode(ownId);
                    if (!participant) {
                        const patchedForReporting = await patchMessageBeforeSending(message, [jid]);
                        reportingMessage = Array.isArray(patchedForReporting)
                            ? patchedForReporting.find(item => item.recipientJid === jid) || patchedForReporting[0]
                            : patchedForReporting;
                    }
                    if (!isRetryResend) {
                        const targetUserServer = isLid ? 'lid' : 's.whatsapp.net';
                        devices.push({
                            user: jidDecode(jid).user,
                            device: 0,
                            jid: jidEncode(jidDecode(jid).user, targetUserServer, 0)
                        });
                        if (user !== ownUser) {
                            const ownUserServer = isLid ? 'lid' : 's.whatsapp.net';
                            const ownUserForAddressing = isLid && meLid ? jidDecode(meLid).user : jidDecode(meId).user;
                            devices.push({
                                user: ownUserForAddressing,
                                device: 0,
                                jid: jidEncode(ownUserForAddressing, ownUserServer, 0)
                            });
                        }
                        if (additionalAttributes?.['category'] !== 'peer') {
                            // Clear placeholders and enumerate actual devices
                            devices.length = 0;
                            // Use conversation-appropriate sender identity
                            const senderIdentity = isLid && meLid
                                ? jidEncode(jidDecode(meLid)?.user, 'lid', undefined)
                                : jidEncode(jidDecode(meId)?.user, 's.whatsapp.net', undefined);
                            // Enumerate devices for sender and target with consistent addressing
                            const sessionDevices = await getUSyncDevices([senderIdentity, jid], !!useUserDevicesCache, false);
                            devices.push(...sessionDevices);
                            addLogStep('usync_devices_fetch');
                            logger.debug({
                                deviceCount: devices.length,
                                devices: devices.map(d => `${d.user}:${d.device}@${jidDecode(d.jid)?.server}`)
                            }, 'Device enumeration complete with unified addressing');
                        }
                    }
                    const allRecipients = [];
                    const meRecipients = [];
                    const otherRecipients = [];
                    const { user: mePnUser } = jidDecode(meId);
                    const { user: meLidUser } = meLid ? jidDecode(meLid) : { user: null };
                    for (const { user: deviceUser, jid: deviceJid } of devices) {
                        const isExactSenderDevice = deviceJid === meId || (meLid && deviceJid === meLid);
                        if (isExactSenderDevice) {
                            logger.debug({ jid: deviceJid, meId, meLid }, 'Skipping exact sender device (whatsmeow pattern)');
                            continue;
                        }
                        // Check if this is our device (could match either PN or LID user)
                        const isMe = deviceUser === mePnUser || deviceUser === meLidUser;
                        if (isMe) {
                            meRecipients.push(deviceJid);
                        }
                        else {
                            otherRecipients.push(deviceJid);
                        }
                        allRecipients.push(deviceJid);
                    }
                    await assertSessions(allRecipients);
                    const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = await Promise.all([
                        // For own devices: use DSM if available (1:1 chats only)
                        createParticipantNodes(meRecipients, meMsg || message, extraAttrs),
                        createParticipantNodes(otherRecipients, message, extraAttrs, meMsg)
                    ]);
                    participants.push(...meNodes);
                    participants.push(...otherNodes);
                    shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2;
                    addLogStep('encryption');
                }
                if (isRetryResend) {
                    const isParticipantLid = isLidUser(participant.jid);
                    const isMe = areJidsSameUser(participant.jid, isParticipantLid ? meLid : meId);
                    // On a group/status retry resend, re-embed the sender-key distribution
                    // message so a requester who lost our sender key can decrypt (#2506).
                    let messageToSend = message;
                    if (isGroupOrStatus) {
                        let groupSenderIdentity;
                        if (meLid && (await signalRepository.hasSenderKey({ group: destinationJid, meId: meLid }))) {
                            groupSenderIdentity = meLid;
                        }
                        else if (await signalRepository.hasSenderKey({ group: destinationJid, meId })) {
                            groupSenderIdentity = meId;
                        }
                        if (groupSenderIdentity) {
                            try {
                                const skdm = await signalRepository.getSenderKeyDistributionMessage({
                                    group: destinationJid,
                                    meId: groupSenderIdentity
                                });
                                messageToSend = {
                                    ...message,
                                    senderKeyDistributionMessage: {
                                        groupId: destinationJid,
                                        axolotlSenderKeyDistributionMessage: skdm
                                    }
                                };
                            }
                            catch (err) {
                                logger.warn({ err, jid: destinationJid }, 'failed to build SKDM for retry, sending without it');
                            }
                        }
                    }
                    const encodedMessageToSend = isMe
                        ? encodeWAMessage({
                            deviceSentMessage: {
                                destinationJid,
                                message: messageToSend
                            }
                        })
                        : encodeWAMessage(messageToSend);
                    const { type, ciphertext: encryptedContent } = await signalRepository.encryptMessage({
                        data: encodedMessageToSend,
                        jid: participant.jid
                    });
                    binaryNodeContent.push({
                        tag: 'enc',
                        attrs: {
                            v: '2',
                            type,
                            count: participant.count.toString()
                        },
                        content: encryptedContent
                    });
                }
                if (participants.length) {
                    if (additionalAttributes?.['category'] === 'peer') {
                        const peerNode = participants[0]?.content?.[0];
                        if (peerNode) {
                            binaryNodeContent.push(peerNode); // push only enc
                        }
                    }
                    else {
                        binaryNodeContent.push({
                            tag: 'participants',
                            attrs: {},
                            content: participants
                        });
                    }
                }
                const stanza = {
                    tag: 'message',
                    attrs: {
                        id: msgId,
                        to: jid,
                        type: getMessageType(message),
                        ...(peerRecipientPn ? { peer_recipient_pn: peerRecipientPn } : {}),
                        ...(additionalAttributes || {})
                    },
                    content: binaryNodeContent
                };
                // if the participant to send to is explicitly specified (generally retry recp)
                // ensure the message is only sent to that person
                // if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
                if (participant) {
                    if (isJidGroup(jid)) {
                        stanza.attrs.to = jid;
                        stanza.attrs.participant = participant.jid;
                    }
                    else if (areJidsSameUser(participant.jid, meId)) {
                        stanza.attrs.to = participant.jid;
                        stanza.attrs.recipient = jid;
                    }
                    else {
                        stanza.attrs.to = participant.jid;
                    }
                }
                if (shouldIncludeDeviceIdentity) {
                    ;
                    stanza.content.push({
                        tag: 'device-identity',
                        attrs: {},
                        content: encodeSignedDeviceIdentity(authState.creds.account, true)
                    });
                    logger.debug({ jid }, 'adding device identity');
                }
                if (!isNewsletter &&
                    !isRetryResend &&
                    reportingMessage?.messageContextInfo?.messageSecret &&
                    shouldIncludeReportingToken(reportingMessage)) {
                    try {
                        const encoded = encodeWAMessage(reportingMessage);
                        const reportingKey = {
                            id: msgId,
                            fromMe: true,
                            remoteJid: destinationJid,
                            participant: participant?.jid
                        };
                        const reportingNode = await getMessageReportingToken(encoded, reportingMessage, reportingKey);
                        if (reportingNode) {
                            ;
                            stanza.content.push(reportingNode);
                            logger.trace({ jid }, 'added reporting token to message');
                        }
                    }
                    catch (error) {
                        logger.warn({ jid, trace: error?.stack }, 'failed to attach reporting token');
                    }
                }
                const is1on1Send = !isGroup && !isRetryResend && !isStatus && !isNewsletter;
                // Resolve destination to LID for tctoken storage — matches Signal session key pattern
                const tcTokenJid = is1on1Send
                    ? await resolveTcTokenJid(destinationJid, signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping))
                    : destinationJid;
                const contactTcTokenData = is1on1Send ? await authState.keys.get('tctoken', [tcTokenJid]) : {};
                const existingTokenEntry = contactTcTokenData[tcTokenJid];
                let tcTokenBuffer = existingTokenEntry?.token;
                // Treat expired tokens the same as missing — clear the stored token; our
                // token is re-issued by the throttled fire-and-forget below when the bucket rolls.
                if (tcTokenBuffer?.length && isTcTokenExpired(existingTokenEntry?.timestamp)) {
                    logger.debug({ jid: destinationJid, timestamp: existingTokenEntry?.timestamp }, 'tctoken expired, will re-fetch');
                    tcTokenBuffer = undefined;
                    // Opportunistic cleanup: drop the expired token but KEEP senderTimestamp so the
                    // durable issuance throttle survives (matches buildTcTokenFromJid; else this contact
                    // re-issues once after the token expires).
                    try {
                        await authState.keys.set({
                            tctoken: {
                                [tcTokenJid]: existingTokenEntry?.senderTimestamp
                                    ? { senderTimestamp: existingTokenEntry.senderTimestamp }
                                    : null
                            }
                        });
                    }
                    catch {
                        /* ignore cleanup errors */
                    }
                }
                // AB prop 10518 (privacy_token_sending_on_all_1_on_1_messages) gates whether
                // we attach the tctoken to outbound 1:1 messages. Default true to avoid
                // server error 463 on accounts where the prop hasn't yet been pushed.
                if (tcTokenBuffer?.length && sock.serverProps.privacyTokenOn1to1) {
                    ;
                    stanza.content.push({
                        tag: 'tctoken',
                        attrs: {},
                        content: tcTokenBuffer
                    });
                }
                else if (is1on1Send && authState.creds.nctSalt?.length) {
                    // Fallback when no tctoken is available: attach a locally-derived
                    // cstoken so the send still carries a privacy token and doesn't count
                    // as a "reach out" (issue #2441). Mirrors whatsmeow's send path.
                    const csToken = await generateCsToken({
                        jid: destinationJid,
                        nctSalt: authState.creds.nctSalt,
                        getLIDForPN: signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
                    });
                    if (csToken?.length) {
                        ;
                        stanza.content.push({
                            tag: 'cstoken',
                            attrs: {},
                            content: csToken
                        });
                    }
                }
                if (additionalNodes && additionalNodes.length > 0) {
                    ;
                    stanza.content.push(...additionalNodes);
                }
                logger.debug({ msgId, destinationJid, participants: participants.length, devices: devices.length, meId, meLid }, 'sending message to devices');
                await sendNode(stanza);
                addLogStep('send_node');
                // Fire-and-forget: issue OUR token to the contact after send (WA Web sendTcToken).
                // Throttle to one issuance per 7-day bucket (WA Web tctoken_duration_sender=604800,
                // tctoken_num_buckets_sender=4). The last-issued time comes from a race-safe in-memory
                // stamp, falling back to the DURABLE senderTimestamp on the tctoken entry — WA Web
                // persists tcTokenSenderTimestamp on the Conversation record, so the throttle survives a
                // restart. The in-memory stamp sits on top and also prevents a rapid double-issue.
                const lastIssuedTs = tcTokenSenderTsCache.get(tcTokenJid) ?? existingTokenEntry?.senderTimestamp;
                // Server-corrected time: WA Web keys the tctoken issuance buckets to server time,
                // so a skewed local clock must not shift which 7-day bucket we consider current.
                const nowSeconds = Math.floor((sock.getServerTime?.() ?? Date.now()) / 1000);
                if (is1on1Send && shouldSendNewTcToken(lastIssuedTs, nowSeconds)) {
                    const issueTimestamp = nowSeconds;
                    // Stamp the in-memory cache SYNCHRONOUSLY (before the async IQ) so the very next send,
                    // even in the same tick, is suppressed. AB prop 14303 controls LID-vs-PN issuance target.
                    tcTokenSenderTsCache.set(tcTokenJid, issueTimestamp);
                    const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping);
                    const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping);
                    resolveIssuanceJid(destinationJid, sock.serverProps.lidTrustedTokenIssueToLid, getLIDForPN, getPNForLID)
                        .then(issueJid => getPrivacyTokens([issueJid], issueTimestamp))
                        .then(() => {
                        // Persist senderTimestamp DURABLY after a successful issue (WA Web merges
                        // tcTokenSenderTimestamp onto the chat record, regardless of token presence). MUST run
                        // OUTSIDE the committed send transaction, else the write lands in it and is dropped.
                        return authState.keys.exitTransaction?.(async () => {
                            const cur = (await authState.keys.get('tctoken', [tcTokenJid]))[tcTokenJid];
                            await authState.keys.set({
                                tctoken: { [tcTokenJid]: { ...cur, senderTimestamp: issueTimestamp } }
                            });
                        })?.catch((err) => logger.debug({ jid: destinationJid, err: err?.message }, 'failed to persist tctoken senderTimestamp'));
                    })
                        .catch(err => {
                        // Issuance IQ failed - drop the optimistic in-memory stamp so the next send retries
                        // instead of staying blocked for the whole bucket.
                        if (tcTokenSenderTsCache.get(tcTokenJid) === issueTimestamp) {
                            tcTokenSenderTsCache.del(tcTokenJid);
                        }
                        logger.debug({ jid: destinationJid, err: err?.message }, 'fire-and-forget tctoken issuance failed');
                    });
                }
                // Add message to retry cache if enabled
                if (messageRetryManager && !participant) {
                    messageRetryManager.addRecentMessage(destinationJid, msgId, message);
                }
            }, meId);
            isCompleted = true;
            clearTimeout(timeout);
            return msgId;
        }
        catch (error) {
            logDetailedCycle('failed');
            clearTimeout(timeout);
            throw error;
        }
    };
    const waUploadToServer = getWAUploadToServer(config, refreshMediaConn);
    const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update');
    /**
     * Delete media from WhatsApp servers at the given direct path.
     * Used for things like history-sync attachments that should be cleaned up
     * after processing. Mirrors whatsmeow's Client.DeleteMedia (02ec817).
     */
    const deleteMedia = async (appInfo, directPath, encFileHash, encHandle) => {
        // whatsmeow 6723e556: inline payloads leave nothing on the CDN
        if (!directPath) {
            return;
        }
        const mediaConn = await refreshMediaConn(false);
        const host = mediaConn.hosts[0]?.hostname;
        if (!host) {
            throw new Boom('No media host available');
        }
        // Strip any query string from the direct path before encoding
        const queryStart = directPath.indexOf('?');
        const cleanPath = queryStart > 0 ? directPath.slice(0, queryStart) : directPath;
        // WA Web WABase64UrlSafe.urlSafeBase64 / whatsmeow base64.URLEncoding: URL-safe alphabet, padding kept
        const token = Buffer.from(encFileHash).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
        const params = {
            token,
            d_md: Buffer.from(cleanPath).toString('base64url'),
            auth: mediaConn.auth
        };
        if (encHandle) {
            params.e_handle = encHandle;
        }
        // history/app-state blobs are deleted from their own /mms/<type> path (WA Web
        // WAWebMmsClientFormatHashUrl, whatsmeow mediaTypeToMMSType), not the upload path in MEDIA_PATH_MAP
        const mmsSegment = appInfo === 'md-msg-hist' || appInfo === 'md-app-state'
            ? appInfo
            : (MEDIA_PATH_MAP[appInfo] || `/mms/${appInfo}`).replace(/^\/mms\//, '');
        const url = `https://${host}/mms/${mmsSegment}/${token}?${new URLSearchParams(params).toString()}`;
        // Send the companion meta nonce for companion-uploaded media, matching whatsmeow (6723e55):
        // only when both the nonce and an encryption handle are present.
        const companionMetaNonce = authState.creds.companionMetaNonce;
        const headers = {
            Origin: DEFAULT_ORIGIN,
            Referer: `${DEFAULT_ORIGIN}/`
        };
        if (companionMetaNonce && encHandle) {
            headers.Companion_User_Secret = companionMetaNonce;
        }
        // the same proxy as media downloads (options.dispatcher) / uploads (undici-style fetchAgent), and bounded:
        // history blobs are deleted automatically, so a proxied or offline host must not leak or hang here
        const agentDispatcher = typeof config.fetchAgent?.dispatch === 'function' ? config.fetchAgent : undefined;
        const dispatcher = httpRequestOptions?.dispatcher ?? agentDispatcher;
        const response = await fetch(url, {
            ...(dispatcher ? { dispatcher } : {}),
            method: 'DELETE',
            headers,
            signal: AbortSignal.timeout(config.defaultQueryTimeoutMs ?? 60000)
        });
        if (!response.ok) {
            throw new Boom(`media delete failed: ${response.status} ${response.statusText}`, {
                statusCode: response.status
            });
        }
    };
    // WA Web (WAWebHandleHistorySyncChunk) / whatsmeow: delete a downloaded history blob once processed
    sock.setHistorySyncBlobProcessedHandler(notification => {
        deleteMedia('md-msg-hist', notification.directPath, notification.fileEncSha256, notification.encHandle || undefined).catch(err => logger.warn({ err }, 'failed to delete history sync media from server'));
    });
    return {
        ...sock,
        userDevicesCache,
        devicesMutex,
        assertSessions,
        getPrivacyTokens,
        relayMessage,
        sendReceipt,
        sendReceipts,
        readMessages,
        refreshMediaConn,
        waUploadToServer,
        deleteMedia,
        fetchPrivacySettings,
        sendPeerMessage,
        sendPeerDataOperationMessage,
        createParticipantNodes,
        getUSyncDevices,
        messageRetryManager,
        updateMemberLabel,
        updateMediaMessage: async (message) => {
            const content = assertMediaContent(message.message);
            const mediaKey = content.mediaKey;
            const meId = authState.creds.me.id;
            const node = encryptMediaRetryRequest(message.key, mediaKey, meId);
            let error = undefined;
            await Promise.all([
                sendNode(node),
                waitForMsgMediaUpdate(async (update) => {
                    const result = update.find((c) => c.key.id === message.key.id);
                    if (result) {
                        if (result.error) {
                            error = result.error;
                        }
                        else {
                            try {
                                const media = decryptMediaRetryData(result.media, mediaKey, result.key.id);
                                if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
                                    const resultStr = proto.MediaRetryNotification.ResultType[media.result];
                                    throw new Boom(`Media re-upload failed by device (${resultStr})`, {
                                        data: media,
                                        statusCode: getStatusCodeForMediaRetry(media.result) || 404
                                    });
                                }
                                content.directPath = media.directPath;
                                content.url = getUrlFromDirectPath(content.directPath);
                                logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful');
                            }
                            catch (err) {
                                error = err;
                            }
                        }
                        return true;
                    }
                })
            ]);
            if (error) {
                throw error;
            }
            ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }]);
            return message;
        },
        sendMessage: async (jid, content, options = {}) => {
            const userJid = authState.creds.me.id;
            if (typeof content === 'object' &&
                'disappearingMessagesInChat' in content &&
                typeof content['disappearingMessagesInChat'] !== 'undefined' &&
                isJidGroup(jid)) {
                const { disappearingMessagesInChat } = content;
                const value = typeof disappearingMessagesInChat === 'boolean'
                    ? disappearingMessagesInChat
                        ? WA_DEFAULT_EPHEMERAL
                        : 0
                    : disappearingMessagesInChat;
                await groupToggleEphemeral(jid, value);
            }
            else {
                const fullMsg = await generateWAMessage(jid, content, {
                    logger,
                    userJid,
                    getUrlInfo: text => getUrlInfo(text, {
                        thumbnailWidth: linkPreviewImageThumbnailWidth,
                        fetchOpts: {
                            timeout: 3000,
                            ...(httpRequestOptions || {})
                        },
                        logger,
                        uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
                    }),
                    //TODO: CACHE
                    getProfilePicUrl: sock.profilePictureUrl,
                    getCallLink: sock.createCallLink,
                    upload: waUploadToServer,
                    mediaCache: config.mediaCache,
                    options: config.options,
                    messageId: generateMessageIDV2(sock.user?.id),
                    ...options
                });
                const isEventMsg = 'event' in content && !!content.event;
                const isDeleteMsg = 'delete' in content && !!content.delete;
                const isEditMsg = 'edit' in content && !!content.edit;
                const isPinMsg = 'pin' in content && !!content.pin;
                const isPollMessage = 'poll' in content && !!content.poll;
                const additionalAttributes = {};
                const additionalNodes = [];
                // required for delete
                if (isDeleteMsg) {
                    // if the chat is a group, and I am not the author, then delete the message as an admin
                    if (isJidGroup(content.delete?.remoteJid) && !content.delete?.fromMe) {
                        additionalAttributes.edit = '8';
                    }
                    else {
                        additionalAttributes.edit = '7';
                    }
                }
                else if (isEditMsg) {
                    additionalAttributes.edit = '1';
                }
                else if (isPinMsg) {
                    additionalAttributes.edit = '2';
                }
                else if (isPollMessage) {
                    additionalNodes.push({
                        tag: 'meta',
                        attrs: {
                            polltype: 'creation'
                        }
                    });
                }
                else if (isEventMsg) {
                    additionalNodes.push({
                        tag: 'meta',
                        attrs: {
                            event_type: 'creation'
                        }
                    });
                }
                await relayMessage(jid, fullMsg.message, {
                    messageId: fullMsg.key.id,
                    useCachedGroupMetadata: options.useCachedGroupMetadata,
                    additionalAttributes,
                    statusJidList: options.statusJidList,
                    additionalNodes,
                    useUserDevicesCache: options.useUserDevicesCache
                });
                if (config.emitOwnEvents) {
                    process.nextTick(async () => {
                        await messageMutex.mutex(() => upsertMessage(fullMsg, 'append'));
                    });
                }
                return fullMsg;
            }
        }
    };
};
const getMessageType = (message) => {
    const normalizedMessage = normalizeMessageContent(message);
    if (!normalizedMessage) {
        return 'text';
    }
    if (normalizedMessage.reactionMessage || normalizedMessage.encReactionMessage) {
        return 'reaction';
    }
    if (normalizedMessage.pollCreationMessage ||
        normalizedMessage.pollCreationMessageV2 ||
        normalizedMessage.pollCreationMessageV3 ||
        normalizedMessage.pollUpdateMessage) {
        return 'poll';
    }
    if (normalizedMessage.eventMessage) {
        return 'event';
    }
    const mediaType = getMediaType(normalizedMessage);
    const blobTypes = ['image', 'video', 'gif', 'audio', 'ptt', 'sticker', 'document', 'product'];
    if (mediaType && blobTypes.includes(mediaType)) {
        return 'media';
    }
    return 'text';
};
//# sourceMappingURL=messages-send.js.map