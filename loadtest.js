'use strict';

// Test di carico sintetico: quante "telecamere" (finte, via il device
// fasullo di Chromium --use-fake-device-for-media-stream) il PC riesce a
// decodificare/visualizzare in contemporanea prima che la CPU saturi —
// senza bisogno di telefoni veri. Usa una ISTANZA DI SERVER TUTTA SUA
// (porta/stanza dedicate): non tocca mai il server "vero" che usi per un
// evento reale, anche se è acceso nello stesso momento.
//
// Uso: node loadtest.js [stage1,stage2,...]
// Esempio: node loadtest.js 2,4,6,8,10

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');

const TEST_PORT = 8790;
const STAGE_DURATION_MS = 15000; // quanto osservare la CPU per ogni numero di telecamere
const CHROMIUM = '/usr/bin/chromium';

const stages = (process.argv[2] || '2,4,6,8,10')
    .split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => n > 0);

function cpuSnapshot() {
    // /proc/stat: prima riga "cpu  user nice system idle iowait irq softirq ...",
    // aggregata su tutti i core — totale e idle bastano per calcolare l'uso %
    // nell'intervallo tra due letture, senza dipendenze esterne.
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const nums = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = nums[3] + (nums[4] || 0);
    const total = nums.reduce((a, b) => a + b, 0);
    return { idle, total };
}

function cpuPercentBetween(a, b) {
    const totalDelta = b.total - a.total;
    const idleDelta = b.idle - a.idle;
    if (totalDelta <= 0) return 0;
    return ((totalDelta - idleDelta) / totalDelta) * 100;
}

function spawnChromium(url, extraArgs = []) {
    return spawn(CHROMIUM, [
        '--headless=new',
        '--disable-gpu',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--ignore-certificate-errors',
        '--no-sandbox', // necessario per Chromium headless lanciato come processo figlio non privilegiato in molte configurazioni
        '--disable-dev-shm-usage',
        ...extraArgs,
        url,
    ], { stdio: 'ignore' });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitServerReady(url, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            execFileSync('curl', ['-sk', '-o', '/dev/null', '-w', '%{http_code}', url], { stdio: 'pipe' });
            return true;
        } catch (_) { /* non ancora pronto */ }
        await sleep(300);
    }
    return false;
}

async function main() {
    console.log(`Avvio un server di test isolato sulla porta ${TEST_PORT} (stanza separata, non tocca il tuo server reale)...`);
    const server = spawn('node', ['server.js'], {
        cwd: __dirname,
        env: { ...process.env, PORT: String(TEST_PORT) },
        stdio: 'ignore',
    });
    const ok = await waitServerReady(`https://localhost:${TEST_PORT}/viewer.html`);
    if (!ok) { console.error('Il server di test non ha risposto in tempo, interrompo.'); server.kill(); process.exit(1); }

    // Un visualizzatore headless riceve e decodifica DAVVERO tutti i flussi
    // (è il lato che ci interessa misurare: la decodifica multipla, non il
    // semplice invio) — altrimenti il test misurerebbe solo il costo di
    // codifica lato "telecamere", non il carico reale sul PC che fa da mixer.
    console.log('Avvio il visualizzatore headless (decodifica davvero tutti i flussi)...');
    const viewer = spawnChromium(`https://localhost:${TEST_PORT}/viewer.html`);
    await sleep(2000);

    const results = [];
    let cameraProcs = [];

    for (const n of stages) {
        console.log(`\n=== ${n} telecamere finte ===`);
        // Porta il numero di telecamere finte attive a `n` (ne aggiunge
        // rispetto allo stage precedente, non le riavvia tutte: più
        // realistico di un collegamento "a scatti" di un evento vero).
        while (cameraProcs.length < n) {
            const i = cameraProcs.length + 1;
            const url = `https://localhost:${TEST_PORT}/camera.html?autostart=1&name=${encodeURIComponent('Test-' + i)}`;
            cameraProcs.push(spawnChromium(url));
            await sleep(400); // scaglionato, come telefoni che si collegano uno dopo l'altro
        }

        await sleep(3000); // tempo per stabilizzare le connessioni WebRTC prima di misurare
        const before = cpuSnapshot();
        await sleep(STAGE_DURATION_MS);
        const after = cpuSnapshot();
        const cpuPct = cpuPercentBetween(before, after);
        console.log(`CPU totale di sistema durante questo stage: ${cpuPct.toFixed(1)}%`);
        results.push({ n, cpuPct });
    }

    console.log('\n--- Riepilogo ---');
    for (const r of results) console.log(`${String(r.n).padStart(3)} telecamere → CPU totale ~${r.cpuPct.toFixed(1)}%`);

    for (const p of cameraProcs) p.kill();
    viewer.kill();
    server.kill();
    await sleep(1000);
    console.log('\nFatto, tutto chiuso.');
}

main().catch((err) => { console.error(err); process.exit(1); });
