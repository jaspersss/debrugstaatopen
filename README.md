# 🌉 debrugstaatopen.nl — *De brug stond open*

> **Smoes-check voor collega's op basis van Nederlandse open data.**  
> *Vul in waar je collega vandaan komt, hoe laat hij of zij binnenliep, het vervoermiddel en de smoes — en check binnen 5 seconden of de data in het voordeel van je collega spreekt.*

> **Let op (Disclaimer):** Dit project is bedoeld als een luchtige, grappige fact-check bij het koffiezetapparaat. We doen ons best om alle open data zo accuraat mogelijk weer te geven, maar geven geen garanties en de app is **nadrukkelijk niet** bedoeld voor formele beoordelingen, verzuimregistratie of juridische bewijsvoering.

---

## ✨ Wat doet het?

- **4-Velden Smoes-check:** *Van* (optioneel met *Via*), *Naar*, *Nu / Andere datum & tijd*, *Vervoermiddel* (`Auto`, `OV`, `Fiets`, `Lopend`) en *De Smoes* (`Brug stond open`, `File / Drukte`, `Wegwerkzaamheden`, `Ongeluk / 112`, `Trein vertraagd`, `Bus / Tram uitgevallen`, `Pont voer niet`, `Tegenwind / Regen`, `Storm / Code Geel`, `Overig`).
- **Route + Bandbreedte:** In plaats van heel Nederland of een te brede cirkel te checken, berekent de app echte routes (incl. alternatieven) en kijkt uitsluitend binnen een strakke bandbreedte (`1.0 – 3.5 km` afhankelijk van het vervoermiddel) en een meeschuivend tijdvenster.
- **Verdict + "Nee, maar..." Counter & Alibi-menu:**
  - **Alibi waterdicht (Groen):** De smoes klopt.
  - **Smoes ontkracht (Rood):** Niets gevonden, mét een *"Nee, maar..."*-hint als er wél iets anders langs die route speelde.
  - **Alibi-menu:** Leesbare vervolgvragen met plaatsnaam en tijdstip (*"Brug stond open bij Terneuzen"*).
- **Privacy by design:** Slaat geen namen, accounts of zoekopdrachten op.

---

## 🏗️ Architectuur (Hoe we het gebouwd hebben)

```text
[ Open Data Feeds ] ──(elke 60s)──▶ [ Cloud Run (Python) ] ──▶ [ Cloud Storage (gzip JSON) ]
                                                                          │
        ┌─────────────────────────────────────────────────────────────────┴────────────────────┐
        ▼                                                                                      ▼
[ Website (web/) ]                                                                  [ Mac / iPhone App ]
HTML / CSS / JS + Leaflet + OSRM + PDOK                                             SwiftUI (Liquid Glass) + MapKit
```

### 1. Exception-only Backend (`backend/`)
In plaats van een zware database of het opslaan van normale situaties bewaart de Python-backend **uitsluitend afwijkingen** (open bruggen, files, wegwerkzaamheden, ongelukken, treinstoringen) en schrijft die als statische `gzip`-gecomprimeerde JSON-bestanden weg naar **Google Cloud Storage** (`europe-west4`):
- `events-2h.json` — Snelle live-check (afwijkingen van de laatste 2 uur).
- `events-YYYY-MM-DD.json` — Dagarchieven (30 dagen bewaard).
- `weather-24h.json` — Uurlijkse wind, windrichting en neerslag voor 12 Nederlandse regio's (elke 15 min ververst).
- `sensors.json` — Bekende brugsensoren in de NDW-feed (1x per 24u).
- `places-nl.json` — ~2.900 Nederlandse woonplaatsen en NS-stations (1x per week ververst voor 0 ms autocomplete).

### 2. Gebruikte Open Data & API's
- **NDW / Rijkswaterstaat (DATEX II):** `planningsfeed_brugopeningen.xml.gz`, `actueel_beeld.xml.gz`, `veiligheidsgerelateerde_informatie_srti.xml.gz`, `tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz`, `planningsfeed_wegwerkzaamheden_en_evenementen.xml.gz`, `traveltime.xml.gz` + `reistijden_configuratie_meetlocaties.xml.gz`.
- **NS API v3 & v2:** Treinstoringen (`disruptions/v3`, gefilterd op daadwerkelijk actieve trajectverstoringen) & NL-stations (`v2/stations`).
- **P2000 (Alarmeringen.nl RSS):** Uitsluitend verkeers- en weertrefwoorden (medische meldingen en huisnummers worden gefilterd).
- **Open-Meteo & Buienradar JSON-feed:** Uurlijkse windkracht (Beaufort), tegenwindcomponent en weeralarms.
- **PDOK Locatieserver & BRT Achtergrondkaart:** Nederlandse adres-/postcode-geocoding en kaarttegels.
- **OSRM / Apple MapKit (`MKDirections`):** Gratis routeplanning op web (`OSRM`) en macOS/iOS (`MKDirections`).

### 3. Website (`web/`)
- Gebouwd in pure **HTML / CSS / JavaScript** zonder build-step, klaar voor **GitHub Pages** (`web/CNAME` → `debrugstaatopen.nl`).
- **Desktop & Tablet:** 2-koloms Liquid Glass layout met automatische Light/Dark Mode.
- **Mobiel (`<= 768px`):** Zero-scroll one-screen invoerscherm met dynamische smoezen per vervoermiddel, een `📍` GPS-knopje en een apart resultaat-scherm.

### 4. Native Mac & iPhone App (`Stond de brug open?/`)
- Multiplatform **SwiftUI** app met **Liquid Glass**, native **MapKit**-corridorkaart en een swappable `HistoryBufferProviding`-architectuur.

---

## 🚀 Lokaal draaien

### Website testen
```bash
cd web
python3 -m http.server 8000
# Open http://localhost:8000
```

### Backend lokaal testen
```bash
cd backend
pip install -r requirements.txt
export NS_API_KEY="jouw-ns-api-key"
export GCS_BUCKET="jouw-gcs-bucket"
python3 -m flask --app main run --port 8080
```

### Mac / iPhone App
Open `Stond de brug open?.xcodeproj` in Xcode en run op **My Mac** of **iPhone Simulator**.

---

## 📄 Licentie

Uitgebracht onder de [MIT License](LICENSE).
