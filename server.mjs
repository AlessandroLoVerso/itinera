// Itinera — server statico + estrazione luoghi da foto (opzionale, via Claude).
// Avvio: `npm install && npm start`  →  http://0.0.0.0:5180
// Variabili: PORT (default 5180), HOST (default 0.0.0.0), ANTHROPIC_API_KEY (opzionale).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5180;
const HOST = process.env.HOST || "0.0.0.0";

// Cartelle servite: /  → public/,  /vendor/* → librerie da node_modules
const ROUTES = [
  ["/vendor/leaflet/", path.join(here, "node_modules/leaflet/dist/")],
  ["/vendor/tesseract/", path.join(here, "node_modules/tesseract.js/dist/")],
  ["/vendor/tesseract-core/", path.join(here, "node_modules/tesseract.js-core/")],
  ["/", path.join(here, "public/")],
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

let anthropic = null;
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropic = new Anthropic();
  } catch (err) {
    console.warn("SDK Anthropic non disponibile, uso solo l'OCR nel browser:", err.message);
  }
}

const PLACES_SCHEMA = {
  type: "object",
  properties: {
    area: { type: "string", description: "Città o zona comune a tutti i luoghi, se deducibile; altrimenti stringa vuota" },
    places: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nome del luogo come appare nella foto" },
          query: { type: "string", description: "Testo di ricerca per un geocoder (nome + indirizzo + città)" },
        },
        required: ["name", "query"],
        additionalProperties: false,
      },
    },
  },
  required: ["area", "places"],
  additionalProperties: false,
};

async function extractPlaces(imageBase64, mediaType, hint) {
  const response = await anthropic.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: PLACES_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          {
            type: "text",
            text:
              "La foto contiene un elenco (scritto a mano, stampato, uno screenshot, una mappa o un volantino) " +
              "di luoghi da visitare. Estrai ogni luogo nell'ordine in cui compare. Per ognuno scrivi una query " +
              "adatta a un geocoder OpenStreetMap: nome, indirizzo se presente, città. Ignora testo che non è un luogo." +
              (hint ? ` Zona indicata dall'utente: ${hint}.` : ""),
          },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error("La richiesta è stata rifiutata dal modello.");
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return JSON.parse(text);
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req, limit = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Immagine troppo grande (max 15 MB)."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  for (const [prefix, dir] of ROUTES) {
    if (!pathname.startsWith(prefix)) continue;
    const file = path.join(dir, pathname.slice(prefix.length));
    if (!file.startsWith(dir)) return send(res, 403, { error: "forbidden" });
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return send(res, 404, "Non trovato", "text/plain; charset=utf-8");
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": prefix === "/" ? "no-cache" : "public, max-age=86400",
      });
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/config") {
      return send(res, 200, { aiExtraction: Boolean(anthropic) });
    }
    if (req.url === "/api/extract" && req.method === "POST") {
      if (!anthropic) return send(res, 501, { error: "Estrazione AI non configurata sul server." });
      const { image, mediaType, hint } = JSON.parse(await readBody(req));
      if (!image || !/^image\/(png|jpeg|gif|webp)$/.test(mediaType)) {
        return send(res, 400, { error: "Formato immagine non supportato (usa JPG, PNG, WEBP o GIF)." });
      }
      return send(res, 200, await extractPlaces(image, mediaType, hint));
    }
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
    send(res, 405, { error: "method not allowed" });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message || "Errore interno" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Itinera in ascolto su http://${HOST}:${PORT}`);
  console.log(anthropic ? "Estrazione AI dalle foto: attiva" : "Estrazione AI non attiva: uso l'OCR nel browser");
});
