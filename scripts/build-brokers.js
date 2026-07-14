// 20260701 RG - Genera src/data/brokers.json unendo due fonti pubbliche:
//   1) Data_Broker_Full_Registry_2025.csv — registri obbligatori degli stati USA
//      (Vermont, Texas, California, Oregon). Le email di privacy vengono da lì e
//      sono autorevoli: NON vanno mai inventate.
//   2) IAB Europe TCF Global Vendor List — vendor che trattano dati in UE. Espone
//      solo URL privacy, nessuna email: entrano quindi come contactMethod "form".
// Rilanciare con: node scripts/build-brokers.js
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const CSV = path.join(ROOT, "Data_Broker_Full_Registry_2025.csv");
const OUT = path.join(ROOT, "src", "data", "brokers.json");
const GVL_URL = "https://vendor-list.consensu.org/v3/vendor-list.json";

function parseCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ";") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Alcuni nomi nelle fonti arrivano con punteggiatura iniziale (es. ": Tappx").
const clean = (s) => (s || "").trim().replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function fromCsv() {
  if (!fs.existsSync(CSV)) {
    console.warn("CSV non trovato, salto la fonte USA:", CSV);
    return [];
  }
  const lines = fs.readFileSync(CSV, "utf8").split("\n");
  const hdr = parseCsvLine(lines[0]);
  const at = (f, n) => f[hdr.indexOf(n)] || "";

  const groups = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const f = parseCsvLine(lines[i]);
    const id = at(f, "GroupUUID_Combined");
    if (!id) continue;
    const g = groups.get(id) || { name: "", email: "", optout: "", addr: false, names: false, srcs: new Set() };
    g.name = g.name || clean(at(f, "Name"));
    g.email = g.email || clean(at(f, "Email"));
    g.optout = g.optout || clean(at(f, "OptOutURL"));
    if (at(f, "CollectsAddresses") === "1") g.addr = true;
    if (at(f, "CollectsNames") === "1") g.names = true;
    const s = clean(at(f, "RegistrySource"));
    if (s) g.srcs.add(s);
    groups.set(id, g);
  }

  const out = [];
  for (const g of groups.values()) {
    if (!g.name) continue;
    // Serve un canale reale: email (autorevole) oppure un URL di opt-out.
    const hasEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(g.email);
    if (!hasEmail && !g.optout) continue;

    const keys = ["email"];
    if (g.addr) keys.push("address");

    out.push({
      name: g.name,
      country: "US",
      legalBasis: "gdpr",
      contactMethod: hasEmail ? "email" : "form",
      contactTarget: hasEmail ? g.email : g.optout,
      portalUrl: g.optout || undefined,
      slaInDays: 30,
      requiresFullName: g.names,
      requiresIdProof: false,
      acceptedDiscoveryKeys: keys,
      notes: `Registro data broker USA (${[...g.srcs].join(", ")}).`,
    });
  }
  return out;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function fromGvl() {
  const gvl = await fetchJson(GVL_URL);
  const out = [];
  for (const v of Object.values(gvl.vendors || {})) {
    const name = clean(v.name);
    if (!name) continue;
    const urls = v.urls || [];
    const u = urls.find((x) => x.langId === "en" && x.privacy) || urls.find((x) => x.privacy);
    if (!u || !u.privacy) continue;

    out.push({
      name,
      // 20260701 RG - La GVL non dichiara il paese: "EU" indica "opera in Europa",
      // non la sede legale. Non lo si deduce dal nome per non scrivere il falso.
      country: "EU",
      legalBasis: "gdpr",
      contactMethod: "form",
      contactTarget: u.privacy,
      portalUrl: u.privacy,
      slaInDays: 30,
      requiresFullName: false,
      requiresIdProof: false,
      acceptedDiscoveryKeys: ["email"],
      notes: "Vendor IAB Europe TCF (tratta dati di utenti UE). Nessuna email pubblicata: richiesta da inoltrare tramite la pagina privacy.",
    });
  }
  return out;
}

(async () => {
  const curated = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "data", "brokers-curated.json"), "utf8"));
  const us = fromCsv();
  const eu = await fromGvl();
  console.log(`curati: ${curated.length}  |  CSV USA: ${us.length}  |  GVL UE: ${eu.length}`);

  // Precedenza: curati (verificati a mano) > CSV USA (hanno l'email) > GVL (solo form)
  const merged = new Map();
  for (const b of [...curated, ...us, ...eu]) {
    const k = norm(b.name);
    if (!k || merged.has(k)) continue;
    merged.set(k, b);
  }

  const list = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(list, null, 1));

  const byMethod = list.reduce((a, b) => ((a[b.contactMethod] = (a[b.contactMethod] || 0) + 1), a), {});
  console.log(`\nscritti ${list.length} broker in src/data/brokers.json`);
  console.log("per canale:", byMethod);
  console.log("duplicati scartati:", curated.length + us.length + eu.length - list.length);
})();
