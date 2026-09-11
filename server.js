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

const PORT = process.env.PORT || 8080;
const AUTH_DIR = path.join(__dirname, 'auth_session');
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://smartwork-marketing.onrender.com/api/outreach/webhook';
const API_KEY = process.env.AUTHENTICATION_API_KEY || 'smartwork_secret_key_7804';

let sock = null;
let qrCodeBase64 = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED | CONNECTING | CONNECTED
let connectedPhone = null;

async function initWhatsApp() {
    connectionStatus = 'CONNECTING';
    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            auth: state,
            browser: ['SmartWork Marketing', 'Chrome', '122.0.0.0'],
            generateHighQualityLinkPreview: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCodeBase64 = await qrcode.toDataURL(qr);
                connectionStatus = 'CONNECTING';
                console.log('[EVOLUTION] New QR Code generated.');
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                connectionStatus = 'DISCONNECTED';
                qrCodeBase64 = null;
                connectedPhone = null;
                console.log(`[EVOLUTION] Connection closed (${statusCode}). Reconnecting: ${shouldReconnect}`);

                if (shouldReconnect) {
                    setTimeout(initWhatsApp, 5000);
                } else {
                    console.log('[EVOLUTION] Logged out. Clearing session.');
                    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
                    setTimeout(initWhatsApp, 2000);
                }
            } else if (connection === 'open') {
                connectionStatus = 'CONNECTED';
                qrCodeBase64 = null;
                const userJid = sock.user?.id || '';
                connectedPhone = userJid.split(':')[0] || userJid.split('@')[0];
                console.log(`[EVOLUTION] Connected to WhatsApp! Phone: ${connectedPhone}`);
            }
        });

        // Inbound message event
        sock.ev.on('messages.upsert', async (m) => {
            try {
                if (m.type !== 'notify') return;
                for (const msg of m.messages) {
                    if (msg.key.fromMe) continue;
                    const remoteJid = msg.key.remoteJid || '';
                    if (remoteJid.endsWith('@g.us')) continue;

                    const cleanPhone = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
                    const bodyText = msg.message?.conversation ||
                                     msg.message?.extendedTextMessage?.text ||
                                     msg.message?.imageMessage?.caption ||
                                     '';

                    if (!bodyText) continue;
                    console.log(`[EVOLUTION] Inbound reply from ${cleanPhone}: "${bodyText}"`);

                    // Forward to SmartWork Backend Webhook
                    try {
                        await axios.post(WEBHOOK_URL, {
                            event: 'messages.upsert',
                            sender: cleanPhone,
                            message: bodyText,
                            timestamp: new Date().toISOString(),
                            pushName: msg.pushName || ''
                        }, { timeout: 10000 });
                    } catch (whErr) {
                        console.error('[EVOLUTION] Webhook error:', whErr.message);
                    }
                }
            } catch (err) {
                console.error('[EVOLUTION] Message parse error:', err);
            }
        });
    } catch (err) {
        console.error('[EVOLUTION] Init error:', err);
        setTimeout(initWhatsApp, 5000);
    }
}

// Endpoints
app.get('/instance/connectionState/smartwork_outreach', (req, res) => {
    res.json({
        instance: {
            state: connectionStatus === 'CONNECTED' ? 'open' : (connectionStatus === 'CONNECTING' ? 'connecting' : 'close'),
            user: connectedPhone ? { id: connectedPhone } : null
        }
    });
});

app.get('/instance/connect/smartwork_outreach', (req, res) => {
    if (connectionStatus === 'CONNECTED') {
        return res.json({ state: 'open', connected: true, phone: connectedPhone });
    }
    if (!qrCodeBase64) {
        return res.json({ state: 'connecting', qrcode: { base64: null }, message: 'Generating QR code...' });
    }
    return res.json({
        state: 'connecting',
        qrcode: { base64: qrCodeBase64 },
        base64: qrCodeBase64
    });
});

// Check WhatsApp on Number + Send Text Message
app.post('/message/sendText/smartwork_outreach', async (req, res) => {
    try {
        const { number, text } = req.body;
        if (!number || !text) {
            return res.status(400).json({ error: 'Missing number or text' });
        }
        if (connectionStatus !== 'CONNECTED' || !sock) {
            return res.status(503).json({ error: 'WhatsApp not connected. Scan QR code first.', connected: false });
        }
        
        let cleanNum = number.replace(/\D/g, '');
        if (cleanNum.length === 10) cleanNum = '91' + cleanNum;
        const recipientJid = `${cleanNum}@s.whatsapp.net`;

        // 1. Verify if number exists on WhatsApp
        try {
            const [onWaCheck] = await sock.onWhatsApp(recipientJid);
            if (!onWaCheck || !onWaCheck.exists) {
                console.log(`[EVOLUTION] ${cleanNum} is NOT on WhatsApp.`);
                return res.status(200).json({
                    status: 'not_on_whatsapp',
                    exists: false,
                    phone: cleanNum,
                    message: 'Number does not have an active WhatsApp account.'
                });
            }
        } catch (checkErr) {
            console.warn(`[EVOLUTION] onWhatsApp check skipped/failed for ${cleanNum}:`, checkErr.message);
        }

        // 2. Dispatch message
        const sent = await sock.sendMessage(recipientJid, { text: text.trim() });
        console.log(`[EVOLUTION] Real WhatsApp message sent to ${cleanNum}! Message ID: ${sent?.key?.id}`);
        return res.json({
            status: 'sent',
            exists: true,
            messageId: sent?.key?.id,
            phone: cleanNum
        });
    } catch (err) {
        console.error('[EVOLUTION] Send error:', err);
        return res.status(500).json({ error: err.message, status: 'error' });
    }
});

app.delete('/instance/logout/smartwork_outreach', async (req, res) => {
    try {
        if (sock) await sock.logout();
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e) {}
        connectionStatus = 'DISCONNECTED';
        qrCodeBase64 = null;
        connectedPhone = null;
        setTimeout(initWhatsApp, 1000);
        return res.json({ status: 'SUCCESS', message: 'Logged out successfully.' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/', (req, res) => {
    res.json({
        service: 'SmartWork Evolution Gateway',
        status: connectionStatus,
        phone: connectedPhone,
        webhook: WEBHOOK_URL
    });
});

app.listen(PORT, () => {
    console.log(`[EVOLUTION] Gateway listening on port ${PORT}`);
    initWhatsApp().catch(console.error);
});
