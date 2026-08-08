#!/usr/bin/env node

/**
 * scripts/build-mirror.js
 *
 * Mirrors LL2 (Launch Library 2.3.0) data into static JSON files under docs/api/
 * for GitHub Pages. The app reads from this CDN instead of hitting LL2 directly,
 * so the 15 req/h anonymous limit is shared by only this cron (not per-user).
 *
 * Usage:
 *   node scripts/build-mirror.js              # default: current decade + upcoming + astronauts
 *   node scripts/build-mirror.js --full       # one-time: all decades 1950s→now (needs LL2_TOKEN)
 *   LL2_TOKEN=xxx node scripts/build-mirror.js --full
 *
 * Output: docs/api/{upcoming.json, historical/<decade>.json, astronauts.json, index.json}
 */

const fs = require('fs');
const path = require('path');

const API_BASE = process.env.LL2_BASE || 'https://ll.thespacedevs.com/2.3.0';
const TOKEN = process.env.LL2_TOKEN;
const THROTTLE_MS = 2000;
const MAX_RETRIES = 3;
// Años NUEVOS de la década actual que se bajan por ejecución (más el año en
// curso, que se refresca siempre). Mantiene cada run dentro del tope anónimo de
// 15 req/h; la década se completa a lo largo de varias ejecuciones.
const MAX_BACKFILL_YEARS_PER_RUN = 2;
const OUT_DIR = path.join(__dirname, '..', 'docs', 'api');
const HIST_DIR = path.join(OUT_DIR, 'historical');

const CURRENT_YEAR = new Date().getFullYear();
const CURRENT_DECADE = Math.floor(CURRENT_YEAR / 10) * 10;
const ALL_DECADES = [];
for (let d = CURRENT_DECADE; d >= 1950; d -= 10) ALL_DECADES.push(d);

const args = process.argv.slice(2);
const FULL_MODE = args.includes('--full');
const LIGHT_MODE = args.includes('--upcoming'); // solo upcoming.json (cron frecuente, 1 req)
const BACKFILL_MODE = args.includes('--backfill'); // 1 década inmutable que falte (anónimo 15/h, sin token)
const MARS_MODE = args.includes('--mars'); // solo mars-photos.json (NASA, independiente de LL2)
const MOON_MODE = args.includes('--moon'); // solo moon-photos.json (ídem)

function headers() {
  const h = { 'User-Agent': 'SpacePulse/1.0 (Mission Control · mirror-build)' };
  if (TOKEN) h.Authorization = `Token ${TOKEN}`;
  return h;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, { headers: headers() });
      if (resp.status === 429) {
        const retry = resp.headers.get('Retry-After');
        const wait = retry ? parseInt(retry, 10) * 1000 : 60000;
        console.warn(`  429 rate-limited, waiting ${Math.round(wait / 1000)}s…`);
        await sleep(wait);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      return await resp.json();
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.warn(`  attempt ${attempt} failed: ${err.message}, retrying…`);
        await sleep(THROTTLE_MS * attempt);
      } else {
        throw err;
      }
    }
  }
}

function trimUpcoming(launch) {
  return {
    id: launch.id,
    name: launch.name,
    net: launch.net,
    // Cuánto se sabe REALMENTE del NET. La mayoría de los próximos lanzamientos
    // no tienen fecha y LL2 rellena `net` con el último día del periodo conocido
    // (mes/trimestre/semestre/año). Sin este campo la app los pintaba como
    // fechas de verdad: 39 misiones amontonadas bajo un mismo 31 de diciembre.
    net_precision: launch.net_precision
      ? { id: launch.net_precision.id, name: launch.net_precision.name, abbrev: launch.net_precision.abbrev }
      : null,
    status: launch.status ? { id: launch.status.id, name: launch.status.name, abbrev: launch.status.abbrev } : null,
    launch_service_provider: launch.launch_service_provider ? {
      id: launch.launch_service_provider.id,
      name: launch.launch_service_provider.name,
      abbrev: launch.launch_service_provider.abbrev,
      country: launch.launch_service_provider.country || null,
    } : null,
    rocket: launch.rocket ? {
      configuration: {
        name: launch.rocket.configuration?.name,
        full_name: launch.rocket.configuration?.full_name,
        reusable: launch.rocket.configuration?.reusable ?? null,
      },
    } : null,
    mission: launch.mission ? {
      name: launch.mission.name,
      type: launch.mission.type,
      orbit: launch.mission.orbit ? { abbrev: launch.mission.orbit.abbrev, name: launch.mission.orbit.name } : null,
    } : null,
    pad: launch.pad ? {
      name: launch.pad.name,
      latitude: launch.pad.latitude ?? null,
      longitude: launch.pad.longitude ?? null,
      location: launch.pad.location ? { name: launch.pad.location.name, country: launch.pad.location.country || null } : null,
    } : null,
    image: launch.image ? { image_url: launch.image.image_url, thumbnail_url: launch.image.thumbnail_url ?? null } : null,
    webcast_live: launch.webcast_live,
    vid_urls: launch.vid_urls || [],
    mission_patches: launch.mission_patches || [],
  };
}

// Ficha LIGERA de la lista histórica (la que pinta la pantalla de listado). Se
// mantiene mínima a propósito: el detalle pesado (misión/parche/vídeo) va en un
// fichero aparte, bajo demanda. Ver trimDetail / {decade}s-detail.json.
function trimHistorical(launch) {
  return {
    id: launch.id,
    name: launch.name,
    net: launch.net,
    status: launch.status ? { id: launch.status.id, name: launch.status.name, abbrev: launch.status.abbrev } : null,
    launch_service_provider: launch.launch_service_provider ? {
      id: launch.launch_service_provider.id,
      name: launch.launch_service_provider.name,
      country_code: launch.launch_service_provider.country?.alpha_3_code || null,
    } : null,
    rocket: launch.rocket ? { configuration: { name: launch.rocket.configuration?.name } } : null,
    pad: launch.pad ? {
      name: launch.pad.name,
      location: launch.pad.location ? { name: launch.pad.location.name } : null,
    } : null,
    image: launch.image ? { image_url: launch.image.image_url } : null,
  };
}

// Recorta texto largo a `max` caracteres colapsando espacios. null si vacío.
function trimText(s, max) {
  if (!s) return null;
  const clean = String(s).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length <= max ? clean : clean.slice(0, max - 1).trimEnd() + '…';
}

// Solo la URL del parche (nunca el blob).
function trimPatches(patches) {
  if (!Array.isArray(patches)) return [];
  return patches
    .filter(p => p && p.image_url)
    .map(p => ({ image_url: p.image_url, priority: p.priority ?? null }));
}

// Solo la URL del vídeo (nunca el vídeo).
function trimVids(vids) {
  if (!Array.isArray(vids)) return [];
  return vids.filter(v => v && v.url).map(v => ({ url: v.url }));
}

// DETALLE pesado bajo demanda (se sirve en {decade}s-detail.json como mapa por
// id). Guarda solo dato crudo / URLs; la ficha de la app lo interpreta. Devuelve
// null cuando no hay nada que merezca espacio (lanzamientos viejos sin misión ni
// media → la ficha se conforma con la fila ligera).
function trimDetail(launch) {
  const mission = launch.mission ? {
    type: launch.mission.type || null,
    orbit: launch.mission.orbit
      ? { abbrev: launch.mission.orbit.abbrev || null, name: launch.mission.orbit.name || null }
      : null,
    description: trimText(launch.mission.description, 300),
  } : null;
  const patches = trimPatches(launch.mission_patches);
  const vids = trimVids(launch.vid_urls);
  const pad_lat = launch.pad?.latitude ?? null;
  const pad_lon = launch.pad?.longitude ?? null;
  const rocket_full_name = launch.rocket?.configuration?.full_name || null;

  const hasContent =
    (mission && (mission.type || mission.orbit || mission.description)) ||
    patches.length > 0 || vids.length > 0 || pad_lat != null || rocket_full_name;
  if (!hasContent) return null;

  return { mission, rocket_full_name, pad_lat, pad_lon, mission_patches: patches, vid_urls: vids };
}

// Escribe el par lista-ligera + detalle de una década.
function writeDecade(decade, list, detail) {
  writeJson(path.join(HIST_DIR, `${decade}s.json`), list);
  writeJson(path.join(HIST_DIR, `${decade}s-detail.json`), detail);
}

// Una década está "enriquecida" cuando existen AMBOS ficheros (lista + detalle).
// Las décadas espejadas antes de esta feature solo tienen la lista → se vuelven
// a bajar una vez (con mode=detailed) para generar el detalle.
function decadeEnriched(decade) {
  return (
    fs.existsSync(path.join(HIST_DIR, `${decade}s.json`)) &&
    fs.existsSync(path.join(HIST_DIR, `${decade}s-detail.json`))
  );
}

async function fetchUpcoming() {
  console.log('📡 Fetching upcoming launches…');
  // limit=100: sigue siendo UNA sola petición, así que no cuesta cuota extra, y
  // duplica lo que la app puede pintar en la timeline (con 50 se acababa a ~3
  // meses vista). La app usa limit=50 en SU fallback directo a LL2 porque ahí
  // mode=detailed con 100 se pasa de los 15 s de timeout del cliente; aquí no
  // hay prisa y fetchJson ya reintenta los 429 esperando.
  const url = `${API_BASE}/launches/upcoming/?limit=100&mode=detailed&ordering=net&hide_recent_previous=true`;
  const data = await fetchJson(url);
  const results = (data.results || []).map(trimUpcoming);
  console.log(`  ✓ ${results.length} upcoming launches`);
  return results;
}

async function fetchDecade(decade) {
  const startYear = decade;
  const endYear = decade + 9;
  const gte = `${startYear}-01-01T00:00:00Z`;
  const lte = `${endYear}-12-31T23:59:59Z`;
  console.log(`📡 Fetching historical ${decade}s (${startYear}-${endYear})…`);

  let offset = 0;
  const limit = 100;
  const list = [];
  const detail = {};
  let hasMore = true;

  while (hasMore) {
    const url = `${API_BASE}/launches/previous/?limit=${limit}&offset=${offset}&mode=detailed&ordering=-net&net__gte=${gte}&net__lte=${lte}`;
    const data = await fetchJson(url);
    for (const l of (data.results || [])) {
      list.push(trimHistorical(l));
      const d = trimDetail(l);
      if (d) detail[l.id] = d;
    }
    hasMore = data.next !== null;
    offset += limit;
    if (hasMore) await sleep(THROTTLE_MS);
  }

  console.log(`  ✓ ${list.length} launches in ${decade}s (${Object.keys(detail).length} con detalle)`);
  return { list, detail };
}

// Un único año (acotado: 1-3 páginas). Base de la construcción incremental de
// la década actual. Devuelve lista ligera + mapa de detalle (mode=detailed).
async function fetchYear(year) {
  const gte = `${year}-01-01T00:00:00Z`;
  const lte = `${year}-12-31T23:59:59Z`;
  let offset = 0;
  const limit = 100;
  const list = [];
  const detail = {};
  let hasMore = true;
  while (hasMore) {
    const url = `${API_BASE}/launches/previous/?limit=${limit}&offset=${offset}&mode=detailed&ordering=-net&net__gte=${gte}&net__lte=${lte}`;
    const data = await fetchJson(url);
    for (const l of (data.results || [])) {
      list.push(trimHistorical(l));
      const d = trimDetail(l);
      if (d) detail[l.id] = d;
    }
    hasMore = data.next !== null;
    offset += limit;
    if (hasMore) await sleep(THROTTLE_MS);
  }
  return { list, detail };
}

// Construye la década ACTUAL año a año, con escritura incremental y reanudable.
//   - El año en curso se re-baja SIEMPRE (los estados cambian).
//   - Los años pasados de la década son inmutables: se bajan una sola vez.
//   - Cap de años nuevos por ejecución → la década se completa en varias pasadas
//     sin reventar el tope de 15 req/h ni el límite de 6 h de Actions, y cada año
//     completado se persiste al instante (un run cortado no pierde lo ya bajado).
async function buildCurrentDecade() {
  fs.mkdirSync(HIST_DIR, { recursive: true });
  const file = path.join(HIST_DIR, `${CURRENT_DECADE}s.json`);
  const detailFile = path.join(HIST_DIR, `${CURRENT_DECADE}s-detail.json`);
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* aún no existe */ }
  const detailMap = {};
  try { Object.assign(detailMap, JSON.parse(fs.readFileSync(detailFile, 'utf8'))); } catch { /* aún no existe */ }

  // Años ya bajados con mode=detailed, persistidos como clave reservada del mapa
  // (los ids de lanzamiento son UUID y nunca colisionan con "__years__"). Sin
  // esto, un año cuyos lanzamientos no tengan media nunca se marcaría "hecho" y
  // se re-bajaría en cada pasada.
  const doneYears = new Set(Array.isArray(detailMap.__years__) ? detailMap.__years__ : []);
  delete detailMap.__years__;

  const yearOf = (l) => new Date(l.net).getUTCFullYear();
  const byYear = new Map();
  for (const l of existing) {
    const y = yearOf(l);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(l);
  }

  const writeMerged = () => {
    const merged = [...byYear.values()].flat().sort((a, b) => (a.net < b.net ? 1 : -1));
    writeJson(file, merged);
    // Poda el detalle a los ids presentes + persiste los años completados.
    const ids = new Set(merged.map(l => l.id));
    const out = {};
    for (const id of Object.keys(detailMap)) if (ids.has(id)) out[id] = detailMap[id];
    out.__years__ = [...doneYears].sort();
    writeJson(detailFile, out);
    return merged.length;
  };

  let total = existing.length;
  let newYears = 0;
  for (let year = CURRENT_DECADE; year <= CURRENT_YEAR; year++) {
    const isCurrent = year === CURRENT_YEAR;
    if (doneYears.has(year) && !isCurrent) continue;                      // pasado ya enriquecido
    if (!isCurrent && newYears >= MAX_BACKFILL_YEARS_PER_RUN) continue;   // cap de este run
    console.log(`⛏  ${CURRENT_DECADE}s — fetching year ${year}…`);
    const { list, detail } = await fetchYear(year);
    byYear.set(year, list);
    Object.assign(detailMap, detail);
    doneYears.add(year);
    total = writeMerged();                                               // progreso persistido
    if (!isCurrent) newYears++;
    await sleep(THROTTLE_MS);
  }

  const done = byYear.size >= (CURRENT_YEAR - CURRENT_DECADE + 1);
  console.log(`  ✓ ${CURRENT_DECADE}s: ${total} launches (${byYear.size}/${CURRENT_YEAR - CURRENT_DECADE + 1} años${done ? ', completa' : ', sigue en próximas pasadas'})`);
  return total;
}

const NASA_API_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';
const MARS_ROVERS = ['perseverance', 'curiosity'];

// Fallback curado: la API mars-photos de NASA (servicio de terceros que NASA
// proxea) cae con frecuencia (404). Cuando no devuelve nada, servimos este set
// de fotos icónicas reales alojadas en el mirror, para que el feature nunca
// aparezca vacío. Se sustituye por las fotos "en vivo" en cuanto NASA responde.
const MOON_IMG = 'https://appjaimedev.github.io/spacepulse-mirror/img/moon';

/**
 * Biblioteca de imágenes de la NASA. Es pública, sin clave, y la usamos para
 * Luna y Marte.
 *
 * Por qué: la API de fotos de rover (api.nasa.gov/mars-photos) está RETIRADA.
 * Vivía en Heroku y hoy devuelve "No such app", así que el mirror llevaba
 * tiempo cayendo en silencio a las fotos curadas y nadie se enteraba.
 * Comprobado el 8 de agosto de 2026, tanto en api.nasa.gov como en el Heroku
 * original.
 */
const NASA_IMAGES = 'https://images-api.nasa.gov/search';

/** Fotos icónicas de la Luna, alojadas aquí. Rellenan si la API se queda corta. */
const CURATED_MOON = [
  { id: "moon-1", img_src: `${MOON_IMG}/moon_1.jpg`, title: "Buzz Aldrin on the Moon", year: 1969, curated: true },
  { id: "moon-6", img_src: `${MOON_IMG}/moon_6.jpg`, title: "Earthrise (Apollo 8)", year: 1968, curated: true },
  { id: "moon-2", img_src: `${MOON_IMG}/moon_2.jpg`, title: "Aldrin at Tranquility Base", year: 1969, curated: true },
  { id: "moon-11", img_src: `${MOON_IMG}/moon_11.jpg`, title: "Aldrin and the U.S. flag", year: 1969, curated: true },
  { id: "moon-3", img_src: `${MOON_IMG}/moon_3.jpg`, title: "Bootprint on the Moon", year: 1969, curated: true },
  { id: "moon-4", img_src: `${MOON_IMG}/moon_4.jpg`, title: "Descending the lunar module", year: 1969, curated: true },
  { id: "moon-5", img_src: `${MOON_IMG}/moon_5.jpg`, title: "Deploying experiments", year: 1969, curated: true },
  { id: "moon-12", img_src: `${MOON_IMG}/moon_12.jpg`, title: "Saluting the flag", year: 1969, curated: true },
  { id: "moon-7", img_src: `${MOON_IMG}/moon_7.jpg`, title: "The Earth and the Moon", year: 1992, curated: true },
  { id: "moon-8", img_src: `${MOON_IMG}/moon_8.jpg`, title: "Full Moon", year: 2010, curated: true },
  { id: "moon-9", img_src: `${MOON_IMG}/moon_9.jpg`, title: "Full Moon detail", year: 2010, curated: true },
  { id: "moon-10", img_src: `${MOON_IMG}/moon_10.jpg`, title: "Full Moon rising", year: 2020, curated: true },
];

/**
 * Busca imágenes y devuelve las más RECIENTES.
 *
 * La API ordena por relevancia, no por fecha: se lanzan varias consultas, se
 * juntan, se quitan duplicados por nasa_id y se ordena por fecha descendente.
 * Solo entran las que traen un enlace de imagen usable.
 */
async function fetchNasaImages(queries, { yearStart, limit, reject }) {
  const seen = new Map();
  for (const q of queries) {
    const params = new URLSearchParams({ q, media_type: 'image' });
    if (yearStart) params.set('year_start', String(yearStart));
    try {
      const data = await fetchJson(`${NASA_IMAGES}?${params.toString()}`);
      for (const item of data.collection?.items ?? []) {
        const meta = (item.data || [])[0];
        const href = (item.links || []).find(l => l.render === 'image')?.href
          || (item.links || [])[0]?.href;
        if (!meta || !href || !meta.nasa_id) continue;
        if (seen.has(meta.nasa_id)) continue;
        if (reject && reject.test(`${meta.title || ''} ${meta.description || ''}`)) continue;
        seen.set(meta.nasa_id, {
          id: meta.nasa_id,
          title: (meta.title || '').trim() || null,
          img_src: href,
          date: meta.date_created || null,
          center: meta.center || null,
          credit: meta.secondary_creator || meta.photographer || null,
        });
      }
    } catch (err) {
      console.warn(`  ✗ imágenes NASA "${q}": ${err.message}`);
    }
    await sleep(THROTTLE_MS);
  }
  return [...seen.values()]
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, limit);
}

/**
 * Cosas que la búsqueda devuelve y NO son fotos: recreaciones de artista,
 * infografías, logos, ruedas de prensa, retratos, maquetas. Colar un render
 * entre fotos reales de la Luna es peor que no enseñar nada.
 */
const NOT_A_PHOTO = /(artist|concept|illustration|render|animation|infographic|diagram|chart|graphic|logo|patch|poster|mockup|model of|briefing|press|ceremony|administrator|portrait|team|competition|award|interview|meeting|panel)/i;

/**
 * Fotos REALES de la Luna, rotando.
 *
 * Aquí no se puede hacer "las últimas": la biblioteca de la NASA no es un feed
 * cronológico. Las imágenes del LRO están todas fechadas el día que se
 * ingestaron (2017-12-08), no cuando se tomaron, y si se ordena por fecha lo
 * que sube arriba son conceptos de artista y actos de prensa recientes.
 *
 * Lo que sí se puede hacer, y es honesto, es reunir un fondo amplio de
 * fotografía lunar de verdad —LRO, Artemis I desde Orion, panorámicas Apollo—
 * y rotar veinte cada día. Deja de ser siempre la misma docena de 1969 sin
 * fingir una actualidad que la fuente no da.
 */
async function fetchMoonPhotos() {
  console.log('📡 Fetching Moon photos (NASA image library)…');
  const pool = await fetchNasaImages([
    'Lunar Reconnaissance Orbiter Camera',
    'Moon crater LRO',
    'Artemis I Orion Moon',
    'Apollo lunar surface panorama',
    'Moon farside',
    'lunar south pole',
  ], { limit: 200, reject: NOT_A_PHOTO });

  if (pool.length === 0) {
    console.warn('  ✗ sin imágenes; se conserva lo publicado');
    return [];
  }

  // Rotación estable dentro del día: el mismo desplazamiento durante toda la
  // jornada (varios syncs al día no deben barajar la cuadrícula cada media
  // hora) y distinto al siguiente.
  const dayIndex = Math.floor(Date.now() / 86400000);
  const offset = (dayIndex * 7) % pool.length;
  const rotated = [...pool.slice(offset), ...pool.slice(0, offset)].slice(0, 20);

  console.log(`  ✓ ${rotated.length} de un fondo de ${pool.length} (rota a diario)`);
  return rotated.length >= 20
    ? rotated
    : [...rotated, ...CURATED_MOON.slice(0, 20 - rotated.length)];
}

const MARS_IMG = 'https://appjaimedev.github.io/spacepulse-mirror/img/mars';
const CURATED_MARS = {
  perseverance: [
    { id: 'cur-perseverance-1', sol: 46,   camera: { name: 'SHERLOC_WATSON', full_name: 'WATSON selfie camera' }, img_src: `${MARS_IMG}/perseverance_1.jpg`, earth_date: '2021-04-06', rover: { name: 'Perseverance', status: 'active' } },
    { id: 'cur-perseverance-2', sol: 198,  camera: { name: 'SHERLOC_WATSON', full_name: 'WATSON selfie camera' }, img_src: `${MARS_IMG}/perseverance_2.jpg`, earth_date: '2021-09-10', rover: { name: 'Perseverance', status: 'active' } },
    { id: 'cur-perseverance-3', sol: 1500, camera: { name: 'SHERLOC_WATSON', full_name: 'WATSON selfie camera' }, img_src: `${MARS_IMG}/perseverance_3.jpg`, earth_date: '2025-05-10', rover: { name: 'Perseverance', status: 'active' } },
    { id: 'cur-perseverance-4', sol: 1350, camera: { name: 'MCZ',            full_name: 'Mastcam-Z' },             img_src: `${MARS_IMG}/perseverance_4.jpg`, earth_date: '2024-12-25', rover: { name: 'Perseverance', status: 'active' } },
    { id: 'cur-perseverance-5', sol: 768,  camera: { name: 'MCZ',            full_name: 'Mastcam-Z' },             img_src: `${MARS_IMG}/perseverance_5.jpg`, earth_date: '2023-04-16', rover: { name: 'Perseverance', status: 'active' } },
    { id: 'cur-perseverance-6', sol: 0,    camera: { name: 'EDL',            full_name: 'Entry, Descent & Landing' }, img_src: `${MARS_IMG}/perseverance_6.jpg`, earth_date: '2021-02-18', rover: { name: 'Perseverance', status: 'active' } },
  ],
  curiosity: [
    { id: 'cur-curiosity-1', sol: 2620, camera: { name: 'MAST', full_name: 'Mast Camera' },   img_src: `${MARS_IMG}/curiosity_1.jpg`, earth_date: '2019-12-01', rover: { name: 'Curiosity', status: 'active' } },
    { id: 'cur-curiosity-2', sol: 3977, camera: { name: 'MAST', full_name: 'Mast Camera' },   img_src: `${MARS_IMG}/curiosity_2.jpg`, earth_date: '2023-10-26', rover: { name: 'Curiosity', status: 'active' } },
    { id: 'cur-curiosity-3', sol: 3423, camera: { name: 'MAST', full_name: 'Mast Camera' },   img_src: `${MARS_IMG}/curiosity_3.jpg`, earth_date: '2022-03-23', rover: { name: 'Curiosity', status: 'active' } },
    { id: 'cur-curiosity-4', sol: 3070, camera: { name: 'MAHLI', full_name: 'Mars Hand Lens Imager' }, img_src: `${MARS_IMG}/curiosity_4.jpg`, earth_date: '2021-03-26', rover: { name: 'Curiosity', status: 'active' } },
    { id: 'cur-curiosity-5', sol: 1128, camera: { name: 'MAHLI', full_name: 'Mars Hand Lens Imager' }, img_src: `${MARS_IMG}/curiosity_5.jpg`, earth_date: '2015-12-19', rover: { name: 'Curiosity', status: 'active' } },
    { id: 'cur-curiosity-6', sol: 3415, camera: { name: 'MAST', full_name: 'Mast Camera' },   img_src: `${MARS_IMG}/curiosity_6.jpg`, earth_date: '2022-03-15', rover: { name: 'Curiosity', status: 'active' } },
  ],
};

function trimEvent(event) {
  return {
    id:            event.id,
    name:          event.name,
    type:          event.type ? { id: event.type.id, name: event.type.name } : null,
    date:          event.date || null,
    description:   event.description || null,
    video_url:     event.video_url || null,
    launch:        event.launch ? { id: event.launch.id, name: event.launch.name || null } : null,
    feature_image: event.feature_image ? { image_url: event.feature_image.image_url } : null,
  };
}

async function fetchEvents() {
  console.log('📡 Fetching upcoming events…');
  // OJO: en LL2 2.3.0 el recurso es PLURAL (`/events/`). El singular devuelve
  // 404 — con la ruta antigua el fetch fallaba en cada run diario y
  // events.json no se generaba nunca (la app caía a LL2 y quemaba rate-limit).
  const url = `${API_BASE}/events/upcoming/?limit=30&ordering=date`;
  const data = await fetchJson(url);
  const results = (data.results || []).map(trimEvent);
  console.log(`  ✓ ${results.length} upcoming events`);
  return results;
}

function trimMarsPhoto(p) {
  return {
    id:        p.id,
    sol:       p.sol ?? null,
    camera:    p.camera ? { name: p.camera.name, full_name: p.camera.full_name } : null,
    img_src:   p.img_src || null,
    earth_date: p.earth_date || null,
    rover:     p.rover ? { name: p.rover.name, status: p.rover.status } : null,
  };
}

/**
 * Últimas imágenes de los rover. La API de fotos de rover está retirada (ver
 * NASA_IMAGES), así que se tira de la biblioteca de imágenes: no trae sol ni
 * cámara —esos campos quedan a null— pero sí fotos reales y recientes.
 */
async function fetchMarsPhotos() {
  console.log('📡 Fetching Mars rover photos (NASA image library)…');
  const out = {};
  const QUERIES = {
    perseverance: ['Perseverance rover', 'Jezero crater'],
    curiosity:    ['Curiosity rover', 'Gale crater'],
  };
  for (const rover of MARS_ROVERS) {
    const live = await fetchNasaImages(QUERIES[rover], { yearStart: 2021, limit: 8 });
    out[rover] = live.map(p => ({
      id: p.id,
      sol: null,
      camera: null,
      img_src: p.img_src,
      earth_date: p.date ? p.date.slice(0, 10) : null,
      title: p.title,
      rover: { name: rover, status: 'active' },
    }));
    console.log(`  ✓ ${rover}: ${out[rover].length} fotos`);
  }
  // Relleno curado por rover: antes una cuadrícula vacía, las icónicas.
  for (const rover of MARS_ROVERS) {
    if (!out[rover] || out[rover].length === 0) {
      out[rover] = CURATED_MARS[rover] || [];
      console.log(`  ↩ ${rover}: relleno curado (${out[rover].length})`);
    }
  }
  return out;
}

/** Fuera maniquíes y cargas que LL2 lista como "tripulación". */
function isRealPerson(a) {
  return a.name !== 'Starman'
    && a.type?.name !== 'Dummy'
    && a.type?.name !== 'Non-Human';
}

/**
 * Ficha de astronauta a partir de la respuesta de la LISTA.
 *
 * El modo normal de `/astronauts/` ya devuelve bio, imagen, wiki y —lo
 * importante— las estadísticas VIVAS: time_in_space, eva_time, flights_count y
 * spacewalks_count. Antes se pedía el detalle de cada uno, once peticiones para
 * diez astronautas, contra un presupuesto de quince por hora. Con esto es UNA.
 *
 * Esas cifras son la fuente buena: el JSON estático de la app se escribió una
 * vez y daba 0 días a quien voló después — Sophie Adenot llevaba 169 días en
 * órbita y su ficha decía cero.
 */
function trimAstronaut(a, { withBio = true } = {}) {
  return {
    id: a.id,
    name: a.name,
    type: a.type ? { id: a.type.id, name: a.type.name } : null,
    nationality: a.nationality || [],
    agency: a.agency ? { id: a.agency.id, name: a.agency.name, abbrev: a.agency.abbrev } : null,
    status: a.status ? a.status.name : null,
    last_flight: a.last_flight || null,
    first_flight: a.first_flight || null,
    date_of_birth: a.date_of_birth || null,
    date_of_death: a.date_of_death || null,
    profile_image: a.image?.thumbnail_url || a.image?.image_url || null,
    wiki: a.wiki || null,
    in_space: a.in_space ?? null,
    time_in_space: a.time_in_space || null,
    eva_time: a.eva_time || null,
    flights_count: a.flights_count ?? null,
    spacewalks_count: a.spacewalks_count ?? null,
    // La biografía es lo único voluminoso: se guarda solo para quien está en
    // órbita. En el catálogo completo son 858 personas y multiplicaría por
    // cinco el peso de un fichero que el móvil descarga entero.
    bio: withBio ? (a.bio || null) : null,
  };
}

async function fetchAstronauts() {
  console.log('📡 Fetching astronauts in space…');
  const url = `${API_BASE}/astronauts/?in_space=true&limit=50`;
  const data = await fetchJson(url);
  const list = (data.results || []).filter(isRealPerson).map(a => trimAstronaut(a));
  console.log(`  ✓ ${list.length} astronauts in space (1 request)`);
  return list;
}

/** Cada cuánto se refresca el catálogo completo. */
const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Catálogo COMPLETO de astronautas (~858), sin biografías.
 *
 * Son nueve peticiones, así que no se rehace a diario: solo si el fichero pasa
 * de una semana. A cambio, la app deja de depender de su lista estática, que es
 * de donde salían las fichas congeladas.
 */
async function fetchAstronautCatalog() {
  const file = path.join(OUT_DIR, 'astronauts-all.json');
  if (fs.existsSync(file)) {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < CATALOG_MAX_AGE_MS) {
      console.log(`⏭  Catálogo de astronautas fresco (${Math.round(age / 86400000)} d), se salta`);
      return null;
    }
  }

  console.log('📡 Fetching full astronaut catalog…');
  const limit = 100;
  let offset = 0;
  const all = [];
  for (;;) {
    const data = await fetchJson(`${API_BASE}/astronauts/?limit=${limit}&offset=${offset}&ordering=name`);
    const page = (data.results || []).filter(isRealPerson).map(a => trimAstronaut(a, { withBio: false }));
    all.push(...page);
    if (!data.next || (data.results || []).length === 0) break;
    offset += limit;
    await sleep(THROTTLE_MS);
  }
  console.log(`  ✓ ${all.length} astronautas en el catálogo`);
  return all;
}

/**
 * Cuánto puede encoger una lista respecto a la anterior antes de considerarlo
 * un fallo. Los lanzamientos futuros entran y salen constantemente, así que una
 * bajada del 20% es normal; perder la mitad de golpe no lo es.
 */
const SHRINK_GUARD = 0.5;

function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  const size = fs.statSync(filePath).size;
  console.log(`  💾 ${path.relative(path.join(__dirname, '..'), filePath)} (${(size / 1024).toFixed(0)} KB)`);
}

/**
 * Escribe una LISTA protegiendo lo que ya había.
 *
 * El riesgo real de este mirror no es que falle la petición —eso ya se
 * reintenta y se registra— sino que LL2 conteste 200 con una lista vacía o a
 * medias. Eso no es un error para nadie: el fichero se sobrescribiría, el
 * commit saldría limpio y TODAS las apps se quedarían con la pantalla vacía
 * hasta el siguiente run. Como el mirror es la única fuente de datos, aquí se
 * prefiere servir el fichero anterior —aunque tenga media hora— antes que
 * publicar uno peor.
 *
 * Devuelve el número de elementos que quedan publicados.
 */
function writeJsonList(filePath, data, label) {
  if (!Array.isArray(data)) {
    console.warn(`  ⚠ ${label}: la respuesta no es una lista; se conserva lo anterior.`);
    return previousLength(filePath);
  }

  const prev = previousLength(filePath);
  if (data.length === 0 && prev > 0) {
    console.warn(`  ⚠ ${label}: llegaron 0 elementos y había ${prev}. NO se sobrescribe.`);
    return prev;
  }
  if (prev > 0 && data.length < prev * SHRINK_GUARD) {
    console.warn(`  ⚠ ${label}: caída sospechosa (${prev} → ${data.length}). NO se sobrescribe.`);
    return prev;
  }

  writeJson(filePath, data);
  return data.length;
}

function previousLength(filePath) {
  try {
    const prev = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(prev) ? prev.length : 0;
  } catch {
    return 0;
  }
}

// Backfill: construye la década inmutable más antigua que aún falte (una por
// ejecución). Pensado para el tramo anónimo de 15 req/h: cada ejecución gasta
// pocas peticiones y un cron horario va completando 1957→hoy sin tocar el tope
// de 6 h de GitHub Actions. Cuando ya están todas, es un no-op.
async function backfillOneDecade() {
  fs.mkdirSync(HIST_DIR, { recursive: true });
  let index = {};
  try { index = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8')); } catch { /* sin index */ }
  if (!index.decades) index.decades = {};

  // Décadas pasadas que falten O que sigan sin fichero de detalle (espejadas
  // antes de esta feature) → se (re)bajan una por ejecución para generar el par
  // lista + detalle. Cuando todas tienen detalle, es no-op. Orden: de la más
  // RECIENTE a la más antigua (los vídeos/parches viven en las décadas modernas,
  // así la ficha "revive" se llena antes donde más se usa). ALL_DECADES ya está
  // en orden descendente.
  const missing = ALL_DECADES.find(
    d => d < CURRENT_DECADE && !decadeEnriched(d),
  );

  if (missing != null) {
    console.log(`⛏  Backfilling ${missing}s (lista + detalle)…`);
    const { list, detail } = await fetchDecade(missing);
    writeDecade(missing, list, detail);
    index.decades[`${missing}s`] = list.length;
    console.log(`✅ ${missing}s done (${list.length}, ${Object.keys(detail).length} con detalle).`);
  } else {
    // Décadas pasadas completas → avanzar la década ACTUAL año a año (cada cron
    // de 2 h baja un par de años hasta completarla; el año en curso se refresca).
    console.log('✅ Past decades complete — advancing the current decade…');
    try {
      index.decades[`${CURRENT_DECADE}s`] = await buildCurrentDecade();
    } catch (e) {
      console.warn(`⚠ current decade backfill failed: ${e.message} (se reintenta)`);
    }
  }

  index.generatedAt = new Date().toISOString();
  writeJson(path.join(OUT_DIR, 'index.json'), index);
}

async function main() {
  console.log(`🚀 SpacePulse mirror builder — ${FULL_MODE ? 'FULL' : BACKFILL_MODE ? 'backfill' : LIGHT_MODE ? 'upcoming-only' : 'default'} mode`);
  console.log(`   API: ${API_BASE}  Token: ${TOKEN ? 'yes' : 'no'}`);
  console.log('');

  if (BACKFILL_MODE) { await backfillOneDecade(); return; }

  if (MARS_MODE) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    try {
      const marsPhotos = await fetchMarsPhotos();
      writeJson(path.join(OUT_DIR, 'mars-photos.json'), marsPhotos);
      console.log('✅ Mars photos sync complete!');
    } catch (e) {
      console.error(`❌ Mars photos failed: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (MOON_MODE) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    try {
      const moonPhotos = await fetchMoonPhotos();
      writeJsonList(path.join(OUT_DIR, 'moon-photos.json'), moonPhotos, 'moon-photos');
      console.log('✅ Moon photos sync complete!');
    } catch (e) {
      console.error(`❌ Moon photos failed: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  fs.mkdirSync(HIST_DIR, { recursive: true });

  // Partimos del index existente para NO perder los contadores de décadas
  // pasadas: el run diario solo recorre la década actual, y arrancar con
  // `decades: {}` borraba 1950s-2010s del index en cada pasada.
  let prevIndex = {};
  try { prevIndex = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8')); } catch { /* sin index previo */ }
  const index = { generatedAt: new Date().toISOString(), decades: { ...(prevIndex.decades || {}) }, upcomingCount: 0, astronautCount: 0, eventCount: 0, marsPhotos: false };

  const upcoming = await fetchUpcoming();
  index.upcomingCount = writeJsonList(path.join(OUT_DIR, 'upcoming.json'), upcoming, 'upcoming');

  if (LIGHT_MODE) {
    // Cron frecuente: solo upcoming.json (1 req). Fusiona en el index existente
    // sin re-paginar décadas ni astronautas (eso lo hace el cron diario).
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8')); } catch { /* sin index previo */ }
    writeJson(path.join(OUT_DIR, 'index.json'), { ...prev, generatedAt: index.generatedAt, upcomingCount: upcoming.length });
    console.log('✅ Mirror upcoming-only sync complete!');
    return;
  }

  // Mars primero: usa NASA (no LL2), así se genera aunque el trabajo LL2
  // posterior falle o agote el límite. En su propio try/catch para no abortar
  // el resto del build (ni el commit del workflow).
  try {
    const marsPhotos = await fetchMarsPhotos();
    writeJson(path.join(OUT_DIR, 'mars-photos.json'), marsPhotos);
    index.marsPhotos = true;
  } catch (e) {
    console.warn(`⚠ Mars photos falló: ${e.message}`);
  }

  await sleep(THROTTLE_MS);

  try {
    const moonPhotos = await fetchMoonPhotos();
    index.moonPhotoCount = writeJsonList(
      path.join(OUT_DIR, 'moon-photos.json'), moonPhotos, 'moon-photos',
    );
  } catch (e) {
    console.warn(`⚠ Moon photos falló: ${e.message}`);
  }

  await sleep(THROTTLE_MS);

  const decades = FULL_MODE ? ALL_DECADES : [CURRENT_DECADE];
  for (const decade of decades) {
    try {
      if (decade < CURRENT_DECADE) {
        const decadeFile = path.join(HIST_DIR, `${decade}s.json`);
        if (decadeEnriched(decade)) {
          console.log(`⏭  Skipping ${decade}s (immutable, lista + detalle ya espejados)`);
          index.decades[`${decade}s`] = JSON.parse(fs.readFileSync(decadeFile, 'utf8')).length;
        } else {
          const { list, detail } = await fetchDecade(decade);
          writeDecade(decade, list, detail);
          index.decades[`${decade}s`] = list.length;
        }
      } else {
        // Década actual: construcción incremental año a año (un fallo no tumba
        // el resto del build — astronautas/eventos/Mars siguen ejecutándose).
        index.decades[`${decade}s`] = await buildCurrentDecade();
      }
    } catch (e) {
      console.warn(`⚠ ${decade}s falló en este run: ${e.message} (se reintenta en la próxima)`);
      const decadeFile = path.join(HIST_DIR, `${decade}s.json`);
      if (fs.existsSync(decadeFile)) index.decades[`${decade}s`] = JSON.parse(fs.readFileSync(decadeFile, 'utf8')).length;
    }
    await sleep(THROTTLE_MS);
  }

  await sleep(THROTTLE_MS);

  // Cada sección en su propio try/catch: un fallo (p.ej. 429 de LL2 en la
  // lista de astronautas) no debe abortar el build ni saltarse el commit.
  try {
    const astronauts = await fetchAstronauts();
    index.astronautCount = writeJsonList(path.join(OUT_DIR, 'astronauts.json'), astronauts, 'astronauts');

    await sleep(THROTTLE_MS);
    const catalog = await fetchAstronautCatalog();
    if (catalog) {
      index.astronautCatalogCount = writeJsonList(
        path.join(OUT_DIR, 'astronauts-all.json'), catalog, 'astronauts-all',
      );
    } else {
      index.astronautCatalogCount = previousLength(path.join(OUT_DIR, 'astronauts-all.json'));
    }
  } catch (e) {
    console.warn(`⚠ Astronauts falló: ${e.message}`);
  }

  await sleep(THROTTLE_MS);

  try {
    const events = await fetchEvents();
    index.eventCount = writeJsonList(path.join(OUT_DIR, 'events.json'), events, 'events');
  } catch (e) {
    console.warn(`⚠ Events falló: ${e.message}`);
  }

  writeJson(path.join(OUT_DIR, 'index.json'), index);

  console.log('');
  console.log('✅ Mirror build complete!');
  console.log(`   Upcoming: ${index.upcomingCount}  Astronauts: ${index.astronautCount}  Events: ${index.eventCount}  Mars photos: ${index.marsPhotos ? 'yes' : 'no'}`);
  console.log(`   Decades: ${Object.entries(index.decades).map(([d, c]) => `${d}=${c}`).join(', ')}`);
}

main().catch(err => {
  console.error('❌ Mirror build failed:', err);
  process.exit(1);
});
