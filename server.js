/* ==================================================================
   GEMİ TAKİP — Backend proxy
   · AISStream'e TEK bağlantı kurar (anahtar sunucuda gizli)
   · Bölgedeki gemileri "fleet" haritasında tutar
   · Bağlı tüm tarayıcılara 4 sn'de bir snapshot yayınlar (read-only)
   · Yalnız izinli statik dosyaları sunar (kaynak/sır sızmaz)
   Çalıştır:  AISSTREAM_KEY=xxx npm start
   ================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8090;
/* AIS anahtarı YALNIZCA ortam değişkeninden okunur (repoda anahtar yok).
   Yerelde/sunucuda:  AISSTREAM_KEY=... npm start   (bkz. .env.example) */
const AIS_KEY = process.env.AISSTREAM_KEY || '';
const DIR = __dirname;

/* İzlenen bölge: Arap Denizi/Hindistan + Kızıldeniz/Aden + Doğu Akdeniz/
   Ege/Marmara/Karadeniz — Hindistan↔Türkiye koridorunu kapsar. */
const BOXES = [
  [[2, 55], [25, 80]],
  [[10, 32], [31, 45]],
  [[30, 22], [47, 42]]
];

const FLEET_TTL = 15 * 60 * 1000;
const STATIC_TTL = 6 * 60 * 60 * 1000;
const fleet = new Map();          // mmsi -> { mmsi,lat,lng,sog,cog,heading,name,time }
const staticInfo = new Map();     // mmsi -> { destination,eta,imo,time }  (AIS tip 5)
let aisOpen = false;

/* ---------------- Statik sunucu (yalnız izinli dosyalar) ----------------
   Sadece bu üç dosya servis edilir; server.js / data.js / package.json /
   shipments.json / node_modules vb. ASLA dışarı sızmaz. */
const PUBLIC = {
  '/index.html': 'text/html; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/styles.css': 'text/css; charset=utf-8'
};

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  /* Uygulama dosyaları küçük ve sık güncellenir → önbellekleme.
     Cloudflare no-store'u sayar → deploy'lar anında yansır, bayat cache olmaz. */
  res.setHeader('Cache-Control', 'no-store, must-revalidate');

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('method not allowed'); return; }

  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok ' + fleet.size); return; }

  if (!Object.prototype.hasOwnProperty.call(PUBLIC, p)) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(path.join(DIR, p.slice(1)), (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': PUBLIC[p] });
    res.end(data);
  });
});

/* ---------------- Tarayıcı istemcileri (downstream, sadece dinler) ---------------- */
const wss = new WebSocketServer({ server, path: '/stream', maxPayload: 1024 });

function snapshot() {
  const vessels = [];
  for (const v of fleet.values()) {
    const s = staticInfo.get(v.mmsi);
    vessels.push(s ? Object.assign({}, v, { destination: s.destination || null, eta: s.eta || null, imo: s.imo || null }) : v);
  }
  return JSON.stringify({ type: 'fleet', source: aisOpen ? 'open' : 'down', now: Date.now(), vessels });
}
wss.on('connection', (ws) => {
  try { ws.send(snapshot()); } catch (e) {}
  ws.on('message', () => {});   // istemciden gelen veriyi yok say (read-only kanal)
});
setInterval(() => {
  const s = snapshot();
  wss.clients.forEach((c) => { if (c.readyState === 1) { try { c.send(s); } catch (e) {} } });
}, 4000);

/* eski konumları temizle */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of fleet) if (now - v.time > FLEET_TTL) fleet.delete(k);
  for (const [k, v] of staticInfo) if (now - v.time > STATIC_TTL) staticInfo.delete(k);
}, 30000);

/* ---------------- AISStream (upstream, tek bağlantı) ---------------- */
let retry = 0, timer = null;
function connectAIS() {
  if (!AIS_KEY) { console.warn('[AIS] AISSTREAM_KEY tanımlı değil — canlı veri kapalı. .env ver.'); return; }
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ APIKey: AIS_KEY, BoundingBoxes: BOXES }));
    aisOpen = true; retry = 0;
    console.log('[AIS] bağlandı, ' + BOXES.length + ' kutuya abone olundu');
  });
  ws.addEventListener('message', (ev) => {
    const txt = (typeof ev.data === 'string') ? ev.data : new TextDecoder().decode(ev.data);
    let d; try { d = JSON.parse(txt); } catch (e) { return; }
    const type = d.MessageType;
    const m = d.MetaData || {};
    /* AIS tip 5: geminin beyan ettiği hedef liman + ETA (ücretsiz) */
    if (type === 'ShipStaticData') {
      const sd = (d.Message && d.Message.ShipStaticData) || {};
      const mmsi = String(m.MMSI || sd.UserID || '');
      if (mmsi) staticInfo.set(mmsi, {
        destination: (sd.Destination || '').replace(/[@\s]+$/, '').trim().slice(0, 40),
        eta: sd.Eta || null, imo: sd.ImoNumber || null, time: Date.now()
      });
      return;
    }
    if (type !== 'PositionReport' && type !== 'StandardClassBPositionReport') return;
    const pr = (d.Message && d.Message[type]) || {};
    const mmsi = String(m.MMSI || pr.UserID || '');
    if (!mmsi) return;
    const lat = (m.latitude != null) ? m.latitude : pr.Latitude;
    const lng = (m.longitude != null) ? m.longitude : pr.Longitude;
    if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return;
    fleet.set(mmsi, {
      mmsi, lat, lng,
      sog: (pr.Sog != null && pr.Sog < 80) ? pr.Sog : null,   // 80+ kn = AIS hatalı/azami değer
      cog: (pr.Cog != null && pr.Cog < 360) ? pr.Cog : null,
      heading: (pr.TrueHeading != null && pr.TrueHeading < 360) ? pr.TrueHeading : null,
      name: (m.ShipName || '').trim().slice(0, 40),
      time: Date.now()
    });
  });
  ws.addEventListener('close', () => {
    aisOpen = false; retry = Math.min(retry + 1, 6);
    clearTimeout(timer); timer = setTimeout(connectAIS, 2000 * retry);
    console.log('[AIS] bağlantı kapandı, yeniden denenecek (' + retry + ')');
  });
  ws.addEventListener('error', () => { try { ws.close(); } catch (e) {} });
}
connectAIS();

server.listen(PORT, () => {
  console.log('────────────────────────────────────────────');
  console.log(' Gemi Takip sunucusu çalışıyor: http://localhost:' + PORT);
  console.log(' AIS anahtarı: ' + (AIS_KEY ? 'ENV ✓' : 'YOK — AISSTREAM_KEY ver (canlı veri kapalı)'));
  console.log('────────────────────────────────────────────');
});
