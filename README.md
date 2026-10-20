# Itinera

Carichi la foto di una lista di posti (scritta a mano, screenshot, volantino…) e Itinera:

1. legge i luoghi dalla foto (AI con Claude se configurata, altrimenti OCR nel browser),
2. li trova sulla mappa (OpenStreetMap),
3. calcola l'ordine più veloce per visitarli e disegna il percorso,
4. ti dà il link per navigare con Google Maps, l'export GPX e l'elenco copiabile.

Mezzi: **Auto**, **Moto** (profilo moto vero di Valhalla: "Veloce" oppure "Panoramico" senza autostrade e pedaggi), **Bici**, **A piedi**.

Puoi anche scrivere o incollare i luoghi a mano, trascinare i segnaposto per correggerli, scegliere partenza (prima tappa o la tua posizione) e arrivo (dove conviene, ultima tappa, ritorno alla partenza).

## Avvio

Serve Node.js 18 o più recente.

```bash
cd itinera
npm install
npm start            # http://localhost:5180
```

Variabili facoltative:

| Variabile | Default | A cosa serve |
|---|---|---|
| `PORT` | `5180` | Porta del server |
| `HOST` | `0.0.0.0` | Interfaccia di ascolto |
| `ANTHROPIC_API_KEY` | – | Attiva la lettura delle foto con Claude (molto più precisa dell'OCR, legge anche la scrittura a mano). Senza chiave si usa Tesseract nel browser. |

## Usarlo dal telefono con Tailscale

Sul computer che resta acceso (con Tailscale attivo):

```bash
cd itinera && npm install
npm start                       # oppure: pm2 start server.mjs --name itinera
tailscale serve --bg 5180       # pubblica in HTTPS solo dentro la tua tailnet
```

Poi sul telefono (con l'app Tailscale connessa) apri `https://<nome-pc>.<tua-tailnet>.ts.net`.
Da Safari/Chrome usa "Aggiungi a schermata Home" per averla come un'app.

- `tailscale serve` richiede MagicDNS e i certificati HTTPS attivi nella console di Tailscale (DNS → HTTPS Certificates).
- Funziona anche `http://100.x.y.z:5180` (IP Tailscale del PC), ma senza HTTPS il browser non concede la posizione GPS, quindi "Dalla mia posizione" non funziona.

## Servizi usati

Tutti gratuiti e senza chiave, chiamati direttamente dal browser:

- Mappa: OpenStreetMap (tile standard di tile.openstreetmap.org)
- Ricerca luoghi: Nominatim (max 1 richiesta al secondo), Photon come riserva
- Percorsi e matrice dei tempi: Valhalla (valhalla1.openstreetmap.de), OSRM (routing.openstreetmap.de) come riserva
- OCR: Tesseract.js (il modello di lingua ita+eng si scarica la prima volta)

Sono server pubblici a uso moderato: vanno benissimo per uso personale. I tempi non includono traffico in tempo reale.
