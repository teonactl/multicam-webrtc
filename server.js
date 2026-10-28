'use strict';

// Server di segnalazione WebRTC "a stella": ogni telefono (ruolo "camera")
// apre una connessione peer-to-peer DIRETTA con il PC (ruolo "viewer") — il
// server qui serve solo a farli trovare e a scambiarsi offer/answer/ICE,
// non passa mai audio/video (quello viaggia P2P, su WiFi locale). Pensato
// per funzionare sulla stessa rete locale senza bisogno di un server TURN:
// se in futuro servirà coinvolgere telefoni fuori dalla LAN (es. 4G), va
// aggiunto un server TURN (es. coturn) e la sua config nel campo
// RTCPeerConnection iceServers di public/camera.html e public/viewer.html.
//
// HTTPS (anche solo autofirmato) non è opzionale qui: i browser mobili
// esistono "navigator.mediaDevices"/getUserMedia SOLO in un contesto sicuro
// (HTTPS, o localhost) — su un semplice http://<ip-lan> quell'API non
// esiste affatto (è il "navigator.mediaDevices is undefined" visto in
// test). Il certificato viene (ri)generato a ogni avvio con gli IP di rete
// CORRENTI come Subject Alternative Name, così resta valido anche se l'IP
// locale cambia da una sessione all'altra (comune col DHCP). È autofirmato:
// ogni telefono mostrerà un avviso di sicurezza la prima volta, da
// accettare manualmente ("Avanzate" → "Procedi comunque") — normale per un
// certificato non emesso da una CA pubblica, non è un problema del server.

const express = require('express');
const { WebSocketServer } = require('ws');
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const qrcode = require('qrcode-terminal');

const PORT = process.env.PORT || 8787;
const CERT_DIR = path.join(__dirname, 'certs');

function lanAddresses() {
    const out = [];
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces || []) {
            if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
        }
    }
    return out;
}

function ensureSelfSignedCert(addrs) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    const keyPath = path.join(CERT_DIR, 'key.pem');
    const certPath = path.join(CERT_DIR, 'cert.pem');

    const san = ['DNS:localhost', 'IP:127.0.0.1', ...addrs.map((a) => `IP:${a}`)].join(',');
    execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '365', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-subj', '/CN=multicam-webrtc',
        '-addext', `subjectAltName=${san}`,
    ], { stdio: 'ignore' });

    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

const addrs = lanAddresses();
const tls = ensureSelfSignedCert(addrs);

// Impostazioni dell'evento (fotocamera di default, se chiedere il
// microfono, sfocatura volti, ecc.) — pensate per essere decise UNA VOLTA
// dall'operatore (pagina admin.html, sul PC) e applicate a ogni telefono
// che apre camera.html da quel momento in poi. Persistite su disco così
// sopravvivono a un riavvio del server durante lo stesso evento.
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const DEFAULT_SETTINGS = {
    defaultFacingMode: 'environment', // 'environment' (posteriore) | 'user' (frontale)
    requireMicrophone: true,
    blurFaces: false,
    allowMultipleMixers: false, // di default un solo mixer alla volta (vedi il controllo su 'join' più sotto)
};

function loadSettings() {
    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
    } catch (_) {
        return { ...DEFAULT_SETTINGS };
    }
}

let settings = loadSettings();

function saveSettings() {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

const app = express();
app.use(express.json());

// Cookie di sessione minimale (un id casuale, niente firma/crittografia:
// non è un confine di sicurezza, serve solo a riconoscere "questo stesso
// browser" tra una richiesta HTTP e la connessione WebSocket che aprirà
// subito dopo) — assegnato alla prima richiesta se mancante, riusato dal
// browser su tutte le successive, WebSocket incluso (il browser manda
// sempre il Cookie anche nell'handshake di upgrade).
function parseCookies(header) {
    const out = {};
    for (const part of (header || '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

app.use((req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    req.sessionId = cookies.mcw_session;
    if (!req.sessionId) {
        req.sessionId = crypto.randomUUID();
        res.setHeader('Set-Cookie', `mcw_session=${req.sessionId}; Path=/; SameSite=Lax`);
    }
    next();
});

// Una volta che un mixer è attivo nella stanza, le pagine "di controllo"
// (scegliere cosa mandare in diretta, comporre il layout, cambiare le
// impostazioni) restano accessibili SOLO a chi è già quel mixer (stessa
// sessione) — chiunque altro (es. il telefono di un altro spettatore che
// prova a navigare oltre camera.html) viene rimandato lì. Se nessun mixer
// è ancora attivo, tutto resta aperto (serve poterci arrivare la prima
// volta per diventare il mixer). Con "allowMultipleMixers" attivo possono
// esserci più sessioni valide insieme, non solo una.
const PROTECTED_PAGES = ['/', '/index.html', '/viewer.html', '/compose.html', '/admin.html'];
app.get(PROTECTED_PAGES, (req, res, next) => {
    const room = 'main';
    const mixers = viewersIn(room);
    const isActiveMixer = mixers.some((c) => c.sessionId === req.sessionId);
    if (mixers.length > 0 && !isActiveMixer) {
        return res.redirect(302, '/camera.html');
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/settings', (_req, res) => res.json(settings));

app.post('/api/settings', (req, res) => {
    const body = req.body || {};
    // Whitelist esplicita dei campi noti invece di un merge cieco di
    // req.body: evita che un payload malformato (o in futuro malevolo,
    // se mai esposto oltre la LAN) inietti chiavi arbitrarie nel file.
    if (typeof body.defaultFacingMode === 'string' && ['environment', 'user'].includes(body.defaultFacingMode))
        settings.defaultFacingMode = body.defaultFacingMode;
    if (typeof body.requireMicrophone === 'boolean')
        settings.requireMicrophone = body.requireMicrophone;
    if (typeof body.blurFaces === 'boolean')
        settings.blurFaces = body.blurFaces;
    if (typeof body.allowMultipleMixers === 'boolean')
        settings.allowMultipleMixers = body.allowMultipleMixers;
    saveSettings();

    // I telefoni già collegati possono reagire subito (es. attivare/
    // disattivare la sfocatura senza ricaricare) — vedi camera.html.
    // facingMode invece richiede comunque di riaprire la fotocamera, non
    // lo si applica "a sorpresa" a chi sta già trasmettendo.
    for (const c of clients.values())
        if (c.role === 'camera') send(c.ws, { type: 'settings-updated', settings });

    res.json(settings);
});

const server = https.createServer(tls, app);
const wss = new WebSocketServer({ server, path: '/ws' });

// id incrementale per ogni client connesso (telecamera o mixer) — usato
// come indirizzo nei messaggi di segnalazione (campo "to"/"from").
let nextId = 1;
const clients = new Map(); // id -> { ws, role, name, room, sessionId }

function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function viewersIn(room) {
    return [...clients.values()].filter(c => c.role === 'viewer' && c.room === room);
}

wss.on('connection', (ws, req) => {
    const id = nextId++;
    // req è la richiesta HTTP di upgrade: porta con sé lo stesso Cookie
    // mandato dal browser per le pagine (vedi il middleware più sopra) —
    // è così che si riconosce "questa connessione WS appartiene alla
    // stessa sessione che sta già guardando viewer.html/compose.html".
    const sessionId = parseCookies(req.headers.cookie).mcw_session || null;
    clients.set(id, { ws, role: null, name: null, room: null, sessionId });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const me = clients.get(id);

        if (msg.type === 'join') {
            const role = msg.role === 'viewer' ? 'viewer' : 'camera';
            const room = (msg.room || 'main').toString().slice(0, 40);

            // Limite mixer: di default uno solo alla volta per stanza (per
            // evitare che due persone litighino su cosa mandare in diretta
            // senza saperlo) — configurabile da admin.html. Chi arriva in
            // più viene rifiutato esplicitamente (non registrato come
            // viewer) invece di essere connesso "a metà" e confuso dal non
            // vedere mai arrivare nessuna telecamera.
            if (role === 'viewer' && !settings.allowMultipleMixers && viewersIn(room).length > 0) {
                send(ws, { type: 'join-rejected', reason: 'mixer-limit' });
                return;
            }

            me.role = role;
            me.name = (msg.name || `Telefono ${id}`).toString().slice(0, 40);
            me.room = room;

            if (me.role === 'camera') {
                // Una telecamera che entra si annuncia a tutti i mixer già
                // collegati nella stessa stanza — saranno loro a iniziare
                // lo scambio offer/answer verso questo id.
                for (const v of viewersIn(me.room))
                    send(v.ws, { type: 'camera-joined', id, name: me.name });
            } else {
                // Un mixer che entra scopre le telecamere già presenti.
                for (const [camId, c] of clients)
                    if (c.role === 'camera' && c.room === me.room)
                        send(ws, { type: 'camera-joined', id: camId, name: c.name });
            }
            return;
        }

        // Messaggi di segnalazione WebRTC (offer/answer/ice-candidate):
        // vengono solo ri-inoltrati al destinatario indicato in "to",
        // aggiungendo "from" così chi riceve sa a quale peer rispondere.
        if (['offer', 'answer', 'ice-candidate'].includes(msg.type) && msg.to) {
            const target = clients.get(msg.to);
            if (target) send(target.ws, { ...msg, from: id });
        }
    });

    ws.on('close', () => {
        const me = clients.get(id);
        if (me && me.role === 'camera' && me.room) {
            for (const v of viewersIn(me.room))
                send(v.ws, { type: 'camera-left', id });
        }
        clients.delete(id);
    });
});

server.listen(PORT, () => {
    console.log(`\nServer avviato (HTTPS) sulla porta ${PORT}.\n`);
    console.log(`PC — apri qui per scegliere cosa fare: https://localhost:${PORT}/`);
    if (addrs.length === 0) {
        console.log('\nNessun indirizzo di rete locale trovato (sei connesso al WiFi?).');
        return;
    }
    console.log('\n(Il certificato è autofirmato: il browser mostrerà un avviso di sicurezza la prima volta — su "Avanzate"/"Dettagli" trovi "Procedi comunque", è normale.)');
    // Alcune schede di rete espongono più di un IPv4 (es. un residuo DHCP
    // sulla stessa interfaccia) — sono comunque la stessa macchina/rete, ne
    // basta uno solo per il QR: ne stampiamo più di uno solo se appartengono
    // a interfacce davvero diverse (es. WiFi + ethernet). Il certificato
    // copre comunque TUTTI gli indirizzi rilevati (vedi ensureSelfSignedCert),
    // quindi un indirizzo alternativo funziona comunque se serve a mano.
    const camUrl = `https://${addrs[0]}:${PORT}/camera.html`;
    console.log(`\nTelecamera (da aprire sui telefoni sulla stessa WiFi): ${camUrl}`);
    qrcode.generate(camUrl, { small: true });
    if (addrs.length > 1) {
        console.log(`\n(Rilevati anche altri indirizzi su questo PC: ${addrs.slice(1).join(', ')} — usali solo se il primo non funziona.)`);
    }
});
