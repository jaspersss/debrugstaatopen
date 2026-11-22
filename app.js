const BACKEND_BASE = "https://storage.googleapis.com/de-brug-stond-open-data/data";
const OV_ROUTE_API = "https://dbso-backend-ncyabkmr7a-ez.a.run.app/ov-route";
const DISCLAIMER_KEY = "debrugstondopen_disclaimer_seen_v1";
const SITE_URL = "https://debrugstaatopen.nl";
const urlParams = new URLSearchParams(window.location.search);
const isKlasMode = urlParams.get("mode") === "klas" || urlParams.get("embed") === "1";
const presetVan = (urlParams.get("van") || "").trim();
const presetVia = (urlParams.get("via") || "").trim();
const presetNaar = (urlParams.get("naar") || "").trim();
const presetVervoer = (urlParams.get("vervoer") || "").trim();
const presetSmoes = (urlParams.get("smoes") || "").trim();
const presetTijd = (urlParams.get("tijd") || "").trim();
const shouldAutoRun = urlParams.get("auto") === "1";
const isMobile = () => window.matchMedia("(max-width: 768px)").matches;
let disclaimerAcceptedSession = isKlasMode || shouldAutoRun;
let lastShareText = "";
let lastCheckedArrivalDate = new Date();

if (isKlasMode) {
  document.body.classList.add("mode-klas");
  const subEl = document.querySelector(".sidebar-header p");
  if (subEl) subEl.textContent = "Vul in terwijl de leerling z'n tas nog uitpakt.";
  const lblVan = document.querySelector('label[for="input-van"]');
  if (lblVan) lblVan.textContent = "1. VAN (VERTREK LEERLING)";
  const lblNaar = document.querySelector('label[for="input-naar"]');
  if (lblNaar) lblNaar.textContent = "2. NAAR (SCHOOL / HIER)";
  const lblSmoes = document.querySelector("#excuse-chips")?.previousElementSibling;
  if (lblSmoes) lblSmoes.textContent = "4. DE SMOES VAN DE LEERLING";
}

function hasAcceptedDisclaimer() {
  if (disclaimerAcceptedSession) return true;
  try {
    return localStorage.getItem(DISCLAIMER_KEY) === "1";
  } catch {
    return false;
  }
}

function markDisclaimerAccepted() {
  disclaimerAcceptedSession = true;
  try {
    localStorage.setItem(DISCLAIMER_KEY, "1");
  } catch {
    // file:// of privémodus kan localStorage blokkeren; session flag vangt dit op
  }
}

// State
let placesCache = [];
let railGraph = {};
let weatherCache = [];
let eventsCache = {};
let lastDataUpdateDate = null;
let startPoint = { id: "ut", displayName: "Utrecht Centraal", latitude: 52.0894, longitude: 5.1100 };
let viaPoint = null;
let endPoint = { id: "amf", displayName: "Amersfoort Centraal", latitude: 52.1539, longitude: 5.3706 };
let selectedTransport = "auto";
let selectedExcuse = "brugOpen";
let useCustomTime = false;

// Leaflet Map (Gratis Nederlandse PDOK BRT Achtergrondkaart — geen API-key nodig!)
const tileUrl = "https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/grijs/EPSG:3857/{z}/{x}/{y}.png";

const map = L.map("map", { zoomControl: false }).setView([52.12, 5.24], 11);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer(tileUrl, { attribution: "&copy; Kadaster / PDOK BRT", maxZoom: 18 }).addTo(map);
const routeLayerGroup = L.layerGroup().addTo(map);

// DOM elements
const inputVan = document.getElementById("input-van");
const inputVia = document.getElementById("input-via");
const inputNaar = document.getElementById("input-naar");
const suggestVan = document.getElementById("suggest-van");
const suggestVia = document.getElementById("suggest-via");
const suggestNaar = document.getElementById("suggest-naar");
const vanBadge = document.getElementById("van-badge");
const viaBadge = document.getElementById("via-badge");
const naarBadge = document.getElementById("naar-badge");
const viaGroup = document.getElementById("via-group");
const btnToggleVia = document.getElementById("btn-toggle-via");
const btnClearVia = document.getElementById("btn-clear-via");
const customTimeRow = document.getElementById("custom-time-row");
const inputDate = document.getElementById("input-date");
const inputTime = document.getElementById("input-time");
const btnCheck = document.getElementById("btn-check");

// Initialize date & time to now
const nowInit = new Date();
inputDate.value = nowInit.toISOString().slice(0, 10);
inputTime.value = nowInit.toTimeString().slice(0, 5);

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Init: Load places-nl.json, weather-24h.json, and events-2h.json
// ---------------------------------------------------------------------------
async function fetchStaticJson(filename) {
  try {
    const localRes = await fetch(`data/${filename}`);
    if (localRes.ok) return localRes;
  } catch {}
  return fetch(`${BACKEND_BASE}/${filename}`);
}

async function initData() {
  const statusCount = document.getElementById("status-count");
  const statusDot = document.querySelector("#status-pill .dot");
  try {
    const [placesRes, weatherRes, eventsRes, railRes] = await Promise.all([
      fetchStaticJson("places-nl.json"),
      fetch(`${BACKEND_BASE}/weather-24h.json`),
      fetch(`${BACKEND_BASE}/events-2h.json?t=${Date.now()}`),
      fetchStaticJson("rail-nl.json").catch(() => null),
    ]);
    placesCache = await placesRes.json();
    weatherCache = await weatherRes.json();
    if (railRes && railRes.ok) {
      const edges = await railRes.json();
      const graph = {};
      for (const e of edges) {
        if (!graph[e.from]) graph[e.from] = [];
        if (!graph[e.to]) graph[e.to] = [];
        graph[e.from].push({ next: e.to, km: e.km, coords: e.coords });
        graph[e.to].push({ next: e.from, km: e.km, coords: [...e.coords].reverse() });
      }
      railGraph = graph;
    }
    const lastModHeader = eventsRes.headers.get("last-modified");
    const events2h = await eventsRes.json();
    eventsCache["2h"] = events2h;

    if (lastModHeader) {
      lastDataUpdateDate = new Date(lastModHeader);
    } else if (events2h.length) {
      lastDataUpdateDate = new Date(Math.max(...events2h.map((e) => new Date(e.startedAt).getTime())));
    }

    statusDot.className = "dot dot-green";
    statusCount.textContent = `${events2h.length} events (2u)`;
    if (["auto", "ov", "fiets", "lopend"].includes(presetVervoer)) {
      selectedTransport = presetVervoer;
      document.querySelectorAll("#transport-seg .seg-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.mode === selectedTransport);
      });
    }
    syncChipsForTransport(selectedTransport);
    if (presetSmoes) {
      const matchChip = document.querySelector(`#excuse-chips .chip[data-excuse="${CSS.escape(presetSmoes)}"]`);
      if (matchChip) {
        selectedExcuse = presetSmoes;
        document.querySelectorAll("#excuse-chips .chip").forEach((c) => {
          c.classList.toggle("active", c === matchChip);
        });
      }
    }
    if (presetTijd) {
      const parsedTijd = new Date(presetTijd);
      if (!isNaN(parsedTijd.getTime())) {
        useCustomTime = true;
        const pad = (n) => String(n).padStart(2, "0");
        inputDate.value = `${parsedTijd.getFullYear()}-${pad(parsedTijd.getMonth() + 1)}-${pad(parsedTijd.getDate())}`;
        inputTime.value = `${pad(parsedTijd.getHours())}:${pad(parsedTijd.getMinutes())}`;
        btnTimeNow.classList.remove("active");
        btnTimeCustom.classList.add("active");
        customTimeRow.classList.remove("hidden");
      }
    }
    if (presetVan) {
      inputVan.value = presetVan;
      const resolvedVan = await resolveQuery(presetVan);
      if (resolvedVan) {
        startPoint = resolvedVan;
        inputVan.value = resolvedVan.displayName;
      }
    }
    if (presetVia) {
      viaGroup.classList.remove("hidden");
      btnAddVia.classList.add("hidden");
      inputVia.value = presetVia;
      const resolvedVia = await resolveQuery(presetVia);
      if (resolvedVia) {
        viaPoint = resolvedVia;
        inputVia.value = resolvedVia.displayName;
      }
    }
    if (presetNaar) {
      inputNaar.value = presetNaar;
      const resolvedNaar = await resolveQuery(presetNaar);
      if (resolvedNaar) {
        endPoint = resolvedNaar;
        inputNaar.value = resolvedNaar.displayName;
      }
    }
    if (shouldAutoRun) {
      await runCheck(true);
    } else {
      await previewRouteOnly();
    }
  } catch (err) {
    statusDot.className = "dot dot-red";
    statusText.textContent = "Backend tijdelijk onbereikbaar";
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Autocomplete: 0ms places-nl.json + live PDOK fallback for exact addresses
// ---------------------------------------------------------------------------
function looksLikeExactAddress(q) {
  return /\d/.test(q) || (q.includes(" ") && q.length > 12);
}

const autocompleteTimers = new WeakMap();
const autocompleteSeq = new WeakMap();

function scheduleAutocomplete(inputEl, suggestEl, badgeEl, onSelect) {
  const prev = autocompleteTimers.get(inputEl);
  if (prev) clearTimeout(prev);
  const seq = (autocompleteSeq.get(inputEl) || 0) + 1;
  autocompleteSeq.set(inputEl, seq);

  // Direct lokale 0ms matches tonen als die er zijn
  const q = inputEl.value.trim();
  if (q.length < 2) {
    suggestEl.classList.add("hidden");
    return;
  }
  const ql = q.toLowerCase();
  const localMatches = placesCache
    .filter((p) => p.displayName.toLowerCase().startsWith(ql))
    .concat(placesCache.filter((p) => !p.displayName.toLowerCase().startsWith(ql) && p.displayName.toLowerCase().includes(ql)))
    .slice(0, 6);

  if (!looksLikeExactAddress(q) && localMatches.length > 0) {
    renderSuggestions(
      localMatches.map((p) => ({ label: `${p.displayName} · ${p.subtitle}`, point: p })),
      suggestEl,
      inputEl,
      onSelect
    );
    return;
  }

  // Debounce live PDOK + Photon calls (250ms) zodat snel typen geen 429 of stale resultaten geeft
  const timer = setTimeout(() => {
    handleAutocomplete(inputEl, suggestEl, badgeEl, onSelect, seq);
  }, 250);
  autocompleteTimers.set(inputEl, timer);
}

async function handleAutocomplete(inputEl, suggestEl, badgeEl, onSelect, seq) {
  const q = inputEl.value.trim();
  if (q.length < 2) {
    suggestEl.classList.add("hidden");
    return;
  }

  const ql = q.toLowerCase();
  const localMatches = placesCache
    .filter((p) => p.displayName.toLowerCase().startsWith(ql))
    .concat(placesCache.filter((p) => !p.displayName.toLowerCase().startsWith(ql) && p.displayName.toLowerCase().includes(ql)))
    .slice(0, 4);

  try {
    const [pdokRes, photonRes] = await Promise.all([
      fetch(`https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest?q=${encodeURIComponent(q)}&rows=4&fq=type:(woonplaats OR postcode OR weg OR adres)`)
        .then((r) => r.json())
        .catch(() => ({})),
      fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=52.1&lon=5.2&limit=5&lang=en`)
        .then((r) => r.json())
        .catch(() => ({})),
    ]);

    if (autocompleteSeq.get(inputEl) !== seq) return;

    const pdokItems = (pdokRes.response?.docs || []).map((d) => ({ label: d.weergavenaam, pdokId: d.id }));
    const seenPoi = new Set();
    const photonItems = [];
    for (const f of (photonRes.features || [])) {
      if (f.properties?.countrycode !== "NL" || !f.properties?.name) continue;
      const p = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      const city = p.city || p.town || p.village || p.state || "Nederland";
      const key = `${p.name.toLowerCase()}|${city.toLowerCase()}`;
      if (seenPoi.has(key)) continue;
      seenPoi.add(key);
      photonItems.push({
        label: `${p.name} · ${city} (POI)`,
        point: { id: `poi-${p.osm_id || p.name}`, displayName: `${p.name}, ${city}`, latitude: lat, longitude: lon },
      });
    }

    const combined = [...localMatches.map((p) => ({ label: `${p.displayName} · ${p.subtitle}`, point: p })), ...photonItems, ...pdokItems].slice(0, 7);
    renderSuggestions(combined, suggestEl, inputEl, onSelect);
  } catch {
    suggestEl.classList.add("hidden");
  }
}

function renderSuggestions(items, suggestEl, inputEl, onSelect) {
  if (!items.length) {
    suggestEl.classList.add("hidden");
    return;
  }
  suggestEl.innerHTML = "";
  for (const item of items) {
    const div = document.createElement("div");
    div.className = "suggestion-item";
    div.textContent = item.label;
    div.addEventListener("click", async () => {
      let pt = item.point;
      if (!pt && item.pdokId) {
        pt = await lookupPDOK(item.pdokId);
      }
      if (pt) {
        onSelect(pt);
        inputEl.value = pt.displayName;
        suggestEl.classList.add("hidden");
      }
    });
    suggestEl.appendChild(div);
  }
  suggestEl.classList.remove("hidden");
}

async function lookupPDOK(id) {
  const res = await fetch(`https://api.pdok.nl/bzk/locatieserver/search/v3_1/lookup?id=${encodeURIComponent(id)}`);
  const data = await res.json();
  const doc = data.response?.docs?.[0];
  if (!doc || !doc.centroide_ll) return null;
  const [lon, lat] = doc.centroide_ll.replace("POINT(", "").replace(")", "").split(" ").map(Number);
  return { id: doc.id, displayName: doc.weergavenaam, latitude: lat, longitude: lon };
}

async function resolveTypedInputIfNeeded(inputEl, currentPoint) {
  const q = inputEl.value.trim();
  if (!q || q === currentPoint.displayName) return currentPoint;
  const ql = q.toLowerCase();
  if (!looksLikeExactAddress(q)) {
    const match = placesCache.find((p) => p.displayName.toLowerCase().startsWith(ql)) ||
                  placesCache.find((p) => p.displayName.toLowerCase().includes(ql));
    if (match) {
      inputEl.value = match.displayName;
      return match;
    }
  }
  const hasDigits = /\d/.test(q);
  const [sug, photon] = await Promise.all([
    fetch(`https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest?q=${encodeURIComponent(q)}&rows=1`).then((r) => r.json()).catch(() => ({})),
    fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=52.1&lon=5.2&limit=3&lang=en`).then((r) => r.json()).catch(() => ({})),
  ]);
  const nlPoi = (photon.features || []).find((f) => f.properties?.countrycode === "NL" && f.properties?.name);
  // Als er geen huisnummer/postcode in staat en Photon vindt een exacte POI, geef de POI voorrang op PDOK
  if (!hasDigits && nlPoi && nlPoi.properties.name.toLowerCase().includes(q.toLowerCase())) {
    const [lon, lat] = nlPoi.geometry.coordinates;
    const city = nlPoi.properties.city || nlPoi.properties.state || "Nederland";
    const resolved = { id: `poi-${nlPoi.properties.osm_id || q}`, displayName: `${nlPoi.properties.name}, ${city}`, latitude: lat, longitude: lon };
    inputEl.value = resolved.displayName;
    return resolved;
  }
  const first = sug.response?.docs?.[0];
  if (first) {
    const resolved = await lookupPDOK(first.id);
    if (resolved) {
      inputEl.value = resolved.displayName;
      return resolved;
    }
  }
  if (nlPoi) {
    const [lon, lat] = nlPoi.geometry.coordinates;
    const city = nlPoi.properties.city || nlPoi.properties.state || "Nederland";
    const resolved = { id: `poi-${nlPoi.properties.osm_id || q}`, displayName: `${nlPoi.properties.name}, ${city}`, latitude: lat, longitude: lon };
    inputEl.value = resolved.displayName;
    return resolved;
  }
  return currentPoint;
}

// ---------------------------------------------------------------------------
// Route Planning (OSRM voor Auto/Fiets/Lopend, Spoor/OV-corridor voor OV)
// ---------------------------------------------------------------------------
function findRailShortestPath(fromCode, toCode) {
  if (!railGraph[fromCode] || !railGraph[toCode]) return null;
  if (fromCode === toCode) return { km: 0, coords: [] };
  const dist = { [fromCode]: 0 };
  const prev = {};
  const visited = new Set();
  const queue = [fromCode];

  while (queue.length) {
    queue.sort((a, b) => dist[a] - dist[b]);
    const u = queue.shift();
    if (u === toCode) break;
    if (visited.has(u)) continue;
    visited.add(u);

    for (const edge of railGraph[u] || []) {
      const alt = dist[u] + edge.km;
      if (alt < (dist[edge.next] ?? Infinity)) {
        dist[edge.next] = alt;
        prev[edge.next] = { node: u, coords: edge.coords };
        queue.push(edge.next);
      }
    }
  }

  if (!prev[toCode]) return null;
  const segments = [];
  let cur = toCode;
  while (prev[cur]) {
    segments.push(prev[cur].coords);
    cur = prev[cur].node;
  }
  segments.reverse();
  const coords = [];
  for (const seg of segments) {
    for (const pt of seg) {
      if (!coords.length || coords[coords.length - 1][0] !== pt[0] || coords[coords.length - 1][1] !== pt[1]) {
        coords.push(pt);
      }
    }
  }
  return { km: dist[toCode], coords };
}

async function fetchRoutes(start, via, end, transport) {
  const waypoints = via ? [start, via, end] : [start, end];

  // Voor OV gebruiken we primair de exacte NS Spoorkaart-geometrie (rail-nl.json)
  if (transport === "ov") {
    const stations = placesCache.filter((p) => p.kind === "station" && p.id.startsWith("nl-station-"));
    const nearestSt = (lat, lon) => {
      let best = null, bd = Infinity;
      for (const s of stations) {
        const code = s.id.replace("nl-station-", "").toLowerCase();
        if (!railGraph[code]) continue;
        const d = (s.latitude - lat) ** 2 + (s.longitude - lon) ** 2;
        if (d < bd) { bd = d; best = { st: s, code }; }
      }
      return best;
    };

    const sA = nearestSt(start.latitude, start.longitude);
    const sB = nearestSt(end.latitude, end.longitude);
    const sV = via ? nearestSt(via.latitude, via.longitude) : null;

    if (sA && sB && Object.keys(railGraph).length > 0) {
      const legs = sV ? [[sA.code, sV.code], [sV.code, sB.code]] : [[sA.code, sB.code]];
      let totalKm = 0;
      const fullCoords = [[start.latitude, start.longitude]];
      let ok = true;
      for (const [c1, c2] of legs) {
        const res = findRailShortestPath(c1, c2);
        if (!res) { ok = false; break; }
        totalKm += res.km;
        for (const pt of res.coords) fullCoords.push(pt);
      }
      if (ok && fullCoords.length >= 2) {
        fullCoords.push([end.latitude, end.longitude]);
        return [{
          isPrimary: true,
          isOV: true,
          expectedMinutes: Math.max(20, totalKm * 0.85 + 15),
          coords: fullCoords,
        }];
      }
    }

    try {
      const qs = new URLSearchParams({
        fromLat: start.latitude,
        fromLon: start.longitude,
        toLat: end.latitude,
        toLon: end.longitude,
      });
      if (via) {
        qs.set("viaLat", via.latitude);
        qs.set("viaLon", via.longitude);
      }
      const res = await fetch(`${OV_ROUTE_API}?${qs.toString()}`);
      const data = await res.json();
      if (data.routes?.length) {
        return data.routes;
      }
    } catch (e) {
      console.warn("OV route fallback:", e);
    }
    const hubNames = ["utrecht centraal", "amsterdam centraal", "rotterdam centraal", "den haag centraal", "eindhoven centraal", "arnhem centraal", "zwolle", "amsterdam zuid", "schiphol airport"];
    const fallbackNearestSt = (lat, lon) => {
      let best = null, bd = Infinity;
      for (const s of stations) {
        const d = (s.latitude - lat) ** 2 + (s.longitude - lon) ** 2;
        if (d < bd) { bd = d; best = s; }
      }
      return best;
    };
    const stA = fallbackNearestSt(start.latitude, start.longitude);
    const stB = fallbackNearestSt(end.latitude, end.longitude);
    const coords = [[start.latitude, start.longitude]];
    if (stA) coords.push([stA.latitude, stA.longitude]);
    if (via) {
      const stV = nearestSt(via.latitude, via.longitude);
      if (stV) coords.push([stV.latitude, stV.longitude]);
    } else if (stA && stB && haversineMeters(stA.latitude, stA.longitude, stB.latitude, stB.longitude) > 15000) {
      // Kies eventueel een groot overstapknooppunt binnen de corridor
      const direct = haversineMeters(stA.latitude, stA.longitude, stB.latitude, stB.longitude);
      let bestHub = null, bestRatio = 1.25;
      for (const h of stations.filter((s) => hubNames.includes(s.displayName.toLowerCase()))) {
        if (h.id === stA.id || h.id === stB.id) continue;
        const viaD = haversineMeters(stA.latitude, stA.longitude, h.latitude, h.longitude) + haversineMeters(h.latitude, h.longitude, stB.latitude, stB.longitude);
        if (viaD / direct < bestRatio) {
          bestRatio = viaD / direct;
          bestHub = h;
        }
      }
      if (bestHub) coords.push([bestHub.latitude, bestHub.longitude]);
    }
    if (stB && (!stA || stB.id !== stA.id)) coords.push([stB.latitude, stB.longitude]);

    // Voeg alleen voorwaartse NS-stations (tussen 5% en 95% langs het segment, max 1.8 km zijwaarts) toe
    const detailedCoords = [[start.latitude, start.longitude]];
    const railAnchors = coords.slice(1);
    for (let i = 0; i < railAnchors.length - 1; i++) {
      const [aLat, aLon] = railAnchors[i];
      const [bLat, bLon] = railAnchors[i + 1];
      detailedCoords.push([aLat, aLon]);

      const cosLat = Math.cos((aLat * Math.PI) / 180);
      const dx = (bLon - aLon) * cosLat;
      const dy = bLat - aLat;
      const lenSq = dx * dx + dy * dy;
      if (lenSq > 0) {
        const intermediates = stations
          .map((s) => {
            const sx = (s.longitude - aLon) * cosLat;
            const sy = s.latitude - aLat;
            const t = (sx * dx + sy * dy) / lenSq;
            const dLine = pointToSegmentMeters(s.latitude, s.longitude, aLat, aLon, bLat, bLon);
            return { s, t, dLine };
          })
          .filter((x) => x.t > 0.06 && x.t < 0.94 && x.dLine < 1800)
          .sort((x, y) => x.t - y.t);

        for (const item of intermediates) {
          const prev = detailedCoords[detailedCoords.length - 1];
          if (haversineMeters(prev[0], prev[1], item.s.latitude, item.s.longitude) > 3000) {
            detailedCoords.push([item.s.latitude, item.s.longitude]);
          }
        }
      }
    }
    if (railAnchors.length) {
      detailedCoords.push(railAnchors[railAnchors.length - 1]);
    }
    if (detailedCoords[detailedCoords.length - 1][0] !== end.latitude || detailedCoords[detailedCoords.length - 1][1] !== end.longitude) {
      detailedCoords.push([end.latitude, end.longitude]);
    }
    const distKm = haversineMeters(start.latitude, start.longitude, end.latitude, end.longitude) / 1000;
    return [{
      isPrimary: true,
      isOV: true,
      expectedMinutes: Math.max(25, distKm * 1.1 + 15),
      coords: detailedCoords,
    }];
  }

  const profile = transport === "fiets" ? "cycling" : (transport === "lopend" ? "walking" : "driving");
  const coordStr = waypoints.map((p) => `${p.longitude},${p.latitude}`).join(";");
  const alts = via ? "false" : "true";
  const url = `https://router.project-osrm.org/route/v1/${profile}/${coordStr}?alternatives=${alts}&overview=full&geometries=geojson`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.code === "Ok" && data.routes?.length) {
      return data.routes.slice(0, 3).map((r, idx) => ({
        isPrimary: idx === 0,
        isOV: false,
        expectedMinutes: r.duration / 60,
        coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
      }));
    }
  } catch (e) {
    console.warn("OSRM fallback:", e);
  }
  return [{
    isPrimary: true,
    isOV: false,
    expectedMinutes: 35,
    coords: waypoints.map((p) => [p.latitude, p.longitude]),
  }];
}

function isPontEvent(ev) {
  const t = (ev.title || "").toLowerCase();
  const s = (ev.source || "").toLowerCase();
  return t.includes("veer") || t.includes("pont") || s.includes("veer");
}

function isEventRelevantForTransport(ev, transport) {
  // Negeer oude OVapi-events die op het tijdelijke Utrecht-middelpunt stonden
  if (ev.source === "OVapi GTFS-RT" && Math.abs(ev.latitude - 52.0907) < 0.0001 && Math.abs(ev.longitude - 5.1214) < 0.0001) {
    return false;
  }
  if (transport === "ov") {
    return (
      ev.source === "NS API v3" ||
      ev.source === "OVapi GTFS-RT" ||
      ev.category === "brugOpen" ||
      ev.category === "weer" ||
      isPontEvent(ev) ||
      (ev.source === "P2000" && ev.category === "spoorwegovergang")
    );
  }
  if (transport === "auto") {
    // Auto mag alleen over autoveer/pont als die op de OSRM-autoroute ligt (OSRM driving mijdt voetveren automatisch)
    if (isPontEvent(ev)) return true;
    return ev.source !== "NS API v3" && ev.source !== "OVapi GTFS-RT";
  }
  // Fiets / Lopend: altijd pontjes/veren en bruggen toestaan, geen NS/trein of snelweg-reistijden
  if (isPontEvent(ev) || ev.category === "brugOpen") return true;
  return ev.source !== "NS API v3" && ev.source !== "OVapi GTFS-RT" && ev.source !== "NDW Reistijden";
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pointToSegmentMeters(pLat, pLon, aLat, aLon, bLat, bLon) {
  const cosLat = Math.cos((pLat * Math.PI) / 180);
  const px = pLon * cosLat, py = pLat;
  const ax = aLon * cosLat, ay = aLat;
  const bx = bLon * cosLat, by = bLat;
  const dx = bx - ax, dy = by - ay;
  let t = 0;
  if (dx !== 0 || dy !== 0) {
    t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  }
  const projLat = ay + t * dy;
  const projLon = (ax + t * dx) / cosLat;
  return haversineMeters(pLat, pLon, projLat, projLon);
}

function isWithinRouteBandwidth(event, routes, bandwidthMeters) {
  for (const r of routes) {
    for (let i = 0; i < r.coords.length - 1; i++) {
      const [aLat, aLon] = r.coords[i];
      const [bLat, bLon] = r.coords[i + 1];
      if (pointToSegmentMeters(event.latitude, event.longitude, aLat, aLon, bLat, bLon) <= bandwidthMeters) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fact-Check Evaluation
// ---------------------------------------------------------------------------
async function getEventsForArrival(arrivalDate) {
  const now = new Date();
  const diffHours = (now - arrivalDate) / 3600000;
  if (diffHours <= 2 && diffHours >= -0.2) {
    if (!eventsCache["2h"]) {
      eventsCache["2h"] = await fetch(`${BACKEND_BASE}/events-2h.json?t=${Date.now()}`).then((r) => r.json());
    }
    return eventsCache["2h"];
  }
  const dateStr = arrivalDate.toISOString().slice(0, 10);
  if (!eventsCache[dateStr]) {
    const res = await fetch(`${BACKEND_BASE}/events-${dateStr}.json?t=${Date.now()}`);
    if (res.ok) eventsCache[dateStr] = await res.json();
    else return eventsCache["2h"] || [];
  }
  return eventsCache[dateStr];
}

function kmhToBeaufort(kmh) {
  const bounds = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89];
  const idx = bounds.findIndex((b) => kmh < b);
  return idx === -1 ? 10 : idx;
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function checkWeatherAlibi(start, end, arrivalDate) {
  const midLat = (start.latitude + end.latitude) / 2;
  const midLon = (start.longitude + end.longitude) / 2;
  const targetHour = arrivalDate.toISOString().slice(0, 13) + ":00:00Z";

  // Zoek dichtstbijzijnde weerstation op dat uur
  let best = null;
  let bestDist = Infinity;
  for (const row of weatherCache) {
    if (row.hour !== targetHour) continue;
    const d = haversineMeters(midLat, midLon, row.latitude, row.longitude);
    if (d < bestDist) {
      bestDist = d;
      best = row;
    }
  }
  if (!best) return null;

  const bft = kmhToBeaufort(best.windSpeedKmh);
  const routeBearing = bearingDeg(start.latitude, start.longitude, end.latitude, end.longitude);
  const diff = Math.abs((((best.windDirectionDeg - routeBearing + 540) % 360) - 180));
  const isHeadwind = diff <= 65;
  const summary = `Windkracht ${bft} Bft (${Math.round(best.windSpeedKmh)} km/u, ${isHeadwind ? "tegenwind" : "zij-/meewind"}), neerslag ${best.precipitationMm.toFixed(1)} mm/u (${best.region}).`;

  if ((bft >= 5 && isHeadwind) || best.precipitationMm >= 2.0) {
    return { status: "green", badge: "Alibi waterdicht", headline: "Zwaar fietsweer bevestigd", body: `${summary} Je collega heeft een punt.` };
  }
  if (bft >= 4) {
    return { status: "orange", badge: "Twijfelgeval", headline: "Matige wind, geen storm", body: `${summary} Dat verklaart hooguit een paar minuten.` };
  }
  return { status: "red", badge: "Smoes ontkracht", headline: "Prima fietsweer op dit traject", body: `${summary} Je collega had gewoon geen zin om door te trappen.` };
}

async function runCheck(triggeredByUser = true) {
  if (triggeredByUser && !hasAcceptedDisclaimer()) {
    document.getElementById("disclaimer-modal").classList.remove("hidden");
    return;
  }

  btnCheck.disabled = true;
  const origBtnText = btnCheck.textContent;
  btnCheck.textContent = "⏳ Bezig met checken...";

  try {

  startPoint = await resolveTypedInputIfNeeded(inputVan, startPoint);
  if (!viaGroup.classList.contains("hidden") && inputVia.value.trim()) {
    viaPoint = await resolveTypedInputIfNeeded(inputVia, viaPoint || startPoint);
  } else {
    viaPoint = null;
  }
  endPoint = await resolveTypedInputIfNeeded(inputNaar, endPoint);

  const arrivalDate = useCustomTime
    ? new Date(`${inputDate.value}T${inputTime.value}:00`)
    : new Date();
  lastCheckedArrivalDate = arrivalDate;
  const routes = await fetchRoutes(startPoint, viaPoint, endPoint, selectedTransport);
  const bandwidthMeters =
    selectedTransport === "lopend" ? 1000 :
    selectedTransport === "fiets" ? 1500 :
    selectedTransport === "ov" ? 800 : 3500;
  const expectedMin = routes[0]?.expectedMinutes || 35;
  const lookbackMin = Math.max(30, Math.min(150, expectedMin + 20));
  const windowStart = new Date(arrivalDate.getTime() - lookbackMin * 60000);

  const fmtTime = (d) => d.toTimeString().slice(0, 5);
  const routeLabel = selectedTransport === "ov" ? "OV-corridor" : `${routes.length} route(s)`;
  document.getElementById("route-pill").textContent = `🗺️ ${routeLabel} · ${(bandwidthMeters / 1000).toFixed(1)} km bandbreedte · ${fmtTime(windowStart)} – ${fmtTime(arrivalDate)}`;

  const allEvents = await getEventsForArrival(arrivalDate);
  const windowEvents = allEvents.filter((ev) => {
    const s = new Date(ev.startedAt);
    const e = ev.endedAt ? new Date(ev.endedAt) : new Date();
    return s <= arrivalDate && e >= windowStart;
  });

function isNSTrajectRelevant(ev, routes) {
  if (ev.source !== "NS API v3") return true;
  // Als de storingstitel een of meer trajecten noemt ("Utrecht - Tiel; Utrecht - Eindhoven"),
  // check dan of minstens één van de andere genoemde plaatsen óók langs onze route ligt
  // (zodat "Utrecht - Tiel" niet matcht op Rotterdam -> Amersfoort).
  const segments = (ev.title || "").split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  const placeTokens = [];
  for (const seg of segments) {
    // Splits alleen op streepje MET spaties ("Utrecht - Driebergen-Zeist"), zodat koppeltekens in plaatsnamen heel blijven
    const parts = seg.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
      placeTokens.push(parts.map((p) => p.replace(/\.$/, "").trim().toLowerCase()));
    }
  }
  if (!placeTokens.length) return true;

  // Zoek alle bekende stations/plaatsen die binnen 1,5 km van onze route liggen
  const routeNames = new Set();
  for (const p of placesCache) {
    if (isWithinRouteBandwidth(p, routes, 1500)) {
      const full = p.displayName.toLowerCase().trim();
      routeNames.add(full);
      routeNames.add(full.replace(/\s+centraal$/, "").trim());
    }
  }

  for (const pair of placeTokens) {
    const matchCount = pair.filter((name) => {
      const clean = name.replace(/\s+centraal$/, "").trim();
      if (routeNames.has(clean) || routeNames.has(name)) return true;
      for (const rn of routeNames) {
        if (rn.startsWith(clean + " ") || clean.startsWith(rn + " ")) return true;
      }
      return false;
    }).length;
    // Beide kanten van het verstoorde traject (bijv. Utrecht én Driebergen-Zeist) liggen op onze route
    if (matchCount >= 2) return true;
  }
  return false;
}

  const corridorEvents = windowEvents.filter(
    (ev) =>
      isEventRelevantForTransport(ev, selectedTransport) &&
      isWithinRouteBandwidth(ev, routes, bandwidthMeters) &&
      isNSTrajectRelevant(ev, routes)
  );
  drawMap(routes, corridorEvents);

function matchesExcuse(ev, excuse) {
  const t = (ev.title || "").toLowerCase();
  switch (excuse) {
    case "brugOpen":
      return ev.category === "brugOpen";
    case "file":
      return ev.category === "file";
    case "wegwerkzaamheden":
      return ev.source === "NDW Wegwerkzaamheden" || ev.source === "NDW Afsluitingen" || t.includes("werkzaamheden") || t.includes("afgesloten");
    case "ongeluk":
      return ev.source === "P2000" || t.includes("ongeval") || t.includes("aanrijding") || t.includes("obstakel") || t.includes("stilstaand voertuig");
    case "treinStoring":
      return ev.source === "NS API v3" && !t.includes("streekvervoer");
    case "ovUitval":
      return ev.source === "OVapi GTFS-RT" || t.includes("streekvervoer");
    case "pont":
      return t.includes("veer") || t.includes("pont") || ev.source.toLowerCase().includes("veer");
    case "storm":
      return ev.category === "weer";
    default:
      return false;
  }
}

  const matches = corridorEvents.filter((ev) => matchesExcuse(ev, selectedExcuse));
  const alternatives = corridorEvents.filter((ev) => !matchesExcuse(ev, selectedExcuse));

function timeOfDayPunchline(arrivalDate) {
  const mins = arrivalDate.getHours() * 60 + arrivalDate.getMinutes();
  if (mins >= 5 * 60 && mins < 11 * 60 + 30) return "Gewoon verslapen?";
  if (mins >= 11 * 60 + 30 && mins < 17 * 60) return "Gewoon te laat vertrokken?";
  if (mins >= 17 * 60 && mins < 23 * 60) return "Gewoon de tijd uit het oog verloren?";
  return "Iets te gezellig blijven hangen?";
}

  const punchline = timeOfDayPunchline(arrivalDate);

  let verdict;
  if (selectedExcuse === "weer") {
    verdict = checkWeatherAlibi(startPoint, endPoint, arrivalDate) || {
      status: "orange",
      badge: "Geen weerdata",
      headline: "Geen uurlijkse weerdata voor dit tijdstip",
      body: "Voor deze datum/tijd zit er geen meting in weather-24h.json. Voordeel van de twijfel!",
    };
  } else if (selectedExcuse === "storm") {
    if (matches.length > 0) {
      verdict = {
        status: "green",
        badge: "Alibi waterdicht",
        headline: "Weeralarm actief!",
        body: `${matches[0].title} — ${matches[0].detail}`,
      };
    } else {
      const w = checkWeatherAlibi(startPoint, endPoint, arrivalDate);
      verdict = w || {
        status: "red",
        badge: "Smoes ontkracht",
        headline: "Geen storm of weeralarm",
        body: `Er geldt geen weeralarm en de wind/neerslag in Nederland valt reuze mee. ${punchline}`,
      };
    }
  } else if (selectedExcuse === "overig") {
    if (corridorEvents.length > 0) {
      const firstH = formatHumanEvent(corridorEvents[0]);
      verdict = {
        status: "orange",
        badge: "Mogelijk alibi",
        headline: "Er was inderdaad gedoe onderweg",
        body: `Niet specifiek benoemd, maar er was wel: ${firstH.displayTitle} (${firstH.sub}). Check het Alibi-menu om door te vragen!`,
      };
    } else {
      verdict = {
        status: "red",
        badge: "Smoes ontkracht",
        headline: "Hele route brandschoon!",
        body: `Tussen ${fmtTime(windowStart)} en ${fmtTime(arrivalDate)} zijn er binnen ${(bandwidthMeters / 1000).toFixed(1)} km van de routes geen open bruggen, files, ongelukken of storingen gevonden. ${punchline}`,
      };
    }
  } else if (matches.length > 0) {
    const firstH = formatHumanEvent(matches[0]);
    verdict = {
      status: "green",
      badge: "Alibi waterdicht",
      headline: "Je collega spreekt de waarheid!",
      body: `${firstH.displayTitle} (${firstH.sub}). Schenk maar vast een bakkie in.`,
    };
  } else {
    const labelMap = {
      brugOpen: "open bruggen",
      file: "files of drukte",
      wegwerkzaamheden: "wegwerkzaamheden of afsluitingen",
      ongeluk: "ongelukken of 112-meldingen",
      treinStoring: "NS-treinstoringen",
      ovUitval: "bus-, tram- of OV-uitval",
      pont: "uitgevallen pontjes of veren",
    };
    verdict = {
      status: "red",
      badge: "Smoes ontkracht",
      headline: `Geen ${labelMap[selectedExcuse] || "verstoringen"} op deze route`,
      body: `Tussen ${fmtTime(windowStart)} en ${fmtTime(arrivalDate)} is er binnen ${(bandwidthMeters / 1000).toFixed(1)} km van de routes van ${startPoint.displayName} naar ${endPoint.displayName} niets gevonden. ${punchline}`,
    };
  }

  renderVerdict(verdict, selectedExcuse === "overig" ? corridorEvents : alternatives);

  if (isMobile() && triggeredByUser) {
    document.body.classList.add("mobile-show-result");
    setTimeout(() => {
      map.invalidateSize();
      drawMap(routes, corridorEvents);
    }, 60);
  }
  } catch (err) {
    console.error("Check fout:", err);
  } finally {
    btnCheck.disabled = false;
    btnCheck.textContent = origBtnText;
  }
}

function nearestPlaceName(lat, lon) {
  if (!placesCache.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const p of placesCache) {
    const d = (p.latitude - lat) ** 2 + (p.longitude - lon) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  if (!best) return null;
  return best.displayName.split(",")[0].trim();
}

function humanSourceName(source) {
  const map = {
    "NS API v3": "NS Spoor",
    "NDW / Rijkswaterstaat": "Rijkswaterstaat",
    "NDW Actueel Beeld": "Verkeersinformatie",
    "NDW SRTI": "Verkeersinformatie",
    "NDW Afsluitingen": "Wegafsluitingen",
    "NDW Wegwerkzaamheden": "Wegwerkzaamheden",
    "NDW Reistijden": "Verkeersdrukte",
    "OVapi GTFS-RT": "Openbaar Vervoer",
    "P2000": "112-melding",
    "Weeralarm NL": "KNMI / Weeralarm",
  };
  return map[source] || source;
}

function formatHumanEvent(ev) {
  let title = (ev.title || "").replace(/\s*\(other\)/gi, "").trim();
  // Vervang technische brugcode door leesbare omschrijving
  if (title.startsWith("Brugopening (")) {
    title = "Brug stond open";
  }
  const place = nearestPlaceName(ev.latitude, ev.longitude);
  const displayTitle = place && !title.toLowerCase().includes(place.toLowerCase())
    ? `${title} bij ${place}`
    : title;

  const startStr = ev.startedAt ? new Date(ev.startedAt).toTimeString().slice(0, 5) : "";
  const timePart = startStr ? `Rond ${startStr}` : "";
  const sub = [timePart, humanSourceName(ev.source)].filter(Boolean).join(" · ");
  return { displayTitle, sub };
}

function updateShareActions(verdict) {
  const shareBox = document.getElementById("share-actions");
  const waBtn = document.getElementById("btn-share-wa");
  const copyBtn = document.getElementById("btn-copy-proof");
  if (!shareBox || !waBtn || !copyBtn) return;

  const vanName = startPoint?.displayName || "Vertrek";
  const naarName = endPoint?.displayName || "Bestemming";
  const shareParams = new URLSearchParams({
    van: vanName,
    naar: naarName,
    vervoer: selectedTransport,
    smoes: selectedExcuse,
    tijd: lastCheckedArrivalDate.toISOString(),
    auto: "1",
  });
  if (viaPoint?.displayName) {
    shareParams.set("via", viaPoint.displayName);
  }
  const shareUrl = `${SITE_URL}/?${shareParams.toString()}`;

  if (verdict.status === "green") {
    lastShareText = `🚨 Smoes-check: Het klopt écht! Op de route ${vanName} → ${naarName} was er hinder (${verdict.headline}). Alibi goedgekeurd! Bekijk bewijs: ${shareUrl}`;
  } else {
    lastShareText = `🕵️ Smoes-check: Geen open brug of vertraging gevonden op de route ${vanName} → ${naarName}... Tijd voor het Alibi-menu! Bekijk check: ${shareUrl}`;
  }

  waBtn.href = `https://wa.me/?text=${encodeURIComponent(lastShareText)}`;
  copyBtn.innerHTML = `<span>📋 Kopieer bewijs</span>`;
  shareBox.classList.remove("hidden");
}

function renderVerdict(verdict, alternatives) {
  const dot = document.getElementById("verdict-dot");
  dot.className = `dot dot-${verdict.status}`;
  document.getElementById("verdict-badge-text").textContent = verdict.badge;
  document.getElementById("checked-at").textContent = `Gecheckt om ${new Date().toTimeString().slice(0, 8)}`;
  document.getElementById("verdict-headline").textContent = verdict.headline;
  document.getElementById("verdict-body").textContent = verdict.body;
  updateShareActions(verdict);

  const neeMaarBox = document.getElementById("nee-maar-box");
  if (verdict.status !== "green" && alternatives.length > 0) {
    neeMaarBox.classList.remove("hidden");
    const firstHuman = formatHumanEvent(alternatives[0]);
    document.getElementById("nee-maar-text").textContent = `Er was wél iets anders langs deze route: ${firstHuman.displayTitle} (${firstHuman.sub}). Misschien bedoelde je collega dat?`;
  } else {
    neeMaarBox.classList.add("hidden");
  }

  const alibiSubtitle = document.getElementById("alibi-subtitle");
  const alibiList = document.getElementById("alibi-list");
  alibiList.innerHTML = "";
  if (!alternatives.length) {
    alibiSubtitle.classList.add("hidden");
    alibiList.innerHTML = `<p class="muted-small">Geen andere verstoringen langs deze route gevonden.</p>`;
    return;
  }
  alibiSubtitle.classList.remove("hidden");
  const icons = { brugOpen: "🌉", file: "🚗", treinStoring: "🚆", weer: "💨", spoorwegovergang: "🚧" };
  const uniqueAlts = [];
  const seenAlts = new Set();
  for (const ev of alternatives) {
    const h = formatHumanEvent(ev);
    const key = `${h.displayTitle}|${humanSourceName(ev.source)}`;
    if (!seenAlts.has(key)) {
      seenAlts.add(key);
      uniqueAlts.push({ ev, h });
    }
  }
  for (const { ev, h } of uniqueAlts.slice(0, 4)) {
    const div = document.createElement("div");
    div.className = "alibi-item";
    div.innerHTML = `<div class="alibi-item-title">${icons[ev.category] || "⚠️"} ${h.displayTitle}</div><div class="alibi-item-sub">${h.sub}</div>`;
    alibiList.appendChild(div);
  }
}

function drawMap(routes, events) {
  routeLayerGroup.clearLayers();
  const bounds = L.latLngBounds([[startPoint.latitude, startPoint.longitude], [endPoint.latitude, endPoint.longitude]]);

  for (const r of routes.filter((x) => !x.isPrimary)) {
    L.polyline(r.coords, { color: "#64748b", weight: 3, dashArray: "6 6", opacity: 0.6 }).addTo(routeLayerGroup);
    r.coords.forEach((c) => bounds.extend(c));
  }
  for (const r of routes.filter((x) => x.isPrimary)) {
    const lineColor = r.isOV ? "#7c3aed" : "#0052cc";
    const lineOpts = r.isOV
      ? { color: lineColor, weight: 4, dashArray: "8 6", opacity: 0.9 }
      : { color: lineColor, weight: 4, opacity: 0.9 };
    L.polyline(r.coords, { color: lineColor, weight: 16, opacity: 0.14 }).addTo(routeLayerGroup);
    L.polyline(r.coords, lineOpts).addTo(routeLayerGroup);
    r.coords.forEach((c) => bounds.extend(c));
  }

  L.circleMarker([startPoint.latitude, startPoint.longitude], { radius: 7, color: "#0f172a", fillColor: "#0f172a", fillOpacity: 1 })
    .bindTooltip(`A · ${startPoint.displayName}`)
    .addTo(routeLayerGroup);
  if (viaPoint) {
    L.circleMarker([viaPoint.latitude, viaPoint.longitude], { radius: 6, color: "#7c3aed", fillColor: "#ffffff", fillOpacity: 1, weight: 2 })
      .bindTooltip(`Via · ${viaPoint.displayName}`)
      .addTo(routeLayerGroup);
  }
  L.circleMarker([endPoint.latitude, endPoint.longitude], { radius: 7, color: "#0052cc", fillColor: "#0052cc", fillOpacity: 1 })
    .bindTooltip(`B · ${endPoint.displayName}`)
    .addTo(routeLayerGroup);

  const colorMap = { brugOpen: "#16a34a", file: "#d97706", treinStoring: "#dc2626", weer: "#0284c7", spoorwegovergang: "#ca8a04" };
  for (const ev of events.slice(0, 35)) {
    const h = formatHumanEvent(ev);
    L.circleMarker([ev.latitude, ev.longitude], {
      radius: 6,
      color: "#ffffff",
      weight: 1.5,
      fillColor: colorMap[ev.category] || "#64748b",
      fillOpacity: 0.95,
    })
      .bindPopup(`<strong>${h.displayTitle}</strong><br/><small>${h.sub}</small>`)
      .addTo(routeLayerGroup);
  }

  map.fitBounds(bounds.pad(0.2));
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------
inputVan.addEventListener("input", () => scheduleAutocomplete(inputVan, suggestVan, vanBadge, (pt) => { startPoint = pt; }));
inputVia.addEventListener("input", () => scheduleAutocomplete(inputVia, suggestVia, viaBadge, (pt) => { viaPoint = pt; }));
inputNaar.addEventListener("input", () => scheduleAutocomplete(inputNaar, suggestNaar, naarBadge, (pt) => { endPoint = pt; }));

btnToggleVia.addEventListener("click", () => {
  viaGroup.classList.remove("hidden");
  btnToggleVia.classList.add("hidden");
  inputVia.focus();
});

btnClearVia.addEventListener("click", () => {
  viaPoint = null;
  inputVia.value = "";
  suggestVia.classList.add("hidden");
  viaGroup.classList.add("hidden");
  btnToggleVia.classList.remove("hidden");
});

document.querySelectorAll("#time-mode-group .time-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#time-mode-group .time-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    useCustomTime = btn.dataset.timemode === "custom";
    customTimeRow.classList.toggle("hidden", !useCustomTime);
  });
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".field-group")) {
    suggestVan.classList.add("hidden");
    suggestVia.classList.add("hidden");
    suggestNaar.classList.add("hidden");
  }
});

async function previewRouteOnly() {
  const routes = await fetchRoutes(startPoint, viaPoint, endPoint, selectedTransport);
  drawMap(routes, []);
  const routeLabel = selectedTransport === "ov" ? "OV-corridor" : `${routes.length} route(s)`;
  document.getElementById("route-pill").textContent = `🗺️ ${routeLabel} · klaar voor check`;
}

function resetVerdictToReady() {
  document.getElementById("verdict-dot").className = "dot";
  document.getElementById("verdict-badge-text").textContent = "Klaar voor check";
  document.getElementById("checked-at").textContent = "";
  document.getElementById("verdict-headline").textContent = "Klik op Check de feiten";
  document.getElementById("verdict-body").textContent = "We controleren realtime open data van Rijkswaterstaat, NDW, NS, P2000 en Open-Meteo langs de gekozen route.";
  document.getElementById("nee-maar-box").classList.add("hidden");
  document.getElementById("share-actions")?.classList.add("hidden");
  document.getElementById("alibi-subtitle").classList.add("hidden");
  document.getElementById("alibi-list").innerHTML = `<p class="muted-small">Nog geen check uitgevoerd voor deze combinatie.</p>`;
}

function syncChipsForTransport(mode) {
  if (!isMobile()) {
    // Desktop & tablet: laat altijd alle smoezen zichtbaar
    document.querySelectorAll("#excuse-chips .chip").forEach((chip) => {
      chip.classList.remove("hidden");
    });
    return;
  }

  // Mobiel: toon alleen de relevante smoezen voor dit vervoermiddel (zodat je niet hoeft te scrollen)
  const defaultByMode = { auto: "brugOpen", ov: "treinStoring", fiets: "weer", lopend: "brugOpen" };
  let activeStillVisible = false;
  document.querySelectorAll("#excuse-chips .chip").forEach((chip) => {
    const allowed = (chip.dataset.modes || "").split(",").includes(mode);
    chip.classList.toggle("hidden", !allowed);
    if (allowed && chip.dataset.excuse === selectedExcuse) {
      activeStillVisible = true;
    }
  });
  if (!activeStillVisible) {
    selectedExcuse = defaultByMode[mode] || "brugOpen";
    document.querySelectorAll("#excuse-chips .chip").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.excuse === selectedExcuse);
    });
  }
}

window.addEventListener("resize", () => syncChipsForTransport(selectedTransport));

const btnMobileBack = document.getElementById("btn-mobile-back");
if (btnMobileBack) {
  btnMobileBack.addEventListener("click", () => {
    document.body.classList.remove("mobile-show-result");
  });
}

const btnGpsNaar = document.getElementById("btn-gps-naar");
if (btnGpsNaar) {
  btnGpsNaar.addEventListener("click", () => {
    if (!navigator.geolocation) return;
    btnGpsNaar.textContent = "⏳";
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        let label = "Huidige locatie (GPS)";
        try {
          const rev = await fetch(`https://api.pdok.nl/bzk/locatieserver/search/v3_1/reverse?lat=${latitude}&lon=${longitude}&rows=1`).then((r) => r.json());
          const doc = rev.response?.docs?.[0];
          if (doc?.weergavenaam) label = doc.weergavenaam;
        } catch {}
        endPoint = { id: "gps-now", displayName: label, latitude, longitude };
        inputNaar.value = label;
        btnGpsNaar.textContent = "📍";
      },
      () => {
        btnGpsNaar.textContent = "📍";
      },
      { enableHighAccuracy: false, timeout: 6000 }
    );
  });
}

document.querySelectorAll("#transport-group .seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#transport-group .seg-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    selectedTransport = btn.dataset.transport;
    syncChipsForTransport(selectedTransport);
    resetVerdictToReady();
    previewRouteOnly();
  });
});

document.querySelectorAll("#excuse-chips .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#excuse-chips .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    selectedExcuse = chip.dataset.excuse;
  });
});

btnCheck.addEventListener("click", () => runCheck(true));

document.getElementById("btn-accept-disclaimer").addEventListener("click", () => {
  markDisclaimerAccepted();
  document.getElementById("disclaimer-modal").classList.add("hidden");
  runCheck(true);
});

const sourcesModal = document.getElementById("sources-modal");
document.getElementById("btn-close-sources").addEventListener("click", () => sourcesModal.classList.add("hidden"));
sourcesModal.addEventListener("click", (e) => {
  if (e.target === sourcesModal) sourcesModal.classList.add("hidden");
});

function sourceUrlForName(name) {
  const n = name.toLowerCase();
  if (n.includes("ns")) return "https://www.ns.nl/reisinformatie/actuele-situatie-op-het-spoor";
  if (n.includes("ndw") || n.includes("rijkswaterstaat") || n.includes("rws")) return "https://rwsverkeersinfo.nl/";
  if (n.includes("ovapi") || n.includes("ndov")) return "https://www.ovapi.nl/";
  if (n.includes("p2000")) return "https://www.alarmeringen.nl/";
  if (n.includes("open-meteo") || n.includes("weer")) return "https://open-meteo.com/";
  if (n.includes("pdok") || n.includes("plaatsen")) return "https://www.pdok.nl/";
  if (n.includes("osrm")) return "https://project-osrm.org/";
  return "https://www.ndw.nu/";
}

function sourceDescriptionForName(name) {
  const n = name.toLowerCase();
  if (n.includes("ns")) return "Treinstoringen, spoorwegovergangen & NS Spoorkaart (rail-nl.json)";
  if (n.includes("ndw") || n.includes("rijkswaterstaat") || n.includes("rws")) return "Brugopeningen, files, verkeerssnelheden, incidenten & wegwerkzaamheden";
  if (n.includes("ovapi") || n.includes("ndov")) return "Vertragingen en uitval van bus, tram, metro en veerdiensten";
  if (n.includes("p2000")) return "112 verkeers- en weermeldingen (geanonimiseerd)";
  if (n.includes("open-meteo") || n.includes("weer")) return "Uurlijkse windkracht, windrichting en neerslag per regio";
  if (n.includes("pdok") || n.includes("plaatsen")) return "Woonplaatsen, stations & exacte adres-geocoding";
  if (n.includes("osrm")) return "Gratis routeplanning (incl. alternatieve routes)";
  return "Live open databron";
}

function openSourcesAndStatusModal() {
  const events2h = eventsCache["2h"] || [];
  const updatedEl = document.getElementById("status-updated-at");
  if (lastDataUpdateDate && !isNaN(lastDataUpdateDate.getTime())) {
    updatedEl.textContent = `Laatste update: ${lastDataUpdateDate.toLocaleString("nl-NL", { dateStyle: "medium", timeStyle: "medium" })} · ${events2h.length} actieve meldingen (2u)`;
  } else {
    updatedEl.textContent = `Laatste update: onbekend · ${events2h.length} actieve meldingen (2u)`;
  }

  const counts = {};
  for (const ev of events2h) {
    const label = humanSourceName(ev.source);
    counts[label] = (counts[label] || 0) + 1;
  }

  const rows = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      name,
      info: `${count} actieve melding(en) · ${sourceDescriptionForName(name)}`,
      url: sourceUrlForName(name),
      ok: true,
    }));

  rows.push({
    name: "Weer (Open-Meteo)",
    info: `${weatherCache.length} uurlijkse metingen geladen · ${sourceDescriptionForName("weer")}`,
    url: sourceUrlForName("weer"),
    ok: weatherCache.length > 0,
  });
  rows.push({
    name: "PDOK Locaties & Spoor (GitHub Pages CDN)",
    info: `${placesCache.length} locaties & ${railGraph ? Object.keys(railGraph).length : 0} spoorknooppunten · ${sourceDescriptionForName("pdok")}`,
    url: sourceUrlForName("pdok"),
    ok: placesCache.length > 0,
  });
  rows.push({
    name: "OSRM Routeplanner",
    info: sourceDescriptionForName("osrm"),
    url: sourceUrlForName("osrm"),
    ok: true,
  });

  const listEl = document.getElementById("status-breakdown");
  listEl.innerHTML = "";
  for (const r of rows) {
    const a = document.createElement("a");
    a.className = "alibi-item source-link-item";
    a.href = r.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.innerHTML = `<div class="source-link-head"><div class="alibi-item-title"><span class="dot ${r.ok ? "dot-green" : "dot-red"}"></span> ${r.name}</div><span class="source-ext">↗</span></div><div class="alibi-item-sub">${r.info}</div>`;
    listEl.appendChild(a);
  }
  sourcesModal.classList.remove("hidden");
}

document.getElementById("status-pill").addEventListener("click", openSourcesAndStatusModal);

const copyProofBtn = document.getElementById("btn-copy-proof");
if (copyProofBtn) {
  copyProofBtn.addEventListener("click", async () => {
    if (!lastShareText) return;
    try {
      await navigator.clipboard.writeText(lastShareText);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = lastShareText;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
    copyProofBtn.innerHTML = `<span>✅ Gekopieerd!</span>`;
    setTimeout(() => {
      copyProofBtn.innerHTML = `<span>📋 Kopieer bewijs</span>`;
    }, 2000);
  });
}

initData();
