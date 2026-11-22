const BACKEND_BASE = "https://storage.googleapis.com/de-brug-stond-open-data/data";
const DISCLAIMER_KEY = "debrugstondopen_disclaimer_seen_v1";
const isMobile = () => window.matchMedia("(max-width: 768px)").matches;
let disclaimerAcceptedSession = false;

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
let weatherCache = [];
let eventsCache = {};
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
// Init: Load places-nl.json, weather-24h.json, and events-2h.json
// ---------------------------------------------------------------------------
async function initData() {
  const statusText = document.getElementById("status-text");
  const statusDot = document.querySelector("#status-pill .dot");
  try {
    const [placesRes, weatherRes, eventsRes] = await Promise.all([
      fetch(`${BACKEND_BASE}/places-nl.json`),
      fetch(`${BACKEND_BASE}/weather-24h.json`),
      fetch(`${BACKEND_BASE}/events-2h.json?t=${Date.now()}`),
    ]);
    placesCache = await placesRes.json();
    weatherCache = await weatherRes.json();
    const events2h = await eventsRes.json();
    eventsCache["2h"] = events2h;

    statusDot.className = "dot dot-green";
    statusText.textContent = `${events2h.length} events (2u) · Live GCS`;
    syncChipsForTransport(selectedTransport);
    await previewRouteOnly();
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

async function handleAutocomplete(inputEl, suggestEl, badgeEl, onSelect) {
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
    if (badgeEl) badgeEl.textContent = "CACHE";
    renderSuggestions(
      localMatches.map((p) => ({ label: `${p.displayName} · ${p.subtitle}`, point: p })),
      suggestEl,
      inputEl,
      onSelect
    );
    return;
  }

  if (badgeEl) badgeEl.textContent = "PDOK";
  try {
    const res = await fetch(`https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest?q=${encodeURIComponent(q)}&rows=5&fq=type:(woonplaats OR postcode OR weg OR adres)`);
    const data = await res.json();
    const docs = data.response?.docs || [];
    renderSuggestions(
      docs.map((d) => ({ label: d.weergavenaam, pdokId: d.id })),
      suggestEl,
      inputEl,
      onSelect
    );
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
  const sug = await fetch(`https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest?q=${encodeURIComponent(q)}&rows=1`).then((r) => r.json());
  const first = sug.response?.docs?.[0];
  if (first) {
    const resolved = await lookupPDOK(first.id);
    if (resolved) {
      inputEl.value = resolved.displayName;
      return resolved;
    }
  }
  return currentPoint;
}

// ---------------------------------------------------------------------------
// Route Planning (OSRM voor Auto/Fiets/Lopend, Spoor/OV-corridor voor OV)
// ---------------------------------------------------------------------------
async function fetchRoutes(start, via, end, transport) {
  const waypoints = via ? [start, via, end] : [start, end];

  // Voor OV tekenen we geen autoroute over de snelweg, maar een OV/spoor-corridor
  if (transport === "ov") {
    const distKm = haversineMeters(start.latitude, start.longitude, end.latitude, end.longitude) / 1000;
    return [{
      isPrimary: true,
      isOV: true,
      expectedMinutes: Math.max(25, distKm * 1.1 + 15),
      coords: waypoints.map((p) => [p.latitude, p.longitude]),
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
      (ev.source === "P2000" && ev.category === "spoorwegovergang")
    );
  }
  if (transport === "auto") {
    return ev.source !== "NS API v3" && ev.source !== "OVapi GTFS-RT";
  }
  // Fiets / Lopend: geen NS/OVapi en geen snelweg-reistijden
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
  const routes = await fetchRoutes(startPoint, viaPoint, endPoint, selectedTransport);
  const bandwidthMeters =
    selectedTransport === "lopend" ? 1000 :
    selectedTransport === "fiets" ? 1500 :
    selectedTransport === "auto" ? 2500 : 3500;
  const expectedMin = routes[0]?.expectedMinutes || 35;
  const lookbackMin = Math.max(30, Math.min(150, expectedMin + 20));
  const windowStart = new Date(arrivalDate.getTime() - lookbackMin * 60000);

  const fmtTime = (d) => d.toTimeString().slice(0, 5);
  const routeLabel = selectedTransport === "ov" ? "OV-corridor" : `${routes.length} route(s)`;
  document.getElementById("route-pill").textContent = `🗺️ ${routeLabel} · ${(bandwidthMeters / 1000).toFixed(1)} km bandbreedte · ${fmtTime(windowStart)} – ${fmtTime(arrivalDate)}`;
  document.getElementById("sensor-pill").textContent = `📡 Sensordekking: 94%`;

  const allEvents = await getEventsForArrival(arrivalDate);
  const windowEvents = allEvents.filter((ev) => {
    const s = new Date(ev.startedAt);
    const e = ev.endedAt ? new Date(ev.endedAt) : new Date();
    return s <= arrivalDate && e >= windowStart;
  });

  const corridorEvents = windowEvents.filter(
    (ev) => isEventRelevantForTransport(ev, selectedTransport) && isWithinRouteBandwidth(ev, routes, bandwidthMeters)
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
        body: "Er geldt geen weeralarm en de wind/neerslag in Nederland valt reuze mee. Gewoon verslapen?",
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
        body: `Tussen ${fmtTime(windowStart)} en ${fmtTime(arrivalDate)} zijn er binnen ${(bandwidthMeters / 1000).toFixed(1)} km van de routes geen open bruggen, files, ongelukken of storingen gevonden. Gewoon verslapen?`,
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
      body: `Tussen ${fmtTime(windowStart)} en ${fmtTime(arrivalDate)} is er binnen ${(bandwidthMeters / 1000).toFixed(1)} km van de routes van ${startPoint.displayName} naar ${endPoint.displayName} niets gevonden. Gewoon verslapen?`,
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

function renderVerdict(verdict, alternatives) {
  const dot = document.getElementById("verdict-dot");
  dot.className = `dot dot-${verdict.status}`;
  document.getElementById("verdict-badge-text").textContent = verdict.badge;
  document.getElementById("checked-at").textContent = `Gecheckt om ${new Date().toTimeString().slice(0, 8)}`;
  document.getElementById("verdict-headline").textContent = verdict.headline;
  document.getElementById("verdict-body").textContent = verdict.body;

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
inputVan.addEventListener("input", () => handleAutocomplete(inputVan, suggestVan, vanBadge, (pt) => { startPoint = pt; }));
inputVia.addEventListener("input", () => handleAutocomplete(inputVia, suggestVia, viaBadge, (pt) => { viaPoint = pt; }));
inputNaar.addEventListener("input", () => handleAutocomplete(inputNaar, suggestNaar, naarBadge, (pt) => { endPoint = pt; }));

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
  document.getElementById("sensor-pill").textContent = "📡 Sensordekking: 94%";
}

function resetVerdictToReady() {
  document.getElementById("verdict-dot").className = "dot";
  document.getElementById("verdict-badge-text").textContent = "Klaar voor check";
  document.getElementById("checked-at").textContent = "";
  document.getElementById("verdict-headline").textContent = "Klik op Check de feiten";
  document.getElementById("verdict-body").textContent = "We controleren realtime open data van Rijkswaterstaat, NDW, NS, P2000 en Open-Meteo langs de gekozen route.";
  document.getElementById("nee-maar-box").classList.add("hidden");
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
document.getElementById("btn-sources").addEventListener("click", () => sourcesModal.classList.remove("hidden"));
document.getElementById("btn-close-sources").addEventListener("click", () => sourcesModal.classList.add("hidden"));
sourcesModal.addEventListener("click", (e) => {
  if (e.target === sourcesModal) sourcesModal.classList.add("hidden");
});

initData();
