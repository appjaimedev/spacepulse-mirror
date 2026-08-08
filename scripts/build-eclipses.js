#!/usr/bin/env node
/**
 * scripts/build-eclipses.js
 * Publica docs/api/eclipses.json: el trazado real de los eclipses solares
 * (línea central de totalidad y límites norte y sur de la franja parcial).
 *
 * La geometría de un eclipse no se improvisa, y aproximarla sería peor que no
 * dibujarla: decirle a alguien que está dentro de la banda de totalidad cuando
 * está a cien kilómetros arruina el viaje. Aquí se lee la tabla que la NASA
 * publica para cada eclipse (eclipse.gsfc.nasa.gov), que da esas tres líneas
 * minuto a minuto.
 *
 * Los eclipses lunares NO llevan trazado: se ven desde todo el hemisferio
 * nocturno, así que no hay banda que dibujar.
 *
 * Uso: node scripts/build-eclipses.js
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'api');
const OUT_FILE = path.join(OUT_DIR, 'eclipses.json');
const BASE = 'https://eclipse.gsfc.nasa.gov/SEpath/SEpath2001';

/**
 * Eclipses solares que la app tiene curados (lib/astroEvents.ts). El sufijo es
 * el tipo según la nomenclatura de la NASA: T total, A anular, H híbrido.
 */
const ECLIPSES = [
  { id: 'ecl-sol-2026-08', date: '2026-08-12', kind: 'total',   file: 'SE2026Aug12Tpath.html' },
  { id: 'ecl-sol-2027-02', date: '2027-02-06', kind: 'annular', file: 'SE2027Feb06Apath.html' },
  { id: 'ecl-sol-2027-08', date: '2027-08-02', kind: 'total',   file: 'SE2027Aug02Tpath.html' },
];

/** "75 56.2N" → 75.937 · "108 45.5E" → 108.758 · "016 13.0W" → -16.217 */
function toDecimal(deg, min, hemi) {
  const value = Number(deg) + Number(min) / 60;
  if (!Number.isFinite(value)) return null;
  return (hemi === 'S' || hemi === 'W') ? -value : value;
}

const COORD = String.raw`(\d{1,3})\s+(\d{1,2}\.\d)([NSEW])`;
// Tres pares (norte, sur, central). Las filas cuyos límites caen fuera de la
// Tierra traen guiones en su lugar, así que cada par se captura por separado.
const ROW = new RegExp(
  String.raw`^\s*(\d{2}:\d{2})\s+(?:${COORD}\s+${COORD}|-+)\s+(?:${COORD}\s+${COORD}|-+)\s+${COORD}\s+${COORD}`,
);

function parsePath(html) {
  const north = [];
  const south = [];
  const central = [];

  for (const raw of html.split(/\r?\n/)) {
    const m = ROW.exec(raw);
    if (!m) continue;
    const g = m.slice(2);
    const take = i => {
      const lat = toDecimal(g[i], g[i + 1], g[i + 2]);
      const lon = toDecimal(g[i + 3], g[i + 4], g[i + 5]);
      return lat === null || lon === null ? null : [Number(lat.toFixed(3)), Number(lon.toFixed(3))];
    };
    const n = g[0] !== undefined ? take(0) : null;
    const s = g[6] !== undefined ? take(6) : null;
    const c = g[12] !== undefined ? take(12) : null;
    if (n) north.push(n);
    if (s) south.push(s);
    if (c) central.push(c);
  }
  return { north, south, central };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'SpacePulse/1.0 (mirror-build)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let previous = [];
  try { previous = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch { /* primera vez */ }
  const byId = new Map(previous.map(e => [e.id, e]));

  for (const ecl of ECLIPSES) {
    try {
      const html = await fetchText(`${BASE}/${ecl.file}`);
      const { north, south, central } = parsePath(html);
      if (central.length < 5) throw new Error(`solo ${central.length} puntos de línea central`);
      byId.set(ecl.id, {
        id: ecl.id, date: ecl.date, kind: ecl.kind,
        central, north, south,
        source: `${BASE}/${ecl.file}`,
      });
      console.log(`  ✓ ${ecl.id}: central ${central.length} pts · norte ${north.length} · sur ${south.length}`);
    } catch (err) {
      // Se conserva lo que hubiera: un trazado viejo sigue siendo correcto,
      // porque la geometría de un eclipse pasado o futuro no cambia.
      console.warn(`  ✗ ${ecl.id}: ${err.message}`);
    }
  }

  const out = [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (out.length === 0) {
    console.warn('⚠ sin eclipses; no se escribe nada.');
    return;
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`  💾 eclipses.json (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)} KB, ${out.length} eclipses)`);
}

main().catch(err => {
  console.warn(`⚠ build-eclipses falló: ${err.message}`);
});
