/* ==================================================================
   GEMİ TAKİP — Motor
   · Boş açılır. Seçim ARAMA (konteyner/sefer/gemi → backend /shipment)
     ya da sağdaki listeden bir CANLI gemiye TIKLAMA ile olur.
   · Canlı konum sunucu (server.js) üzerinden AISStream'den gelir.
   · Telemetri odaktaki varlığa göre değişir; sevkiyatın kendi gemisi
     için yolculuk %'si, tıklanan rastgele gemi için canlı hız göstergesi.
   ================================================================== */

/* ------------------ Sabitler / yardımcılar ------------------ */
const MS_DAY = 86400000;
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const TR_M = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
const R_KM = 6371;
const KM_PER_NM = 1.852;

const toRad = (x) => x * Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const parseDate = (s) => new Date(s + 'T00:00:00Z');
const fmtLong = (d) => MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
const fmtTr = (d) => d.getUTCDate() + ' ' + TR_M[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
const pad = (n) => String(n).padStart(2, '0');
const fmtShort = (d) => pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
const $ = (id) => document.getElementById(id);
/* HTML kaçışı — innerHTML'e giren TÜM dış/kullanıcı verisi için (XSS koruması).
   AIS gemi adı/hedef, paylaşılan link verisi, sevkiyat alanları saldırgan kontrolünde olabilir. */
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

function haversineKm(a, b) {
  const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
  const la1 = toRad(a[0]), la2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}
function buildRoute(pts) {
  const segs = []; let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = haversineKm(pts[i], pts[i + 1]) || 1e-4;
    segs.push({ a: pts[i], b: pts[i + 1], d, s: total });
    total += d;
  }
  return { pts, segs, total };
}
function posAt(rt, f) {
  f = clamp(f, 0, 1);
  const t = f * rt.total;
  for (const sg of rt.segs) {
    if (t <= sg.s + sg.d) {
      const u = sg.d ? (t - sg.s) / sg.d : 0;
      return [sg.a[0] + (sg.b[0] - sg.a[0]) * u, sg.a[1] + (sg.b[1] - sg.a[1]) * u];
    }
  }
  const L = rt.pts[rt.pts.length - 1];
  return [L[0], L[1]];
}
function densify(rt, n) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push(posAt(rt, i / n));
  return out;
}
function routeFracNearest(ll) {
  if (!S || !S.dense) return 0;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < S.dense.length; i++) {
    const d = haversineKm(ll, S.dense[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best / (S.dense.length - 1);
}
function bearing(a, b) {
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
            Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function fmtAge(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' sn';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' dk';
  return Math.round(m / 60) + ' sa';
}
function fmtCoord(lat, lng) {
  return Math.abs(lat).toFixed(2) + '°' + (lat >= 0 ? 'N' : 'S') + '  ' +
         Math.abs(lng).toFixed(2) + '°' + (lng >= 0 ? 'E' : 'W');
}
/* AIS tip 5 ETA: {Month,Day,Hour,Minute} → "DD.MM HH:MM" */
function fmtAisEta(eta) {
  if (!eta || !eta.Month || !eta.Day) return null;
  const hh = (eta.Hour != null && eta.Hour < 24) ? pad(eta.Hour) : '00';
  const mm = (eta.Minute != null && eta.Minute < 60) ? pad(eta.Minute) : '00';
  return pad(eta.Day) + '.' + pad(eta.Month) + ' ' + hh + ':' + mm;
}
/* Paylaşılabilir link için UTF-8 güvenli base64url (Türkçe karakter desteği) */
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ''; bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(str); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
/* Sevkiyat şeması doğrulaması — paylaşılan link / dış veri için savunma. */
function okPortObj(p) {
  return p && typeof p === 'object' && typeof p.lat === 'number' && typeof p.lng === 'number' &&
    isFinite(p.lat) && isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && typeof p.short === 'string';
}
function validShipment(o) {
  if (!o || typeof o !== 'object') return false;
  if (typeof o.containerNo !== 'string' || !o.containerNo.trim() || o.containerNo.length > 64) return false;
  if (!okPortObj(o.portOfLoading) || !okPortObj(o.portOfDischarge)) return false;
  if (!Array.isArray(o.route) || o.route.length < 2 ||
      o.route.some((c) => !Array.isArray(c) || c.length < 2 || !isFinite(c[0]) || !isFinite(c[1]))) return false;
  if (o.timeline && !Array.isArray(o.timeline)) return false;
  return true;
}

/* ------------------ Dünya küresi ------------------ */
const world = Globe()(document.getElementById('globe'))
  .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
  .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
  .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
  .atmosphereColor('#5b8cff').atmosphereAltitude(0.2)
  .width(window.innerWidth).height(window.innerHeight)
  .pathPoints('coords').pathPointLat((p) => p[0]).pathPointLng((p) => p[1])
  .pathColor((d) => d.color).pathStroke((d) => d.stroke).pathPointAlt(0.006)
  .pathDashLength((d) => d.dashLen).pathDashGap((d) => d.dashGap).pathDashAnimateTime((d) => d.dashAnim)
  .pathTransitionDuration(0)
  .ringLat('lat').ringLng('lng').ringColor((d) => d.ringColor)
  .ringMaxRadius('maxR').ringPropagationSpeed('speed').ringRepeatPeriod('period')
  .pointLat('lat').pointLng('lng').pointColor('color').pointAltitude('alt').pointRadius('r')
  .pointsMerge(true).pointsTransitionDuration(0)
  .labelLat('lat').labelLng('lng').labelText('text').labelColor('color')
  .labelSize('size').labelDotRadius('dot').labelAltitude('alt').labelResolution(2)
  .labelIncludeDot((d) => d.dot > 0).labelsTransitionDuration(0);

world.controls().enableDamping = true;
world.controls().dampingFactor = 0.12;
world.pointOfView({ lat: 25, lng: 48, altitude: 2.7 }, 0);   // nötr başlangıç görünümü

let userRotate = true;
function setRotate(v) { userRotate = v; $('rotateBtn').classList.toggle('active', v); }
world.controls().addEventListener('start', () => { if (userRotate) setRotate(false); });

window.addEventListener('resize', () => world.width(window.innerWidth).height(window.innerHeight));

/* ------------------ Durum ------------------ */
let S = null;              // aktif sevkiyat (null = boş)
let focusMmsi = null;      // tıklanarak izlenen gemi (null = sevkiyatın kendi gemisi)
let playing = false;
let following = false;
let speedMult = 1.0;
let showFleetDots = true;
let trail = [];            // izlenen geminin hareket izi (snapshot'lardan birikir)
const BASE_SPEED = 1 / 26;

/* Sevkiyatlar her kullanıcıya özel: tarayıcının localStorage'ında saklanır
   (üyelik sistemi yok). Sunucu paylaşılmaz, böylece kullanıcılar birbirini görmez. */
const STORE_KEY = 'gemi_shipments_v1';
function loadStore() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } }
function saveStore() { localStorage.setItem(STORE_KEY, JSON.stringify(STORE)); }
let STORE = loadStore();
function storeIndex() {
  const idx = {}; const add = (k, key) => { if (k && !(String(k).toUpperCase() in idx)) idx[String(k).toUpperCase()] = key; };
  for (const key in STORE) { const s = STORE[key]; add(s.containerNo, key); add(s.bookingNo, key); add(s.vessel, key); add(s.mmsi, key); add(s.imo, key); }
  return idx;
}

/* ==================================================================
   Canlı veri — backend sunucusu (server.js) snapshot'ları
   ================================================================== */
const AIS = { ws: null, status: 'idle', fleet: {}, source: 'down', retry: 0, timer: null };
const FLEET_MAX = 700;

function backendWs() {
  if (location.protocol === 'file:') return 'ws://localhost:8090/stream';
  return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/stream';
}
function aisConnect() {
  try { if (AIS.ws) { AIS.ws.onclose = null; AIS.ws.close(); } } catch (e) {}
  AIS.status = 'connecting'; updateAisUI();
  let ws;
  try { ws = new WebSocket(backendWs()); }
  catch (e) { AIS.status = 'error'; updateAisUI(); return; }
  AIS.ws = ws;
  ws.onopen = () => { AIS.status = 'open'; AIS.retry = 0; updateAisUI(); };
  ws.onmessage = (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.type !== 'fleet') return;
    const f = {};
    (d.vessels || []).forEach((v) => { v._age = Math.max(0, d.now - v.time); f[v.mmsi] = v; });
    AIS.fleet = f; AIS.source = d.source;
    /* izlenen geminin hareket izini biriktir */
    if (focusMmsi && f[focusMmsi]) {
      const v = f[focusMmsi], last = trail[trail.length - 1];
      if (!last || Math.abs(last[0] - v.lat) > 1e-4 || Math.abs(last[1] - v.lng) > 1e-4) {
        trail.push([v.lat, v.lng]); if (trail.length > 300) trail.shift();
      }
    }
    if (activeLive() && !centeredOnce) { centeredOnce = true; centerOnLive(); }
    updateAisUI();
  };
  ws.onerror = () => { AIS.status = 'error'; updateAisUI(); };
  ws.onclose = () => {
    AIS.status = 'closed'; updateAisUI();
    AIS.retry = Math.min(AIS.retry + 1, 6);
    clearTimeout(AIS.timer); AIS.timer = setTimeout(aisConnect, 2000 * AIS.retry);
  };
}
let centeredOnce = false;

/* Sevkiyatın KENDİ gemisi canlı mı? (MMSI ya da isim eşleşmesi) */
function ownLive() {
  if (!S) return null;
  if (AIS.fleet[S.raw.mmsi]) return AIS.fleet[S.raw.mmsi];
  const want = (S.raw.vessel || '').toUpperCase();
  for (const k in AIS.fleet) if ((AIS.fleet[k].name || '').toUpperCase() === want) return AIS.fleet[k];
  return null;
}
/* Odaktaki canlı gemi: tıklanan (focusMmsi) ya da sevkiyatın kendi gemisi */
function activeLive() {
  if (focusMmsi) return AIS.fleet[focusMmsi] || null;
  return ownLive();
}
/* Odaktaki gemi, sevkiyatın kendi yolculuğunun gemisi mi? */
function isVoyageVessel() {
  if (!S) return false;
  const lv = activeLive(); if (!lv) return true;
  if (!focusMmsi) return true;
  return String(focusMmsi) === String(S.raw.mmsi) ||
         (lv.name || '').toUpperCase() === (S.raw.vessel || '').toUpperCase();
}
function fleetCount() { return Object.keys(AIS.fleet).length; }

function centerOnLive() {
  const lv = activeLive(); if (!lv) return;
  const pov = world.pointOfView();
  world.pointOfView({ lat: lv.lat, lng: lv.lng, altitude: Math.min(pov.altitude, 2.0) }, 1200);
}

/* ------------------ AIS kart arayüzü ------------------ */
function updateAisUI() {
  const live = (AIS.status === 'open' && AIS.source === 'open');
  $('aisDot').className = 'ais-dot' + (
    live ? ' open' :
    (AIS.status === 'open' || AIS.status === 'connecting' || AIS.status === 'closed') ? ' connecting' : ' error');

  const lv = activeLive();
  const n = fleetCount();
  let txt;
  if (AIS.status === 'connecting') txt = 'Sunucuya bağlanılıyor…';
  else if (AIS.status === 'error' || AIS.status === 'closed') txt = 'Sunucu kapalı · (node server.js)';
  else if (AIS.source !== 'open') txt = 'Sunucu bağlı · AIS akışı bekleniyor';
  else if (lv) txt = 'İzlenen gemi CANLI';
  else if (n > 0) txt = 'Sunucu bağlı · ' + n + ' canlı gemi';
  else txt = 'Sunucu bağlı · veri bekleniyor';
  $('aisStatusText').textContent = txt;

  $('aisVessel').textContent = lv ? (lv.name || ('MMSI ' + lv.mmsi)) : (S ? S.raw.vessel : '—');
  $('aisMmsi').textContent = lv ? lv.mmsi : (S ? (S.raw.mmsi || '—') : '—');
  $('aisImo').textContent = (S && S.vessel && isVoyageVessel()) ? S.vessel.imo : '—';
  const ageEl = $('aisAge');
  if (lv) { ageEl.textContent = fmtAge(lv._age != null ? lv._age : 0) + ' önce'; ageEl.classList.add('live'); }
  else { ageEl.textContent = '—'; ageEl.classList.remove('live'); }
}

/* ------------------ Sevkiyat yükle (backend'den gelen kayıt) ------------------ */
function loadShipment(raw, vessel) {
  const rt = buildRoute(raw.route);
  const N = 260;
  const dense = densify(rt, N);
  const totalNm = rt.total / KM_PER_NM;
  const dep = parseDate(raw.departure);
  const arr = parseDate(raw.arrival);
  const durDays = Math.max(1, (arr - dep) / MS_DAY);
  const avgKnots = totalNm / (durDays * 24);

  S = { raw, vessel: vessel || null, rt, N, dense, totalNm, dep, arr, durDays, avgKnots,
        progress: 0, manualPreview: false };
  S.progress = liveFrac();
  focusMmsi = null;
  centeredOnce = false;

  world.ringsData([
    ringObj(raw.portOfLoading, '63,214,196'),
    ringObj(raw.portOfDischarge, '243,177,78')
  ]);

  fillShipmentCard(raw);
  buildTimeline(raw);
  revealCards();
  updateAisUI();

  if (activeLive()) { centeredOnce = true; centerOnLive(); } else fitCamera(rt);

  playing = false;
  updatePlayBtn();
  renderFast(); renderSlow(); buildFleetList();
}

function liveFrac() {
  if (!S) return 0;
  return clamp((Date.now() - S.dep) / (S.arr - S.dep), 0, 1);
}
function inPreview() { return playing || (S && S.manualPreview); }
function curFrac() { return inPreview() ? S.progress : liveFrac(); }

function ringObj(port, rgb) {
  return { lat: port.lat, lng: port.lng,
    ringColor: (t) => `rgba(${rgb},${(1 - t) * 0.7})`, maxR: 4.5, speed: 2.4, period: 1400 };
}
function fitCamera(rt) {
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  rt.pts.forEach((p) => {
    minLat = Math.min(minLat, p[0]); maxLat = Math.max(maxLat, p[0]);
    minLng = Math.min(minLng, p[1]); maxLng = Math.max(maxLng, p[1]);
  });
  const span = Math.max(maxLat - minLat, maxLng - minLng);
  world.pointOfView({ lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2,
    altitude: clamp(span / 45 + 1.1, 1.4, 3.4) }, 1400);
}

/* ------------------ Panel doldurma ------------------ */
function fillShipmentCard(raw) {
  $('polVal').textContent = raw.portOfLoading.short;
  $('podVal').textContent = raw.portOfDischarge.short;
  $('vesselVal').textContent = raw.vessel;
  $('voyageVal').textContent = raw.voyage;
  $('weightVal').textContent = raw.cargoWeight;
  $('typeVal').textContent = raw.containerType;
  $('cntVal').textContent = raw.containerNo + ' / ' + raw.bookingNo;
}
function buildTimeline(raw) {
  const track = $('timeline');
  track.innerHTML = '';
  S.tlNodes = [];
  raw.timeline.forEach((ev) => {
    const node = document.createElement('div');
    node.className = 'tl-node';
    node.innerHTML =
      '<span class="dot"></span>' +
      '<div class="date">' + esc(fmtLong(parseDate(ev.date))) + '</div>' +
      '<div class="loc">' + esc(ev.location) + '</div>' +
      '<span class="status">' + esc(ev.status) + '</span>' +
      '<span class="transport">TRANSPORT · <b>' + esc(ev.transport) + '</b></span>';
    track.appendChild(node);
    S.tlNodes.push({ el: node, date: parseDate(ev.date) });
  });
}
function clearShipmentUI() {
  ['polVal','podVal','vesselVal','voyageVal','weightVal','typeVal','cntVal'].forEach((id) => $(id).textContent = '—');
  $('timeline').innerHTML = '<div class="fleet-empty">Bir konteyner / sefer / gemi ara — ya da sağdan canlı bir gemi seç.</div>';
}

/* ------------------ Küçük telemetri yardımcıları ------------------ */
function setStat(id, val, unit) { $(id).innerHTML = val + ' <small>' + unit + '</small>'; }
function setRing(frac) { $('progRing').setAttribute('stroke-dashoffset', String(2 * Math.PI * 40 * (1 - clamp(frac, 0, 1)))); }
function setScrub(pct) {
  $('scrubLbl').textContent = pct + '%';
  const sc = $('scrub');
  if (document.activeElement !== sc) sc.value = String(pct * 10);
  sc.style.setProperty('--fill', pct + '%');
}

/* ------------------ Render: telemetri (her kare) ------------------ */
function renderFast() {
  $('clearBtn').hidden = !(S || focusMmsi);
  $('shareBtn').hidden = !S;
  const lv = activeLive();
  const srcTag = $('srcTag');
  const pctLbl = $('pctLbl');
  $('simDate').textContent = fmtShort(inPreview() ? new Date(S.dep.getTime() + S.progress * (S.arr - S.dep)) : new Date());

  /* BOŞ: ne sevkiyat ne canlı gemi */
  if (!S && !lv) {
    srcTag.textContent = 'BOŞ'; srcTag.className = 'src-tag';
    setStat('speedVal', '—', 'kn'); $('hdgVal').textContent = '—°';
    setStat('distVal', '—', 'nm'); setStat('etaVal', '—', 'gün');
    $('coordVal').textContent = '—';
    $('etaLine').innerHTML = 'Bir konteyner / sefer / gemi ara — ya da sağdan canlı bir gemi seç.';
    $('pctVal').textContent = '—'; pctLbl.textContent = 'SEYİR'; setRing(0); setScrub(0);
    return;
  }

  const inspect = lv && !isVoyageVessel();     // tıklanan rastgele gemi
  const preview = S && inPreview() && !inspect;

  /* CANLI gemi verisi (tıklanan ya da sevkiyatın kendi canlı gemisi) */
  if (lv && !preview) {
    srcTag.textContent = 'CANLI'; srcTag.className = 'src-tag live';
    const remNm = S ? haversineKm([lv.lat, lv.lng], [S.raw.portOfDischarge.lat, S.raw.portOfDischarge.lng]) / KM_PER_NM : null;
    const etaDays = (remNm != null && lv.sog && lv.sog > 0.5) ? (remNm / lv.sog) / 24 : null;
    setStat('speedVal', lv.sog != null ? lv.sog.toFixed(1) : '—', 'kn');
    $('hdgVal').textContent = (lv.cog != null ? Math.round(lv.cog) : (lv.heading != null ? Math.round(lv.heading) : '—')) + '°';
    setStat('distVal', remNm != null ? Math.round(remNm).toLocaleString('tr-TR') : '—', 'nm');
    setStat('etaVal', etaDays != null ? etaDays.toFixed(1) : '—', 'gün');
    $('coordVal').textContent = fmtCoord(lv.lat, lv.lng);
    const who = esc(lv.name || ('MMSI ' + lv.mmsi));
    const aisEta = fmtAisEta(lv.eta);
    const aisInfo = (lv.destination || aisEta)
      ? ' · <span class="lv">' + [lv.destination ? ('→ ' + esc(lv.destination)) : '', aisEta ? ('AIS ETA ' + aisEta) : ''].filter(Boolean).join(' · ') + '</span>'
      : '';
    if (inspect || !S) {
      /* yolculuk bağlamı yok → halkada CANLI HIZ göstergesi */
      $('pctVal').textContent = lv.sog != null ? lv.sog.toFixed(1) : '—'; pctLbl.textContent = 'KNOT';
      setRing(lv.sog != null ? clamp(lv.sog / 25, 0, 1) : 0);
      $('etaLine').innerHTML = '<span class="lv">● CANLI</span> <b>' + who + '</b> · son sinyal ' + fmtAge(lv._age || 0) +
        (S ? ' · ' + esc(S.raw.portOfDischarge.short) + '’a ' + Math.round(remNm).toLocaleString('tr-TR') + ' nm' : '') + aisInfo;
    } else {
      /* sevkiyatın kendi gemisi → rota üzerindeki gerçek ilerleme */
      const fr = routeFracNearest([lv.lat, lv.lng]);
      $('pctVal').textContent = Math.round(fr * 100) + '%'; pctLbl.textContent = 'SEYİR'; setRing(fr);
      $('etaLine').innerHTML = '<span class="lv">● CANLI</span> <b>' + who + '</b> · son sinyal ' + fmtAge(lv._age || 0) +
        ' · planlı varış <b>' + fmtTr(S.arr) + '</b>' + aisInfo;
    }
    setScrub(S ? Math.round(curFrac() * 100) : 0);
    return;
  }

  /* TAHMİNİ (sevkiyat, canlı yok) ya da ÖNİZLEME */
  const f = curFrac();
  const p = posAt(S.rt, f);
  const ahead = posAt(S.rt, clamp(f + 0.002, 0, 1));
  const simDate = new Date(S.dep.getTime() + f * (S.arr - S.dep));
  const remNm = S.totalNm * (1 - f);
  const etaDays = Math.max(0, (S.arr - simDate) / MS_DAY);
  srcTag.textContent = preview ? 'ÖNİZLEME' : 'TAHMİNİ'; srcTag.className = 'src-tag';
  setStat('speedVal', (f <= 0 || f >= 1) ? '0.0' : S.avgKnots.toFixed(1), 'kn');
  $('hdgVal').textContent = Math.round(bearing(p, ahead)) + '°';
  setStat('distVal', Math.round(remNm).toLocaleString('tr-TR'), 'nm');
  setStat('etaVal', etaDays.toFixed(1), 'gün');
  $('coordVal').textContent = fmtCoord(p[0], p[1]);
  if (preview) $('etaLine').innerHTML = 'Önizleme · ' + fmtTr(simDate);
  else {
    const status = f <= 0 ? 'Henüz kalkmadı' : f >= 1 ? 'Varış limanında' : 'Seyir hâlinde (tahmini)';
    $('etaLine').innerHTML = '<b>' + status + '</b> · varış <b>' + fmtTr(S.arr) + '</b> · ~<b>' + etaDays.toFixed(1) + ' gün</b> kaldı';
  }
  const pct = Math.round(f * 100);
  $('pctVal').textContent = pct + '%'; pctLbl.textContent = 'SEYİR'; setRing(f);
  setScrub(Math.round(curFrac() * 100));
}

/* ------------------ Render: küre katmanları (throttle) ------------------ */
function renderSlow() {
  const lv = activeLive();
  const inspect = lv && !isVoyageVessel();
  const pts = [];
  const labels = [];

  if (S) {
    const preview = inPreview() && !inspect;
    const routeFrac = (lv && !inspect) ? routeFracNearest([lv.lat, lv.lng]) : (preview ? S.progress : liveFrac());
    const idx = Math.round(routeFrac * S.N);
    const traveled = S.dense.slice(0, Math.max(idx + 1, 1));
    const remaining = S.dense.slice(Math.max(idx, 0));
    const paths = [{ coords: remaining, color: ['rgba(243,177,78,0.22)', 'rgba(243,177,78,0.34)'],
      stroke: 1.1, dashLen: 0.035, dashGap: 0.02, dashAnim: 9000 }];
    if (traveled.length > 1) paths.push({ coords: traveled, color: ['#ffd089', '#ff7b4a'],
      stroke: 2.6, dashLen: 1, dashGap: 0, dashAnim: 0 });
    world.pathsData(paths);

    labels.push(
      { lat: S.raw.portOfLoading.lat, lng: S.raw.portOfLoading.lng, text: S.raw.portOfLoading.short, color: '#3fd6c4', size: 0.9, dot: 0.22, alt: 0.008 },
      { lat: S.raw.portOfDischarge.lat, lng: S.raw.portOfDischarge.lng, text: S.raw.portOfDischarge.short, color: '#ffce86', size: 0.9, dot: 0.22, alt: 0.008 });

    if (lv && !inspect) {
      pts.push({ lat: lv.lat, lng: lv.lng, color: '#39f0c0', alt: 0.03, r: 0.6 });
      labels.push({ lat: lv.lat, lng: lv.lng, text: (lv.name || S.raw.vessel) + ' · CANLI', color: '#39f0c0', size: 0.9, dot: 0, alt: 0.05 });
    } else {
      const p = posAt(S.rt, preview ? S.progress : liveFrac());
      pts.push({ lat: p[0], lng: p[1], color: preview ? '#ff6253' : '#ffae3d', alt: 0.026, r: 0.5 });
      labels.push({ lat: p[0], lng: p[1], text: S.raw.vessel + (preview ? ' · ÖNİZLEME' : ' · TAHMİNİ'), color: preview ? '#ff8a7a' : '#ffc266', size: 0.84, dot: 0, alt: 0.04 });
    }
    if (inspect) {
      pts.push({ lat: lv.lat, lng: lv.lng, color: '#7CFFE0', alt: 0.035, r: 0.62 });
      labels.push({ lat: lv.lat, lng: lv.lng, text: (lv.name || ('MMSI ' + lv.mmsi)) + ' · İZLENEN', color: '#9bffe9', size: 0.9, dot: 0, alt: 0.055 });
    }

    const colorDate = (preview ? S.progress : liveFrac());
    const simDate = new Date(S.dep.getTime() + colorDate * (S.arr - S.dep));
    let curIdx = 0;
    S.tlNodes.forEach((n, i) => { if (n.date.getTime() <= simDate.getTime()) curIdx = i; });
    S.tlNodes.forEach((n, i) => {
      n.el.classList.remove('past', 'cur');
      if (i < curIdx) n.el.classList.add('past'); else if (i === curIdx) n.el.classList.add('cur');
    });
  } else {
    /* sevkiyat yok → tıklanan geminin hareket izi (varsa) */
    if (lv && trail.length > 1) {
      world.pathsData([{ coords: trail.slice(), color: ['rgba(57,240,192,0.18)', '#39f0c0'],
        stroke: 1.8, dashLen: 1, dashGap: 0, dashAnim: 0 }]);
    } else { world.pathsData([]); }
    if (lv) {
      pts.push({ lat: lv.lat, lng: lv.lng, color: '#39f0c0', alt: 0.03, r: 0.62 });
      labels.push({ lat: lv.lat, lng: lv.lng, text: (lv.name || ('MMSI ' + lv.mmsi)) + ' · CANLI', color: '#39f0c0', size: 0.92, dot: 0, alt: 0.05 });
    }
  }

  if (showFleetDots) {
    let fleet = Object.values(AIS.fleet);
    if (fleet.length > FLEET_MAX) fleet = fleet.sort((a, b) => b.time - a.time).slice(0, FLEET_MAX);
    fleet.forEach((fv) => { if (fv === lv) return; pts.push({ lat: fv.lat, lng: fv.lng, color: 'rgba(95,215,240,0.6)', alt: 0.006, r: 0.16 }); });
  }
  world.pointsData(pts);
  world.labelsData(labels);
  updateAisUI();
}

/* ------------------ Sağ panel: canlı gemi listesi ------------------ */
function buildFleetList() {
  $('fleetCount').textContent = fleetCount();
  const list = $('fleetList');
  const lv = activeLive();
  const podLL = S ? [S.raw.portOfDischarge.lat, S.raw.portOfDischarge.lng] : null;
  let rows = Object.values(AIS.fleet).map((f) => ({
    f, dist: podLL ? haversineKm([f.lat, f.lng], podLL) / KM_PER_NM : null
  }));
  rows.sort(podLL ? (a, b) => a.dist - b.dist : (a, b) => (b.f.sog || 0) - (a.f.sog || 0));
  rows = rows.slice(0, 40);

  if (!rows.length) { list.innerHTML = '<div class="fleet-empty">Canlı sinyal bekleniyor…</div>'; return; }
  list.innerHTML = '';
  rows.forEach(({ f, dist }) => {
    const row = document.createElement('div');
    row.className = 'fleet-row' + (f === lv ? ' active' : '');
    const name = esc(f.name || ('MMSI ' + f.mmsi));
    const right = dist != null ? Math.round(dist).toLocaleString('tr-TR') + ' nm' : (f.sog != null ? f.sog.toFixed(1) + ' kn' : '—');
    row.innerHTML =
      '<div class="fname">' + name + '</div>' +
      '<div class="fdist">' + right + '</div>' +
      '<div class="fmeta">MMSI ' + esc(f.mmsi) + '</div>' +
      '<div class="fspeed">' + (f.sog != null ? f.sog.toFixed(1) + ' kn' : '— kn') + '</div>';
    row.addEventListener('click', () => focusVessel(f.mmsi));
    list.appendChild(row);
  });
}

/* Bir canlı gemiye tıkla → TAMAMEN o gemiye geç: sevkiyat bağlamı temizlenir,
   yalnız o geminin konumu + hareket izi + AIS hedef/ETA gösterilir. */
function focusVessel(mmsi) {
  if (focusMmsi === mmsi) { clearSelection(); return; }   // aynı gemiye tekrar → bırak
  S = null;
  focusMmsi = mmsi;
  trail = [];
  playing = false;
  following = false; $('followBtn').classList.remove('active'); setRotate(false);
  world.ringsData([]);
  clearShipmentUI();
  $('q').value = '';
  centeredOnce = false;
  if (activeLive()) { centeredOnce = true; centerOnLive(); }
  updatePlayBtn();
  renderFast(); renderSlow(); buildFleetList();
}

/* Seçimi tamamen temizle → boş duruma dön */
function clearSelection() {
  S = null; focusMmsi = null; trail = [];
  playing = false; following = false; $('followBtn').classList.remove('active');
  $('q').value = ''; $('err').classList.remove('show');
  world.ringsData([]); clearShipmentUI();
  world.pointOfView({ lat: 25, lng: 48, altitude: 2.7 }, 1000);
  updatePlayBtn();
  renderFast(); renderSlow(); buildFleetList();
}

/* ------------------ Animasyon döngüsü ------------------ */
let last = performance.now(), accSlow = 0, accFollow = 0, accList = 0;
function frame(now) {
  const dt = now - last; last = now;
  if (playing && S) { S.progress += BASE_SPEED * speedMult * (dt / 1000); if (S.progress >= 1) { S.progress = 1; setPlaying(false); } }

  const pov = world.pointOfView();
  world.controls().autoRotate = userRotate && !following && !playing;
  world.controls().autoRotateSpeed = 0.14 * clamp((pov.altitude || 2) / 2.5, 0.18, 1.2);

  renderFast();
  accSlow += dt; if (accSlow > 110) { accSlow = 0; renderSlow(); }
  accFollow += dt;
  if (following && accFollow > 480) {
    accFollow = 0;
    const lv = activeLive();
    const p = lv ? [lv.lat, lv.lng] : (S ? posAt(S.rt, playing ? S.progress : liveFrac()) : null);
    if (p) world.pointOfView({ lat: p[0], lng: p[1], altitude: pov.altitude }, 600);
  }
  accList += dt; if (accList > 1300) { accList = 0; buildFleetList(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ------------------ Kontroller ------------------ */
function setPlaying(v) {
  playing = v;
  if (v && S) { if (S.progress >= 1) S.progress = 0; S.manualPreview = true; focusMmsi = null; }
  updatePlayBtn();
}
function updatePlayBtn() {
  const b = $('playBtn');
  if (!S) { b.innerHTML = '▶ SEFERİ OYNAT'; return; }
  if (playing) b.innerHTML = '❚❚ DURAKLAT';
  else if (S.progress >= 1) b.innerHTML = '↺ TEKRAR';
  else b.innerHTML = '▶ SEFERİ OYNAT';
}
$('playBtn').addEventListener('click', () => { if (!S) return; if (!playing) { if (S.progress >= 1) S.progress = 0; setPlaying(true); } else setPlaying(false); });
$('todayBtn').addEventListener('click', () => {
  focusMmsi = null;
  if (!S) { world.pointOfView({ lat: 25, lng: 48, altitude: 2.7 }, 1000); renderFast(); renderSlow(); buildFleetList(); return; }
  setPlaying(false); S.manualPreview = false; S.progress = liveFrac(); centeredOnce = false;
  if (activeLive()) { centeredOnce = true; centerOnLive(); } else fitCamera(S.rt);
  renderFast(); renderSlow(); buildFleetList();
});
$('followBtn').addEventListener('click', () => { following = !following; $('followBtn').classList.toggle('active', following); if (following) setRotate(false); });
$('rotateBtn').addEventListener('click', () => setRotate(!userRotate));
$('scrub').addEventListener('input', (e) => { if (!S) return; playing = false; S.manualPreview = true; focusMmsi = null; updatePlayBtn(); S.progress = clamp(+e.target.value / 1000, 0, 1); renderFast(); renderSlow(); });
$('speed').addEventListener('input', (e) => { speedMult = +e.target.value / 100; $('speedLbl').textContent = speedMult.toFixed(1) + '×'; e.target.style.setProperty('--fill', ((+e.target.value - 20) / 3.8) + '%'); });
$('dotsToggle').addEventListener('change', (e) => { showFleetDots = e.target.checked; renderSlow(); });

$('tlToggle').addEventListener('click', () => document.body.classList.toggle('tl-collapsed'));
$('leftHide').addEventListener('click', () => document.body.classList.add('left-hidden'));
$('leftHandle').addEventListener('click', () => document.body.classList.remove('left-hidden'));
/* Mobil: sol panel alt-sheet'tir; başlığına dokununca aç/kapa */
const leftHead = document.querySelector('#leftStack .stack-head');
if (leftHead) leftHead.addEventListener('click', (e) => {
  if (e.target.closest('.stack-hide')) return;
  if (window.innerWidth <= 920) document.body.classList.toggle('sheet-collapsed');
});
$('rightHide').addEventListener('click', () => document.body.classList.add('right-hidden'));
$('rightHandle').addEventListener('click', () => document.body.classList.remove('right-hidden'));
document.querySelectorAll('.card-title.clickable').forEach((t) => t.addEventListener('click', () => t.closest('.card').classList.toggle('collapsed')));

/* ------------------ Arama (localStorage sevkiyatları) ------------------ */
function doSearch(val) {
  const q = (val != null ? val : $('q').value).trim().toUpperCase();
  const err = $('err');
  if (!q) return;
  err.classList.remove('show');
  const key = storeIndex()[q];
  if (!key) {
    err.textContent = '⚠ "' + q + '" kayıtlı sevkiyat değil. Sağ üstten “＋ Sevkiyatlarım” ile ekle.';
    err.classList.add('show');
    return;
  }
  const raw = STORE[key];
  $('q').value = raw.containerNo;
  loadShipment(raw, { mmsi: raw.mmsi, name: raw.vessel, imo: raw.imo || null });
}
$('clearBtn').addEventListener('click', clearSelection);
$('shareBtn').addEventListener('click', () => { if (S) shareLink(S.raw.containerNo); });
$('searchBtn').addEventListener('click', () => doSearch());
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
document.querySelectorAll('.hints .chip').forEach((c) => c.addEventListener('click', () => doSearch(c.dataset.q)));

function revealCards() {
  document.querySelectorAll('.card').forEach((el) => { el.classList.remove('in'); void el.offsetWidth; el.classList.add('in'); });
}

/* ------------------ Başlangıç (BOŞ) ------------------ */
$('speedLbl').textContent = '1.0×';
$('speed').style.setProperty('--fill', ((100 - 20) / 3.8) + '%');
$('dotsToggle').checked = showFleetDots;
if (window.innerWidth < 920) document.body.classList.add('tl-collapsed');
if (window.innerWidth < 980) document.body.classList.add('right-hidden');
if (window.innerWidth <= 920) document.body.classList.add('sheet-collapsed');   // mobil: küre görünsün

window.addEventListener('load', () => {
  /* Paylaşılan link mi? (?s=...) → sevkiyatı doğrudan aç + cihaza kaydet */
  const sh = new URLSearchParams(location.search).get('s');
  if (sh) {
    try {
      const obj = JSON.parse(b64urlDecode(sh));
      if (!okPortObj(obj.portOfLoading) || !okPortObj(obj.portOfDischarge)) throw new Error('bad ports');
      if (!Array.isArray(obj.route) || obj.route.length < 2) {
        obj.route = buildRouteWaypoints(obj.routeTemplate || 'direct', obj.portOfLoading, obj.portOfDischarge);
      }
      if (Array.isArray(obj.timeline)) obj.timeline = obj.timeline.slice(0, 60);   // aşırı uzun timeline'ı sınırla
      if (!validShipment(obj)) throw new Error('invalid');
      STORE[obj.containerNo] = obj; saveStore();
      revealCards();
      loadShipment(obj, { mmsi: obj.mmsi, name: obj.vessel, imo: obj.imo || null });
      aisConnect();
      showToast('Paylaşılan sevkiyat açıldı: ' + obj.containerNo);
      return;
    } catch (e) { /* bozuk/geçersiz link → boş başlat */ }
  }
  clearShipmentUI();
  revealCards();
  renderFast(); renderSlow();
  aisConnect();
});

/* ================= Sevkiyat yönetim modalı ================= */
const PORTS = [
  { name:'Nhava Sheva (JNPT), India', short:'NHAVA SHEVA', lat:18.95, lng:72.95 },
  { name:'Mundra, India', short:'MUNDRA', lat:22.74, lng:69.70 },
  { name:'Chennai, India', short:'CHENNAI', lat:13.08, lng:80.29 },
  { name:'Colombo, Sri Lanka', short:'COLOMBO', lat:6.94, lng:79.84 },
  { name:'Jebel Ali, UAE', short:'JEBEL ALI', lat:25.01, lng:55.06 },
  { name:'Yangshan / Shanghai, China', short:'SHANGHAI', lat:30.62, lng:122.07 },
  { name:'Ningbo, China', short:'NINGBO', lat:29.87, lng:121.55 },
  { name:'Singapore', short:'SINGAPORE', lat:1.26, lng:103.83 },
  { name:'Port Klang, Malaysia', short:'PORT KLANG', lat:3.00, lng:101.39 },
  { name:'Marport Ambarlı, İstanbul', short:'ISTANBUL', lat:40.97, lng:28.68 },
  { name:'Mersin, Türkiye', short:'MERSIN', lat:36.80, lng:34.64 },
  { name:'Aliağa / İzmir, Türkiye', short:'IZMIR', lat:38.80, lng:26.97 },
  { name:'Gemlik, Türkiye', short:'GEMLIK', lat:40.43, lng:29.12 },
  { name:'Port Said, Egypt', short:'PORT SAID', lat:31.27, lng:32.30 },
  { name:'Alexandria, Egypt', short:'ALEXANDRIA', lat:31.18, lng:29.87 },
  { name:'Piraeus, Greece', short:'PIRAEUS', lat:37.94, lng:23.64 },
  { name:'Gioia Tauro, Italy', short:'GIOIA TAURO', lat:38.43, lng:15.90 },
  { name:'Barcelona, Spain', short:'BARCELONA', lat:41.35, lng:2.16 },
  { name:'Valencia, Spain', short:'VALENCIA', lat:39.44, lng:-0.31 },
  { name:'Rotterdam, NL', short:'ROTTERDAM', lat:51.95, lng:4.14 },
  { name:'Hamburg, DE', short:'HAMBURG', lat:53.54, lng:9.92 },
  { name:'Antwerp, BE', short:'ANTWERP', lat:51.26, lng:4.40 },
  { name:'New York / Newark, USA', short:'NEW YORK', lat:40.68, lng:-74.13 },
  { name:'Norfolk, USA', short:'NORFOLK', lat:36.92, lng:-76.33 },
  { name:'Savannah, USA', short:'SAVANNAH', lat:32.08, lng:-81.10 },
  { name:'Houston, USA', short:'HOUSTON', lat:29.73, lng:-95.27 }
];
const ROUTE_TEMPLATES = {
  'india-turkey':   { name:'Hindistan ↔ Türkiye (Süveyş)', via:[[15.5,60.0],[12.7,48.0],[12.6,43.4],[18.0,40.5],[26.0,35.2],[29.9,32.55],[31.27,32.30],[33.6,29.0],[35.3,24.5],[37.5,25.2],[39.6,25.9],[40.22,26.40],[40.6,27.3]] },
  'fareast-turkey': { name:'Uzakdoğu ↔ Türkiye (Malakka+Süveyş)', via:[[20,116],[8.5,107],[1.3,103.8],[5.5,96.5],[6.5,82],[9.5,65],[12.5,46],[12.6,43.4],[22,38],[29.9,32.55],[31.27,32.30],[33.5,30],[36,23]] },
  'turkey-useast':  { name:'Türkiye ↔ ABD Doğu (Atlantik)', via:[[39.6,25.5],[36.8,23.5],[35.5,18],[37,12.5],[35.95,-5.6],[35.5,-20],[38.5,-45],[40,-58],[40.5,-72]] },
  'med':            { name:'Akdeniz içi (kısa)', via:[] },
  'direct':         { name:'Düz hat', via:[] }
};

function initFormSelects() {
  const opt = (p, i) => `<option value="${i}">${esc(p.name)}</option>`;
  $('fPol').innerHTML = PORTS.map(opt).join('');
  $('fPod').innerHTML = PORTS.map(opt).join('');
  $('fPod').selectedIndex = 9;
  $('fRoute').innerHTML = Object.keys(ROUTE_TEMPLATES).map((k) => `<option value="${esc(k)}">${esc(ROUTE_TEMPLATES[k].name)}</option>`).join('');
}
function addEventRow(ev) {
  ev = ev || { date: '', location: '', status: '', transport: 'VESSEL' };
  const row = document.createElement('div'); row.className = 'fev';
  const tr = ['TRUCK', 'VESSEL', 'RAIL', 'TBN'];
  row.innerHTML =
    `<input type="date" value="${esc(ev.date)}">` +
    `<input placeholder="Konum (PORT // ...)" value="${esc(ev.location)}">` +
    `<input placeholder="Durum (GATE IN...)" value="${esc(ev.status)}">` +
    `<select>${tr.map((t) => `<option ${ev.transport === t ? 'selected' : ''}>${t}</option>`).join('')}</select>` +
    `<button class="fev-del" title="sil">✕</button>`;
  row.querySelector('.fev-del').addEventListener('click', () => row.remove());
  $('fEvents').appendChild(row);
}
function buildRouteWaypoints(tKey, pol, pod) {
  const via = ((ROUTE_TEMPLATES[tKey] && ROUTE_TEMPLATES[tKey].via) || []).map((p) => [p[0], p[1]]);
  if (via.length >= 2) {
    const d0 = haversineKm([pol.lat, pol.lng], via[0]);
    const d1 = haversineKm([pol.lat, pol.lng], via[via.length - 1]);
    if (d1 < d0) via.reverse();
  }
  return [[pol.lat, pol.lng], ...via, [pod.lat, pod.lng]];
}
function gatherForm() {
  const pol = PORTS[+$('fPol').value], pod = PORTS[+$('fPod').value];
  const events = Array.from($('fEvents').children).map((row) => {
    const inp = row.querySelectorAll('input'), sel = row.querySelector('select');
    return { date: inp[0].value, location: inp[1].value, status: inp[2].value, transport: sel.value, sefer: '' };
  }).filter((e) => e.date && (e.location || e.status));
  return {
    containerNo: $('fCnt').value.trim().toUpperCase(), bookingNo: $('fBook').value.trim(),
    mmsi: $('fMmsi').value.trim(), vessel: $('fVessel').value.trim(), voyage: $('fVoy').value.trim(),
    imo: $('fImo').value.trim(), cargoWeight: $('fWeight').value.trim(),
    containerType: $('fType').value.trim() || '—',
    portOfLoading: { name: pol.name, short: pol.short, lat: pol.lat, lng: pol.lng },
    portOfDischarge: { name: pod.name, short: pod.short, lat: pod.lat, lng: pod.lng },
    departure: $('fDep').value, arrival: $('fArr').value,
    route: buildRouteWaypoints($('fRoute').value, pol, pod), routeTemplate: $('fRoute').value, timeline: events
  };
}
function saveShipment() {
  const s = gatherForm(); const msg = $('fMsg'); msg.className = 'mgr-msg';
  if (!s.containerNo || !s.mmsi || !s.vessel || !s.departure || !s.arrival) {
    msg.textContent = 'Zorunlu alanlar eksik (* işaretli).'; msg.className = 'mgr-msg err'; return;
  }
  STORE[s.containerNo] = s; saveStore();
  msg.textContent = 'Kaydedildi ✓ (artık aratabilirsin)'; msg.className = 'mgr-msg ok';
  loadMgrList();
}
function loadMgrList() {
  const list = $('mgrList'); const keys = Object.keys(STORE);
  if (!keys.length) { list.innerHTML = '<div class="fleet-empty">Henüz sevkiyat yok. “＋ Yeni sevkiyat” ile ekle.</div>'; return; }
  list.innerHTML = '';
  keys.forEach((k) => {
    const s = STORE[k];
    const it = document.createElement('div'); it.className = 'mgr-item';
    it.innerHTML =
      `<div class="ci">${esc(s.containerNo)}</div>` +
      `<div class="vi">${esc(s.vessel || '—')} · ${esc(s.portOfLoading.short)} → ${esc(s.portOfDischarge.short)}</div>` +
      `<div class="ri"><button class="t-watch">izle</button><button class="t-share">paylaş</button><button class="t-edit">düzenle</button><button class="t-del">sil</button></div>`;
    it.querySelector('.t-watch').addEventListener('click', () => { M_close(); doSearch(s.containerNo); });
    it.querySelector('.t-share').addEventListener('click', () => shareLink(s.containerNo));
    it.querySelector('.t-edit').addEventListener('click', () => editShipment(s.containerNo));
    it.querySelector('.t-del').addEventListener('click', () => deleteShipment(s.containerNo));
    list.appendChild(it);
  });
}
function setPortSelect(id, port) {
  if (!port) return;
  let idx = PORTS.findIndex((p) => p.short === port.short || (Math.abs(p.lat - port.lat) < 0.2 && Math.abs(p.lng - port.lng) < 0.2));
  if (idx < 0) { PORTS.push({ name: port.name || port.short, short: port.short, lat: port.lat, lng: port.lng }); initFormSelects(); idx = PORTS.length - 1; }
  $(id).value = String(idx);
}
function editShipment(cn) {
  const s = STORE[cn]; if (!s) return;
  resetForm(); $('formTitle').textContent = 'Düzenle: ' + s.containerNo;
  $('fCnt').value = s.containerNo; $('fBook').value = s.bookingNo || ''; $('fVoy').value = s.voyage || '';
  $('fVessel').value = s.vessel || ''; $('fMmsi').value = s.mmsi || ''; $('fImo').value = s.imo || '';
  $('fWeight').value = s.cargoWeight || ''; $('fType').value = s.containerType || '';
  setPortSelect('fPol', s.portOfLoading); setPortSelect('fPod', s.portOfDischarge);
  if (s.routeTemplate) $('fRoute').value = s.routeTemplate;
  $('fDep').value = s.departure || ''; $('fArr').value = s.arrival || '';
  $('fEvents').innerHTML = ''; (s.timeline || []).forEach((ev) => addEventRow(ev));
}
function deleteShipment(cn) {
  if (!confirm(cn + ' silinsin mi?')) return;
  delete STORE[cn]; saveStore(); loadMgrList();
}
function resetForm() {
  $('formTitle').textContent = 'Yeni Sevkiyat';
  ['fCnt', 'fBook', 'fVoy', 'fVessel', 'fMmsi', 'fImo', 'fWeight', 'fType', 'fDep', 'fArr'].forEach((id) => $(id).value = '');
  $('fEvents').innerHTML = ''; $('fMsg').textContent = ''; $('fMsg').className = 'mgr-msg';
  if ($('fPol').options.length) { $('fPol').selectedIndex = 0; $('fPod').selectedIndex = 9; $('fRoute').selectedIndex = 0; }
}
function showToast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._t); t._t = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 300); }, 2600);
}
/* Sevkiyatı linke kodla → kopyala. Linki açan (telefon dâhil) doğrudan görür. */
function shareLink(cn) {
  const s = STORE[cn]; if (!s) return;
  const compact = Object.assign({}, s); delete compact.route;   // routeTemplate ile yeniden kurulur
  const url = location.origin + location.pathname + '?s=' + b64urlEncode(JSON.stringify(compact));
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => showToast('🔗 Bağlantı kopyalandı'), () => window.prompt('Bağlantıyı kopyala:', url));
  } else { window.prompt('Bağlantıyı kopyala:', url); }
}
function M_open() { $('mgr').hidden = false; if (!$('fPol').options.length) initFormSelects(); loadMgrList(); }
function M_close() { $('mgr').hidden = true; }
$('mgrOpen').addEventListener('click', M_open);
$('mgrClose').addEventListener('click', M_close);
$('mgr').addEventListener('click', (e) => { if (e.target === $('mgr')) M_close(); });
$('mgrNew').addEventListener('click', () => { resetForm(); addEventRow(); });
$('fAddEvent').addEventListener('click', () => addEventRow());
$('fSave').addEventListener('click', saveShipment);
$('fReset').addEventListener('click', resetForm);
