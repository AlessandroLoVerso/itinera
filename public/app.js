// Itinera — foto → luoghi → percorso ottimizzato.
// Servizi gratuiti OpenStreetMap: Nominatim/Photon (ricerca luoghi), Valhalla FOSSGIS (matrice tempi + percorso,
// con profilo moto vero), OSRM FOSSGIS come riserva. Nessuna chiave richiesta.

const VALHALLA = "https://valhalla1.openstreetmap.de";
const OSRM = "https://routing.openstreetmap.de";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const PHOTON = "https://photon.komoot.io/api/";
const STORE_KEY = "itinera:v1";
const VALHALLA_MAX_ROUTE = 20; // tappe per richiesta /route sul server pubblico

const MODES = {
  auto: { label: "Auto", gmaps: "driving", osrm: "car", speed: 40 },
  moto: { label: "Moto", gmaps: "driving", osrm: "car", speed: 45 },
  bici: { label: "Bici", gmaps: "bicycling", osrm: "bike", speed: 15 },
  piedi: { label: "A piedi", gmaps: "walking", osrm: "foot", speed: 4.5 },
};

const SAMPLE = {
  area: "Roma",
  stops: [
    ["Colosseo", 41.8902, 12.4922],
    ["Fontana di Trevi", 41.9009, 12.4833],
    ["Pantheon", 41.8986, 12.4769],
    ["Piazza Navona", 41.8992, 12.4731],
    ["Campo de' Fiori", 41.8956, 12.4722],
    ["Santa Maria in Trastevere", 41.8894, 12.4703],
    ["Bocca della Verità", 41.8881, 12.4815],
  ],
};

const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Stato ---------- */

const state = {
  stops: [], // {id, query, lat, lon, status: pending|ok|missing, detail}
  mode: "auto",
  moto: "veloce",
  area: "",
  start: "first",
  end: "free",
  optimize: true,
};
let route = null; // ultimo percorso calcolato
let me = null; // {lat, lon}
let serverConfig = { aiExtraction: false };

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {}
}
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (raw && Array.isArray(raw.stops)) Object.assign(state, raw);
  } catch {}
}

/* ---------- Mappa ---------- */

const map = L.map("map", { zoomControl: true, attributionControl: true }).setView([41.9, 12.49], 13);
map.zoomControl.setPosition("bottomright");
const dark = matchMedia("(prefers-color-scheme: dark)");
// Mappa standard OpenStreetMap; nel tema scuro la scuriamo via CSS (OSM non ha uno stile scuro)
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
let meMarker = null;

function modeColor() {
  return getComputedStyle(document.body).getPropertyValue("--mode").trim() || "#2c5cff";
}

function pinIcon(label, cls = "") {
  return L.divIcon({
    className: "",
    html: `<div class="pin-marker ${cls}"><span>${label}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [4, 30],
    popupAnchor: [11, -28],
  });
}

function renderMarkers() {
  markerLayer.clearLayers();
  // Numerazione: ordine del percorso se calcolato, altrimenti ordine della lista
  const orderOf = new Map();
  if (route) route.points.forEach((p, i) => p.stopId && !orderOf.has(p.stopId) && orderOf.set(p.stopId, i));
  state.stops.forEach((s, i) => {
    if (s.lat == null) return;
    const n = route && orderOf.has(s.id) ? orderOf.get(s.id) : i + 1;
    const isStart = route && n === 0;
    const m = L.marker([s.lat, s.lon], {
      icon: pinIcon(isStart ? "A" : n, isStart ? "start" : route ? "" : "pending"),
      draggable: true,
      title: s.query,
    })
      .bindPopup(`<b>${escapeHtml(s.query)}</b>${s.detail ? `<br><small>${escapeHtml(s.detail)}</small>` : ""}`)
      .on("dragend", (e) => {
        const ll = e.target.getLatLng();
        Object.assign(s, { lat: ll.lat, lon: ll.lng, status: "ok", detail: "Posizione regolata a mano" });
        invalidateRoute();
        save();
        renderStops();
      });
    markerLayer.addLayer(m);
  });
}

function fitTo(latlngs) {
  if (!latlngs.length) return;
  const wide = innerWidth >= 900;
  const sheetH = $("#sheet").getBoundingClientRect().height;
  const opts = wide
    ? { paddingTopLeft: [450, 80], paddingBottomRight: [40, 40], maxZoom: 16 }
    : { paddingTopLeft: [30, 80], paddingBottomRight: [30, sheetH + 20], maxZoom: 16 };
  map.fitBounds(L.latLngBounds(latlngs), opts);
}

/* ---------- Interfaccia: tappe ---------- */

const ICON_UP = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

function renderStops() {
  const ol = $("#stops");
  ol.innerHTML = "";
  state.stops.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "stop";
    li.dataset.status = s.status;
    const detail =
      s.status === "ok" ? s.detail || "Trovato" : s.status === "missing" ? "Non trovato: correggi il nome o trascina il segnaposto" : "Da cercare";
    li.innerHTML = `
      <span class="num">${route && route.points[0].stopId ? (i === 0 ? "A" : i) : i + 1}</span>
      <span class="txt">
        <input id="stop-${s.id}" value="${escapeHtml(s.query)}" aria-label="Tappa ${i + 1}">
        <small>${escapeHtml(detail)}</small>
      </span>
      <span class="tools">
        <button type="button" data-act="up" aria-label="Sposta su">${ICON_UP}</button>
        <button type="button" data-act="del" aria-label="Elimina">${ICON_X}</button>
      </span>`;
    li.querySelector("input").addEventListener("change", (e) => {
      const v = e.target.value.trim();
      if (!v) return removeStop(s.id);
      Object.assign(s, { query: v, lat: null, lon: null, status: "pending", detail: "" });
      invalidateRoute();
      save();
      renderStops();
    });
    li.querySelector('[data-act="up"]').addEventListener("click", () => {
      if (i === 0) return;
      [state.stops[i - 1], state.stops[i]] = [state.stops[i], state.stops[i - 1]];
      invalidateRoute();
      save();
      renderStops();
    });
    li.querySelector('[data-act="del"]').addEventListener("click", () => removeStop(s.id));
    ol.appendChild(li);
  });
  $("#count").textContent = state.stops.length;
  renderMarkers();
}

function removeStop(id) {
  state.stops = state.stops.filter((s) => s.id !== id);
  invalidateRoute();
  save();
  renderStops();
}

function addStops(queries) {
  const seen = new Set(state.stops.map((s) => s.query.toLowerCase()));
  for (const q of queries) {
    const t = q.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    state.stops.push({ id: uid(), query: t, lat: null, lon: null, status: "pending", detail: "" });
  }
  invalidateRoute();
  save();
  renderStops();
}

function invalidateRoute() {
  route = null;
  routeLayer.clearLayers();
  $("#result").hidden = true;
}

/* ---------- Messaggi ---------- */

let toastTimer;
function toast(msg, ms = 4200) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function setStatus(text, progress) {
  const el = $("#status");
  if (text == null) return (el.hidden = true);
  el.hidden = false;
  el.innerHTML =
    `<span class="spinner"></span><span>${escapeHtml(text)}</span>` +
    (progress != null ? `<span class="bar" style="--p:${Math.round(progress * 100)}%"><i></i></span>` : "");
}

/* ---------- Foto → luoghi ---------- */

async function handleImage(file) {
  if (!file || !file.type.startsWith("image/")) return toast("Scegli un'immagine (JPG, PNG, HEIC convertita…).");
  const thumb = $("#thumb");
  thumb.src = URL.createObjectURL(file);
  thumb.hidden = false;
  $("#drop-text").innerHTML = `<strong>${escapeHtml(file.name || "Foto")}</strong><small>Tocca per cambiare foto</small>`;

  let places = [];
  try {
    if (serverConfig.aiExtraction) {
      setStatus("Leggo i luoghi nella foto con l'AI…");
      places = await extractWithAI(file);
    } else {
      places = await extractWithOCR(file);
    }
  } catch (err) {
    console.error(err);
    if (serverConfig.aiExtraction) {
      toast("Estrazione AI non riuscita, provo con l'OCR.");
      try {
        places = await extractWithOCR(file);
      } catch (e2) {
        console.error(e2);
      }
    }
  }
  setStatus(null);
  if (!places.length) return toast("Non ho trovato luoghi leggibili. Aggiungili a mano qui sotto.");
  addStops(places);
  toast(`Trovati ${places.length} luoghi. Controlla l'elenco e premi “Calcola percorso”.`);
  await geocodeAll();
}

async function downscale(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

async function extractWithAI(file) {
  const canvas = await downscale(file);
  const image = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
  const res = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, mediaType: "image/jpeg", hint: state.area }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Errore estrazione");
  if (data.area && !state.area) {
    state.area = data.area;
    $("#area").value = data.area;
  }
  return (data.places || []).map((p) => p.query || p.name).filter(Boolean);
}

async function extractWithOCR(file) {
  if (!window.Tesseract) throw new Error("OCR non caricato");
  setStatus("Preparo il riconoscimento testo…", 0);
  const worker = await Tesseract.createWorker(["ita", "eng"], 1, {
    workerPath: "/vendor/tesseract/worker.min.js",
    corePath: "/vendor/tesseract-core/",
    logger: (m) => {
      if (m.status === "recognizing text") setStatus("Leggo il testo nella foto…", m.progress);
      else if (m.status?.includes("loading")) setStatus("Scarico il modello di lettura (solo la prima volta)…", m.progress);
    },
  });
  try {
    const canvas = await downscale(file, 2200);
    const { data } = await worker.recognize(canvas);
    return parseLines(data.text);
  } finally {
    worker.terminate();
  }
}

function parseLines(text) {
  return text
    .split(/\r?\n|;/)
    .map((l) =>
      l
        .replace(/^[\s\-–—•*·>□☐✓✔\[\]()\d.)]+/, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
    )
    .filter((l) => l.length >= 3 && l.length <= 90 && (l.match(/[A-Za-zÀ-ÿ]/g) || []).length >= 3);
}

/* ---------- Ricerca luoghi ---------- */

let lastNominatim = 0;
async function geocode(query) {
  const area = state.area.trim();
  const q = area && !query.toLowerCase().includes(area.toLowerCase()) ? `${query}, ${area}` : query;
  // Nominatim: massimo 1 richiesta al secondo
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  try {
    const url = `${NOMINATIM}?format=jsonv2&limit=1&addressdetails=0&accept-language=it&q=${encodeURIComponent(q)}`;
    const r = await fetch(url);
    if (r.ok) {
      const [hit] = await r.json();
      if (hit) return { lat: +hit.lat, lon: +hit.lon, detail: shortName(hit.display_name) };
    }
  } catch {}
  try {
    const r = await fetch(`${PHOTON}?limit=1&q=${encodeURIComponent(q)}`);
    if (r.ok) {
      const f = (await r.json()).features?.[0];
      if (f) {
        const p = f.properties;
        return {
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          detail: [p.name, p.street, p.city || p.county].filter(Boolean).join(", "),
        };
      }
    }
  } catch {}
  return null;
}

function shortName(display) {
  return display.split(",").slice(0, 3).map((s) => s.trim()).join(", ");
}

async function geocodeAll() {
  const todo = state.stops.filter((s) => s.lat == null);
  let i = 0;
  for (const s of todo) {
    setStatus(`Cerco “${s.query}” sulla mappa (${++i}/${todo.length})…`, i / todo.length);
    const hit = await geocode(s.query);
    if (hit) Object.assign(s, hit, { status: "ok" });
    else s.status = "missing";
    renderStops();
  }
  setStatus(null);
  save();
  const found = state.stops.filter((s) => s.lat != null);
  if (todo.length && found.length) fitTo(found.map((s) => [s.lat, s.lon]));
  return state.stops.filter((s) => s.status === "missing").length;
}

/* ---------- Instradamento ---------- */

function costing() {
  switch (state.mode) {
    case "moto":
      return {
        costing: "motorcycle",
        costing_options: {
          motorcycle:
            state.moto === "panoramico"
              ? { use_highways: 0, use_tolls: 0, use_trails: 0, use_ferry: 0.3 }
              : { use_highways: 1, use_tolls: 0.5, use_trails: 0, use_ferry: 0.5 },
        },
      };
    case "bici":
      return { costing: "bicycle", costing_options: { bicycle: { bicycle_type: "Hybrid", use_roads: 0.3, use_hills: 0.3 } } };
    case "piedi":
      return { costing: "pedestrian" };
    default:
      return { costing: "auto" };
  }
}

async function valhalla(endpoint, body) {
  const r = await fetch(`${VALHALLA}/${endpoint}?json=${encodeURIComponent(JSON.stringify(body))}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Valhalla ${r.status}`);
  return data;
}

function haversine(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Matrice dei tempi (secondi) tra tutti i punti
async function timeMatrix(points) {
  const locs = points.map((p) => ({ lat: p.lat, lon: p.lon }));
  try {
    const data = await valhalla("sources_to_targets", { sources: locs, targets: locs, ...costing() });
    const m = data.sources_to_targets;
    if (Array.isArray(m)) return m.map((row) => row.map((c) => (c.time ?? Infinity)));
    if (m?.durations) return m.durations.map((row) => row.map((t) => t ?? Infinity));
  } catch (err) {
    console.warn("Matrice Valhalla non disponibile, stimo in linea d'aria:", err);
  }
  const kmh = MODES[state.mode].speed;
  return points.map((a) => points.map((b) => (haversine(a, b) * 1.3 * 3600) / kmh));
}

// Ordine migliore: partenza fissa, arrivo libero / fisso / ritorno alla partenza
function solveOrder(C, startIdx, endIdx, loop) {
  const n = C.length;
  const middle = [...Array(n).keys()].filter((i) => i !== startIdx && i !== endIdx);
  const cost = (mid) => {
    let seq = [startIdx, ...mid];
    if (endIdx != null) seq.push(endIdx);
    if (loop) seq.push(startIdx);
    let c = 0;
    for (let i = 0; i < seq.length - 1; i++) c += C[seq[i]][seq[i + 1]];
    return c;
  };

  let best;
  if (middle.length <= 8) {
    // Ricerca esaustiva
    let bestCost = Infinity;
    const perm = (arr, k) => {
      if (k === arr.length) {
        const c = cost(arr);
        if (c < bestCost) (bestCost = c), (best = arr.slice());
        return;
      }
      for (let i = k; i < arr.length; i++) {
        [arr[k], arr[i]] = [arr[i], arr[k]];
        perm(arr, k + 1);
        [arr[k], arr[i]] = [arr[i], arr[k]];
      }
    };
    perm(middle.slice(), 0);
  } else {
    // Vicino più prossimo + 2-opt
    const left = new Set(middle);
    best = [];
    let cur = startIdx;
    while (left.size) {
      let nx = null;
      for (const j of left) if (nx == null || C[cur][j] < C[cur][nx]) nx = j;
      best.push(nx);
      left.delete(nx);
      cur = nx;
    }
    let bestCost = cost(best);
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < best.length - 1; i++) {
        for (let j = i + 1; j < best.length; j++) {
          const cand = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
          const c = cost(cand);
          if (c + 1e-6 < bestCost) (best = cand), (bestCost = c), (improved = true);
        }
      }
    }
  }
  const seq = [startIdx, ...best];
  if (endIdx != null) seq.push(endIdx);
  if (loop) seq.push(startIdx);
  return seq;
}

function decodePolyline(str, precision = 6) {
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  const factor = 10 ** precision;
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

async function routeValhalla(points) {
  const legs = [];
  const coords = [];
  for (let i = 0; i < points.length - 1; i += VALHALLA_MAX_ROUTE - 1) {
    const chunk = points.slice(i, i + VALHALLA_MAX_ROUTE);
    const data = await valhalla("route", {
      locations: chunk.map((p) => ({ lat: p.lat, lon: p.lon, type: "break" })),
      ...costing(),
      directions_type: "none",
      units: "kilometers",
    });
    for (const leg of data.trip.legs) {
      legs.push({ km: leg.summary.length, sec: leg.summary.time });
      coords.push(...decodePolyline(leg.shape, 6));
    }
  }
  return { legs, coords, source: "Valhalla · OpenStreetMap" };
}

async function routeOSRM(points) {
  const profile = MODES[state.mode].osrm;
  const path = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const r = await fetch(`${OSRM}/routed-${profile}/route/v1/driving/${path}?overview=full&geometries=geojson&steps=false`);
  const data = await r.json();
  if (data.code !== "Ok") throw new Error(data.message || "OSRM non disponibile");
  const rt = data.routes[0];
  return {
    legs: rt.legs.map((l) => ({ km: l.distance / 1000, sec: l.duration })),
    coords: rt.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    source: `OSRM · OpenStreetMap${state.mode === "moto" ? " (profilo auto: Valhalla non raggiungibile)" : ""}`,
  };
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Il browser non supporta la posizione."));
    if (!isSecureContext) return reject(new Error("La posizione funziona solo in HTTPS: apri il sito con l'indirizzo https di Tailscale (tailscale serve)."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error("Non riesco a leggere la posizione. Controlla i permessi del browser.")),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });
}

function showMe() {
  if (!me) return;
  if (meMarker) meMarker.setLatLng([me.lat, me.lon]);
  else
    meMarker = L.marker([me.lat, me.lon], {
      icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false,
    }).addTo(map);
}

let routeRun = 0;
async function computeRoute() {
  const run = ++routeRun; // un nuovo calcolo annulla quelli ancora in corso
  const btn = $("#btn-route");
  btn.disabled = true;
  try {
    if (state.stops.some((s) => s.lat == null && s.status !== "missing")) await geocodeAll();
    const usable = state.stops.filter((s) => s.lat != null);
    const skipped = state.stops.length - usable.length;

    let points = usable.map((s) => ({ name: s.query, lat: s.lat, lon: s.lon, stopId: s.id }));
    if (state.start === "here") {
      setStatus("Leggo la tua posizione…");
      me = await getPosition();
      showMe();
      points = [{ name: "La tua posizione", lat: me.lat, lon: me.lon, stopId: null }, ...points];
    }
    if (points.length < 2) throw new Error("Servono almeno due punti trovati sulla mappa.");

    const loop = state.end === "loop";
    const endIdx = state.end === "last" && points.length > 2 ? points.length - 1 : null;
    let seq;
    if (state.optimize && points.length > 2) {
      setStatus("Calcolo l'ordine più veloce…");
      const C = await timeMatrix(points);
      seq = solveOrder(C, 0, endIdx, loop);
    } else {
      seq = [...points.keys()];
      if (loop) seq.push(0);
    }
    const ordered = seq.map((i) => points[i]);

    setStatus("Disegno il percorso…");
    let res;
    try {
      res = await routeValhalla(ordered);
    } catch (err) {
      console.warn("Valhalla non disponibile, uso OSRM:", err);
      res = await routeOSRM(ordered);
    }

    if (run !== routeRun) return;
    route = { points: ordered, ...res, loop };
    if (state.optimize) {
      // Riordina la lista come il percorso, così numeri in lista e sulla mappa coincidono
      const byId = new Map(state.stops.map((s) => [s.id, s]));
      const orderedIds = [...new Set(ordered.map((p) => p.stopId).filter(Boolean))];
      state.stops = [...orderedIds.map((id) => byId.get(id)), ...state.stops.filter((s) => !orderedIds.includes(s.id))];
      save();
    }
    renderStops();
    drawRoute();
    renderResult();
    if (skipped) toast(`${skipped} tappe non trovate sono state escluse dal percorso.`);
    if (innerWidth < 900) $("#sheet").dataset.state = "half";
    $("#result").scrollIntoView({ behavior: "smooth", block: "start" });
    fitTo(route.coords);
  } catch (err) {
    console.error(err);
    if (run === routeRun) toast(err.message || "Non sono riuscito a calcolare il percorso. Riprova tra poco.");
  } finally {
    if (run === routeRun) {
      setStatus(null);
      btn.disabled = false;
    }
  }
}

function drawRoute() {
  routeLayer.clearLayers();
  if (!route) return;
  const color = modeColor();
  const dash = state.mode === "piedi" ? "2 9" : state.mode === "bici" ? "10 8" : null;
  L.polyline(route.coords, { color: dark.matches ? "#0b0d12" : "#ffffff", weight: 10, opacity: 0.9, lineCap: "round", lineJoin: "round" }).addTo(routeLayer);
  L.polyline(route.coords, { color, weight: 6, opacity: 1, lineCap: "round", lineJoin: "round", dashArray: dash }).addTo(routeLayer);
  renderMarkers();
}

/* ---------- Risultato ---------- */

function fmtTime(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

function gmapsUrl(points) {
  const enc = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  u.searchParams.set("origin", enc(points[0]));
  u.searchParams.set("destination", enc(points.at(-1)));
  const wp = points.slice(1, -1);
  if (wp.length) u.searchParams.set("waypoints", wp.map(enc).join("|"));
  u.searchParams.set("travelmode", MODES[state.mode].gmaps);
  return u.toString();
}

function renderResult() {
  const totKm = route.legs.reduce((a, l) => a + l.km, 0);
  const totSec = route.legs.reduce((a, l) => a + l.sec, 0);
  $("#sum-dist").textContent = totKm < 10 ? totKm.toFixed(1).replace(".", ",") : Math.round(totKm);
  const m = Math.round(totSec / 60);
  if (m < 60) {
    $("#sum-time").textContent = m;
    $("#sum-time-unit").textContent = "minuti";
  } else {
    $("#sum-time").textContent = `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
    $("#sum-time-unit").textContent = "ore";
  }
  $("#sum-stops").textContent = new Set(route.points.filter((p) => p.stopId).map((p) => p.stopId)).size;

  const legs = $("#legs");
  legs.innerHTML = "";
  route.points.forEach((p, i) => {
    const li = document.createElement("li");
    const isStart = i === 0;
    const leg = route.legs[i - 1];
    const label = isStart ? "A" : route.loop && i === route.points.length - 1 ? "A" : i;
    li.innerHTML = `
      <span class="pin ${isStart || label === "A" ? "start" : ""}">${label}</span>
      <span class="name">${escapeHtml(p.name)}</span>
      <span class="meta">${leg ? `${leg.km.toFixed(1).replace(".", ",")} km<br>${fmtTime(leg.sec)}` : "partenza"}</span>`;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => map.flyTo([p.lat, p.lon], 17, { duration: 0.6 }));
    legs.appendChild(li);
  });

  // Google Maps accetta al massimo 9 tappe intermedie per link: divido in tratte
  const links = $("#gmaps-links");
  links.innerHTML = "";
  const chunks = [];
  for (let i = 0; i < route.points.length - 1; i += 10) chunks.push(route.points.slice(i, i + 11));
  chunks.forEach((c, k) => {
    const a = document.createElement("a");
    a.className = "gmaps";
    a.href = gmapsUrl(c);
    a.target = "_blank";
    a.rel = "noopener";
    a.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 11l18-8-8 18-2-8z" fill="currentColor"/></svg>${
      chunks.length > 1 ? `Naviga tratta ${k + 1}` : "Naviga con Google Maps"
    }`;
    links.appendChild(a);
  });
  $("#route-source").textContent = `Percorso: ${route.source}. ${MODES[state.mode].label}${
    state.mode === "moto" ? ` · ${state.moto}` : ""
  }. I tempi non includono soste e traffico in tempo reale.`;
  $("#result").hidden = false;
}

function exportGPX() {
  if (!route) return;
  const esc = (s) => escapeHtml(s);
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Itinera" xmlns="http://www.topografix.com/GPX/1/1">
${route.points.map((p, i) => `  <wpt lat="${p.lat}" lon="${p.lon}"><name>${i}. ${esc(p.name)}</name></wpt>`).join("\n")}
  <trk><name>Itinera – ${esc(MODES[state.mode].label)}</name><trkseg>
${route.coords.map(([la, lo]) => `    <trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"/>`).join("\n")}
  </trkseg></trk>
</gpx>`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([gpx], { type: "application/gpx+xml" }));
  a.download = `itinera-${state.mode}.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function copyList() {
  if (!route) return;
  const text = route.points.map((p, i) => `${i === 0 ? "Partenza" : i}. ${p.name}`).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Elenco copiato.");
  } catch {
    toast("Copia non permessa dal browser.");
  }
}

function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* ---------- Eventi ---------- */

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  document.querySelectorAll(".mode").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
  $("#moto-opts").hidden = mode !== "moto";
  save();
}
function setMoto(style) {
  state.moto = style;
  document.querySelectorAll("[data-moto]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.moto === style)));
  $("#moto-hint").textContent =
    style === "panoramico"
      ? "Panoramico: niente autostrade né pedaggi, preferisce statali e provinciali. Ideale per un giro in moto."
      : "Veloce: profilo moto con autostrade ammesse, niente sterrati e nessuna penalità di traffico cittadino.";
  save();
}

document.querySelectorAll(".mode").forEach((b) =>
  b.addEventListener("click", () => {
    const had = Boolean(route);
    setMode(b.dataset.mode);
    if (had) computeRoute();
  }),
);
document.querySelectorAll("[data-moto]").forEach((b) =>
  b.addEventListener("click", () => {
    setMoto(b.dataset.moto);
    if (route) computeRoute();
  }),
);

$("#file").addEventListener("change", (e) => handleImage(e.target.files[0]));
const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add("drag"))));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("drag")));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  handleImage(e.dataTransfer.files[0]);
});
document.addEventListener("paste", (e) => {
  const img = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (img) handleImage(img.getAsFile());
});

$("#add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#add-input").value;
  if (!v.trim()) return;
  addStops(v.includes("\n") ? parseLines(v) : [v]);
  $("#add-input").value = "";
  geocodeAll();
});
$("#add-input").addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text") || "";
  if (text.includes("\n")) {
    e.preventDefault();
    addStops(parseLines(text));
    geocodeAll();
  }
});

$("#area").addEventListener("change", (e) => {
  state.area = e.target.value.trim();
  // con una zona nuova rifaccio le ricerche non riuscite
  state.stops.forEach((s) => s.status === "missing" && Object.assign(s, { status: "pending" }));
  save();
  renderStops();
});
$("#start").addEventListener("change", (e) => ((state.start = e.target.value), save()));
$("#end").addEventListener("change", (e) => ((state.end = e.target.value), save()));
$("#optimize").addEventListener("change", (e) => ((state.optimize = e.target.checked), save()));
$("#btn-route").addEventListener("click", computeRoute);
$("#btn-gpx").addEventListener("click", exportGPX);
$("#btn-copy").addEventListener("click", copyList);
$("#btn-clear").addEventListener("click", () => {
  state.stops = [];
  invalidateRoute();
  save();
  renderStops();
});
$("#btn-sample").addEventListener("click", () => {
  state.area = SAMPLE.area;
  $("#area").value = SAMPLE.area;
  state.stops = SAMPLE.stops.map(([q, lat, lon]) => ({ id: uid(), query: q, lat, lon, status: "ok", detail: `${q}, Roma` }));
  invalidateRoute();
  save();
  renderStops();
  computeRoute();
});
$("#btn-locate").addEventListener("click", async () => {
  try {
    me = await getPosition();
    showMe();
    map.flyTo([me.lat, me.lon], 15, { duration: 0.6 });
  } catch (err) {
    toast(err.message);
  }
});

// Pannello trascinabile (telefono)
const sheet = $("#sheet");
const STATES = ["peek", "half", "full"];
let dragY = null;
$("#grabber").addEventListener("pointerdown", (e) => {
  dragY = e.clientY;
  e.target.setPointerCapture?.(e.pointerId);
});
$("#grabber").addEventListener("pointerup", (e) => {
  if (dragY == null) return;
  const dy = e.clientY - dragY;
  dragY = null;
  let i = STATES.indexOf(sheet.dataset.state);
  if (Math.abs(dy) < 8) i = i === 2 ? 1 : i + 1; // tocco: espandi a giro
  else i = Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1)));
  sheet.dataset.state = STATES[i];
  setTimeout(() => map.invalidateSize(), 350);
});

/* ---------- Avvio ---------- */

load();
setMode(state.mode);
setMoto(state.moto);
$("#area").value = state.area;
$("#start").value = state.start;
$("#end").value = state.end;
$("#optimize").checked = state.optimize;
renderStops();
const known = state.stops.filter((s) => s.lat != null);
if (known.length) fitTo(known.map((s) => [s.lat, s.lon]));

fetch("/api/config")
  .then((r) => (r.ok ? r.json() : {}))
  .then((c) => (serverConfig = { ...serverConfig, ...c }))
  .catch(() => {});

if (!state.stops.length) $("#btn-sample").click();
