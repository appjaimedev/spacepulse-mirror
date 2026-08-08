#!/usr/bin/env node
/**
 * scripts/verify-mirror.js
 * Portero del commit: comprueba que lo que hay en docs/api/ se puede servir.
 *
 * Este mirror es la ÚNICA fuente de datos de la app. Un fichero truncado, un
 * JSON inválido o una lista vacía no rompen el build —salen 200 y se commitean
 * tan tranquilos— pero dejan la app en blanco para todo el mundo hasta el
 * siguiente sync. Por eso el workflow solo commitea si esto pasa.
 *
 * Falla (exit 1) ante cualquier problema en un fichero OBLIGATORIO. Los
 * opcionales (fotos, eventos, briefings) solo avisan: que falten degrada una
 * sección, no la app entera.
 *
 * Uso: node scripts/verify-mirror.js
 */

const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, '..', 'docs', 'api');

const problems = [];
const warnings = [];

function readJson(rel) {
  const file = path.join(API_DIR, rel);
  if (!fs.existsSync(file)) return { missing: true };
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim().length === 0) return { empty: true };
  try {
    return { data: JSON.parse(raw), bytes: Buffer.byteLength(raw) };
  } catch (err) {
    return { invalid: err.message };
  }
}

/**
 * @param required  true → un fallo aborta el commit.
 * @param minItems  mínimo de elementos que hacen útil el fichero.
 */
function checkList(rel, { required, minItems }) {
  const res = readJson(rel);
  const note = msg => (required ? problems : warnings).push(`${rel}: ${msg}`);

  if (res.missing) { note('no existe'); return; }
  if (res.empty) { note('está vacío (0 bytes)'); return; }
  if (res.invalid) { note(`JSON inválido — ${res.invalid}`); return; }
  if (!Array.isArray(res.data)) { note('se esperaba una lista'); return; }
  if (res.data.length < minItems) {
    note(`solo ${res.data.length} elementos, se esperaban ${minItems} o más`);
    return;
  }
  console.log(`  ✓ ${rel} — ${res.data.length} elementos, ${(res.bytes / 1024).toFixed(0)} KB`);
}

function checkLaunchShape(rel) {
  const res = readJson(rel);
  if (res.missing || res.invalid || !Array.isArray(res.data) || res.data.length === 0) return;
  // Un puñado basta: si el recorte se rompiera, se rompería para todos por igual.
  const sample = res.data.slice(0, 5);
  for (const l of sample) {
    if (!l || typeof l.id !== 'string' || typeof l.net !== 'string' || typeof l.name !== 'string') {
      problems.push(`${rel}: hay elementos sin id/net/name`);
      return;
    }
    if (Number.isNaN(new Date(l.net).getTime())) {
      problems.push(`${rel}: net no es una fecha válida (${l.net})`);
      return;
    }
  }
  console.log(`  ✓ ${rel} — forma de lanzamiento correcta`);
}

/** Fotos de Marte: un objeto con una lista por rover, no una lista suelta. */
function checkRoverMap(rel) {
  const res = readJson(rel);
  if (res.missing) { warnings.push(`${rel}: no existe`); return; }
  if (res.invalid) { warnings.push(`${rel}: JSON inválido — ${res.invalid}`); return; }
  const rovers = Object.entries(res.data || {}).filter(([, v]) => Array.isArray(v));
  if (rovers.length === 0) { warnings.push(`${rel}: sin ningún rover con fotos`); return; }
  const total = rovers.reduce((n, [, v]) => n + v.length, 0);
  console.log(`  ✓ ${rel} — ${rovers.length} rovers, ${total} fotos`);
}

function checkIndex() {
  const res = readJson('index.json');
  if (res.missing) { problems.push('index.json: no existe'); return; }
  if (res.invalid) { problems.push(`index.json: JSON inválido — ${res.invalid}`); return; }
  const idx = res.data;
  if (!idx || typeof idx.generatedAt !== 'string') {
    problems.push('index.json: falta generatedAt');
    return;
  }
  const age = Date.now() - new Date(idx.generatedAt).getTime();
  if (Number.isNaN(age)) { problems.push('index.json: generatedAt no es una fecha'); return; }
  console.log(`  ✓ index.json — generado hace ${Math.round(age / 60000)} min`);
}

function checkIcs() {
  const file = path.join(API_DIR, 'launches.ics');
  if (!fs.existsSync(file)) { warnings.push('launches.ics: no existe'); return; }
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.startsWith('BEGIN:VCALENDAR') || !raw.trimEnd().endsWith('END:VCALENDAR')) {
    warnings.push('launches.ics: el calendario no está bien cerrado');
    return;
  }
  const events = (raw.match(/BEGIN:VEVENT/g) || []).length;
  console.log(`  ✓ launches.ics — ${events} eventos`);
}

console.log('🔍 Verificando docs/api…');

// Obligatorios: sin esto la app no tiene nada que enseñar.
checkList('upcoming.json', { required: true, minItems: 5 });
checkLaunchShape('upcoming.json');
checkIndex();

// Opcionales: su ausencia degrada una sección, no la app.
checkList('astronauts.json', { required: false, minItems: 1 });
checkList('events.json', { required: false, minItems: 1 });
// mars-photos.json NO es una lista: es un mapa por rover ({perseverance, curiosity}).
checkRoverMap('mars-photos.json');
checkList('moon-photos.json', { required: false, minItems: 1 });
checkList('eclipses.json', { required: false, minItems: 1 });
checkList('astronauts-all.json', { required: false, minItems: 100 });
checkIcs();

// Las décadas históricas son inmutables: si alguna se corrompiera, se queda
// corrupta para siempre porque el build las salta cuando ya existen.
const histDir = path.join(API_DIR, 'historical');
if (fs.existsSync(histDir)) {
  for (const name of fs.readdirSync(histDir)) {
    if (!name.endsWith('.json')) continue;
    const res = readJson(path.join('historical', name));
    if (res.invalid) problems.push(`historical/${name}: JSON inválido — ${res.invalid}`);
    else if (res.empty) problems.push(`historical/${name}: está vacío`);
  }
  console.log(`  ✓ historical/ — ${fs.readdirSync(histDir).length} ficheros legibles`);
}

console.log('');
for (const w of warnings) console.warn(`⚠ ${w}`);
if (problems.length > 0) {
  for (const p of problems) console.error(`❌ ${p}`);
  console.error('');
  console.error('El mirror NO se publica: se conserva la versión anterior, que funciona.');
  process.exit(1);
}
console.log('✅ Mirror verificado.');
