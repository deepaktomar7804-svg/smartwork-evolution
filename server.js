/**
 * SmartWork AI - Ultra-Fast WhatsApp Gateway (Baileys / Evolution-Compatible)
 * Handles QR Generation, Session Authentication, Message Sending, and Webhook Forwarding.
 */

const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || process.env.GATEWAY_PORT || 8080;
const AUTH_DIR = path.join(__dirname, 'auth_session');
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://smartwork-marketing.onrender.com/api/outreach/webhook';

let sock = null;
let qrCodeBase64 = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED | CONNECTING | CONNECTED
let connectedUser = null;

async function initWhatsApp() {
    connectionStatus = 'CONNECTING';
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state,
        browser: ['SmartWork AI Outreach', 'Chrome', '122.0.0.0'],
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeBase64 = await qrcode.toDataURL(qr);
            connectionStatus = 'CONNECTING';
            console.log('[GATEWAY] New QR Code generated.');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            connectionStatus = 'DISCONNECTED';
            qrCodeBase64 = null;
            connectedUser = null;
            console.log(`[GATEWAY] Connection closed (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(initWhatsApp, 5000);
            } else {
                console.log('[GATEWAY] Logged out. Session cleared.');
                if (fs.existsSync(AUTH_DIR)) {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                }
                setTimeout(initWhatsApp, 2000);
            }
        } else if (connection === 'open') {
            connectionStatus = 'CONNECTED';
            qrCodeBase64 = null;
            const userJid = sock.user?.id || '';
            const phone = userJid.split(':')[0] || userJid.split('@')[0];
            connectedUser = { phone, name: sock.user?.name || 'SmartWork Operator' };
            console.log(`[GATEWAY] WhatsApp successfully connected! User: ${phone}`);
        }
    });

    // Inbound Messages Webhook Forwarding
    sock.ev.on('messages.upsert', async (m) => {
        try {
            if (m.type !== 'notify') return;
            for (const msg of m.messages) {
                if (msg.key.fromMe) continue; // Skip messages sent by self

                const remoteJid = msg.key.remoteJid || '';
                if (remoteJid.endsWith('@g.us')) continue; // Skip group messages

                const cleanPhone = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
                const bodyText = msg.message?.conversation ||
                                 msg.message?.extendedTextMessage?.text ||
                                 msg.message?.imageMessage?.caption ||
                                 '';

                if (!bodyText) continue;

                console.log(`[GATEWAY] Inbound message from ${cleanPhone}: "${bodyText}"`);

                // Forward to SmartWork Webhook
                try {
                    await axios.post(WEBHOOK_URL, {
                        event: 'messages.upsert',
                        sender: cleanPhone,
                        message: bodyText,
                        timestamp: new Date().toISOString(),
                        pushName: msg.pushName || ''
                    }, { timeout: 10000 });
                } catch (whErr) {
                    console.error('[GATEWAY] Webhook forward error:', whErr.message);
                }
            }
        } catch (err) {
            console.error('[GATEWAY] Error processing incoming message:', err);
        }
    });
}

// REST APIs for Evolution & Custom Hub Integration

// Status routes (Evolution + Simple)
app.get(['/status', '/instance/connectionState/:instance', '/instance/fetchInstances'], (req, res) => {
    res.json({
        instance: {
            instanceName: req.params.instance || 'smartwork_outreach',
            state: connectionStatus === 'CONNECTED' ? 'open' : (connectionStatus === 'CONNECTING' ? 'connecting' : 'close'),
            user: connectedUser ? { id: connectedUser.phone, name: connectedUser.name } : null
        },
        status: connectionStatus,
        user: connectedUser,
        hasQr: !!qrCodeBase64
    });
});

// QR routes (Evolution + Simple)
app.get(['/qr', '/instance/connect/:instance'], (req, res) => {
    if (connectionStatus === 'CONNECTED') {
        return res.json({
            instance: { instanceName: req.params.instance || 'smartwork_outreach', state: 'open' },
            state: 'open',
            connected: true,
            user: connectedUser,
            base64: null,
            qr: null
        });
    }
    if (!qrCodeBase64) {
        return res.json({
            instance: { instanceName: req.params.instance || 'smartwork_outreach', state: 'connecting' },
            state: 'connecting',
            connected: false,
            base64: null,
            qr: null,
            message: 'Generating QR code, please retry in 2 seconds...'
        });
    }
    return res.json({
        instance: { instanceName: req.params.instance || 'smartwork_outreach', state: 'connecting' },
        state: 'connecting',
        connected: false,
        base64: qrCodeBase64,
        qrcode: { base64: qrCodeBase64 },
        qr: qrCodeBase64
    });
});

// Send Message routes (Evolution + Simple)
app.post(['/message/send', '/message/sendText/:instance'], async (req, res) => {
    try {
        const number = req.body.number || req.body.phone || req.body.to;
        const text = req.body.text || req.body.message || (req.body.textMessage && req.body.textMessage.text);
        if (!number || !text) {
            return res.status(400).json({ error: 'Both number and text are required.' });
        }
        if (connectionStatus !== 'CONNECTED' || !sock) {
            return res.status(503).json({ error: 'WhatsApp is not connected. Scan QR code first.' });
        }

        let cleanNum = String(number).replace(/\D/g, '');
        if (cleanNum.length === 10) {
            cleanNum = '91' + cleanNum;
        }
        const recipientJid = `${cleanNum}@s.whatsapp.net`;

        // Check if number exists on WhatsApp
        try {
            const checkResult = await sock.onWhatsApp(recipientJid);
            if (!checkResult || checkResult.length === 0 || !checkResult[0].exists) {
                console.log(`[GATEWAY] Number ${cleanNum} does NOT exist on WhatsApp.`);
                return res.json({ status: 'not_on_whatsapp', recipient: cleanNum, exists: false });
            }
        } catch (checkErr) {
            console.warn(`[GATEWAY] onWhatsApp verification check error:`, checkErr.message);
        }

        const sentResult = await sock.sendMessage(recipientJid, { text: String(text).trim() });
        console.log(`[GATEWAY] Message dispatched to ${cleanNum}`);
        return res.json({ status: 'sent', recipient: cleanNum, messageId: sentResult?.key?.id, exists: true });
    } catch (err) {
        console.error('[GATEWAY] Send error:', err);
        return res.status(500).json({ error: err.message });
    }
});

// Logout routes (Evolution + Simple)
app.all(['/logout', '/instance/logout/:instance', '/instance/delete/:instance'], async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        connectionStatus = 'DISCONNECTED';
        qrCodeBase64 = null;
        connectedUser = null;
        setTimeout(initWhatsApp, 1000);
        return res.json({ status: 'logged_out', message: 'Session cleared.' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`[GATEWAY] WhatsApp Gateway running on port ${PORT}`);
    initWhatsApp().catch(console.error);
});
