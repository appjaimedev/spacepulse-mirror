#!/usr/bin/env node
/**
 * scripts/fetch-body-images.js
 * Imágenes de los cuerpos menores del comparador del Sistema Solar —lunas
 * grandes, planetas enanos, asteroides y un cometa— procesadas al formato del
 * mirror: 256x256 JPEG, como las de los planetas.
 *
 * Por qué no basta con escribir los títulos de Commons a mano: los ficheros se
 * renombran y la mitad de los que parecen de la NASA no declaran licencia en
 * sus metadatos (comprobado con PIA17485 y PIA23017: solo traen autor). Así que
 * aquí NADA se da por supuesto:
 *
 *   1. Se prueban los títulos preferidos, si los hay.
 *   2. Si ninguno vale, se BUSCA en Commons y se coge el primer resultado que
 *      pase el filtro.
 *   3. El filtro exige una licencia libre explícita. Sin licencia declarada, se
 *      descarta — aunque la imagen sea de la NASA y casi seguro sea dominio
 *      público. "Casi seguro" no es una licencia.
 *   4. Se rechaza lo que no sea aproximadamente cuadrado: varias fotos son dos
 *      globos uno al lado del otro y un recorte centrado los parte por la mitad.
 *
 * Cada imagen elegida queda anotada en credits.json con su título, licencia y
 * autor. Ese fichero es el que permite acreditar en la app y revisar después de
 * dónde salió cada cosa.
 *
 *   node scripts/fetch-body-images.js [--only <id>]
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const UA = 'SpacePulseMirror/1.0 (github.com/appjaimedev/spacepulse-mirror)';
const API = 'https://commons.wikimedia.org/w/api.php';
const OUT = path.join(__dirname, '..', 'docs', 'img', 'bodies');
const CREDITS = path.join(OUT, 'credits.json');

/** Licencias que aceptamos. Fuera NC y ND: no son libres para este uso. */
const LICENSE_OK = /^(public domain|cc0|cc by(-sa)? ?[0-9.]*( igo)?)$/i;

/**
 * `kind` es editorial, no viene de Commons: de Eris, Makemake y Haumea NO hay
 * ninguna foto de cerca — solo impresiones artísticas y un punto en el Hubble.
 * Marcarlas como ilustración es la diferencia entre informar y engañar.
 */
const BODIES = [
  // ── Lunas: todas tienen foto real de sonda ──
  { id: 'moon',      kind: 'photo', prefer: ['File:Moon nearside LRO 5000.jpg'], queries: ['Moon nearside LRO mosaic'] },
  { id: 'io',        kind: 'photo', prefer: ['File:Io highest resolution true color.jpg'], queries: ['Io true color Galileo'] },
  { id: 'europa',    kind: 'photo', prefer: ['File:Europa-moon-with-margins.jpg', 'File:Europa-moon.jpg'], queries: ['Europa moon Galileo natural color'] },
  { id: 'ganymede',  kind: 'photo', prefer: ['File:Ganymede, moon of Jupiter, NASA.jpg'], queries: ['Ganymede moon Galileo'] },
  { id: 'callisto',  kind: 'photo', prefer: ['File:Callisto, moon of Jupiter, NASA.jpg'], queries: ['Callisto moon Galileo'] },
  { id: 'titan',     kind: 'photo', prefer: ['File:Titan in true color.jpg'], queries: ['Titan Cassini true color'] },
  { id: 'enceladus', kind: 'photo', prefer: ['File:Cassini Rev 230 - Enceladus (40974335232).png', 'File:Enceladus Cassini 2012-05-01.jpg'], queries: ['Enceladus Cassini full disk'] },
  { id: 'triton',    kind: 'photo', prefer: ['File:Triton moon mosaic Voyager 2 (large).jpg'], queries: ['Triton Voyager 2 mosaic'] },

  // ── Enanos, asteroides y cometa ──
  { id: 'ceres',     kind: 'photo',
    prefer: ['File:Ceres - RC3 - Haulani Crater (22381131691).jpg'],
    queries: ['Ceres Dawn spacecraft photograph', 'Ceres dwarf planet Dawn true color', 'Ceres dwarf planet Dawn global view'] },
  { id: 'vesta',     kind: 'photo', prefer: ['File:Vesta full mosaic.jpg'], queries: ['Vesta Dawn mosaic'] },
  // La versión sin recortar lleva el título y la barra de calibración QUEMADOS
  // en la imagen ("HMC 68 Image Composite · Comet Halley 14th March 1986"): en
  // un círculo pequeño es una mancha gris con letras.
  { id: 'halley',    kind: 'photo', prefer: ['File:Comet Halley close up-cropped.jpg'], queries: ['Comet Halley nucleus Giotto'] },
  // Sin foto posible: lo que hay son concepciones artísticas.
  { id: 'eris',      kind: 'illustration', prefer: [], queries: ['Eris dwarf planet artist concept'],
    focus: [0.38, 0.38, 0.52, 0.56] },
  // Las dos variantes de apóstrofo: Commons usa el tipográfico y el recto según
  // el fichero, y `titles=` no normaliza — el preferido fallaba por eso.
  { id: 'makemake',  kind: 'illustration',
    prefer: ['File:Makemake Animation.gif', "File:Makemake and Its Moon (Artist's Concept).jpg"],
    queries: ['Makemake and its moon artist concept', 'Makemake dwarf planet artist concept'] },
  { id: 'haumea',    kind: 'illustration', prefer: ['File:2003EL61art.jpg'], queries: ['Haumea dwarf planet artist impression'] },
];

const strip = v => String(v || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * Wikimedia responde 429 en cuanto se le pide de seguido. Se respeta su
 * Retry-After y se espera de más entre peticiones: son 14 imágenes una sola
 * vez, no hay ninguna prisa que justifique que nos corten.
 */
async function fetchPolite(url, attempt = 0) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (res.status === 429 && attempt < 4) {
    const after = Number(res.headers.get('retry-after'));
    const delay = Number.isFinite(after) && after > 0 ? after * 1000 : 5000 * (attempt + 1);
    console.log(`   … 429, esperando ${Math.round(delay / 1000)}s`);
    await wait(delay);
    return fetchPolite(url, attempt + 1);
  }
  return res;
}

/**
 * Media de luminosidad, medida SOBRE EL RESULTADO FINAL — no sobre el original.
 *
 * Medirla antes del recorte confunde dos cosas distintas: una foto donde el
 * cuerpo ocupa una esquina (se arregla recortando) y una donde el cuerpo está
 * a oscuras (no se arregla con nada). Midiendo antes, la concepción oficial de
 * Makemake salía con 12 de media y se descartaba, cuando recortada llena el
 * cuadro. Después del recorte, lo que sigue saliendo oscuro es lo que de verdad
 * está en sombra — un Encélado en cuarto creciente — y ese sí sobra.
 */
async function meanBrightness(buf) {
  const { channels } = await sharp(buf).stats();
  return channels.reduce((acc, ch) => acc + ch.mean, 0) / channels.length;
}

const MIN_BRIGHTNESS = 26;

/**
 * Recorta el espacio vacío y deja el cuerpo inscrito en el cuadrado.
 *
 * En una foto astronómica el cuerpo ocupa una fracción del encuadre y el resto
 * es negro. Recortada al círculo del comparador —20 px— eso queda en un punto
 * dentro de un disco negro. Con `trim` se ajusta al cuerpo y con `contain` se
 * rellena a cuadrado sin cortarle el limbo: al clipar el círculo, el disco lo
 * llena justo. Si el recorte falla (imagen sin bordes uniformes) se sigue con
 * la original, que es lo que hacían ya los planetas.
 */
async function squareCrop(buf, focus) {
  let img = sharp(buf);
  // Encuadre manual, en fracciones del original. Solo para las escenas donde el
  // cuerpo no está centrado y el fondo NO es negro liso, así que `trim` no puede
  // deducirlo: el concepto de Eris es un paisaje con el Sol lejano y la Vía
  // Láctea, y sin recorte el mayor círculo del grupo sale casi vacío.
  if (focus) {
    const meta = await sharp(buf).metadata();
    buf = await sharp(buf).extract({
      left:   Math.round(focus[0] * meta.width),
      top:    Math.round(focus[1] * meta.height),
      width:  Math.round(focus[2] * meta.width),
      height: Math.round(focus[3] * meta.height),
    }).toBuffer();
    img = sharp(buf);
  }
  try {
    const trimmed = await sharp(buf)
      .trim({ background: '#000000', threshold: 14 })
      .toBuffer();
    const meta = await sharp(trimmed).metadata();
    if (meta.width >= 200 && meta.height >= 200) img = sharp(trimmed);
  } catch { /* sin borde que recortar */ }
  return img
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
    .jpeg({ quality: 82 })
    .toBuffer();
}

function describe(page) {
  const info = (page.imageinfo || [])[0] || {};
  const meta = info.extmetadata || {};
  return {
    title:   page.title,
    url:     info.thumburl || info.url,
    width:   info.width,
    height:  info.height,
    license: strip((meta.LicenseShortName || {}).value),
    author:  strip((meta.Artist || {}).value),
    desc:    strip((meta.ImageDescription || {}).value),
  };
}

/**
 * ¿La imagen habla de ESTE cuerpo? La búsqueda de Makemake devolvió
 * `File:Dwarfplanet.jpg` —una ilustración genérica de "un planeta enano",
 * autopublicada, que no representa a Makemake ni a ningún cuerpo concreto—, y
 * con licencia buena y tamaño bueno habría entrado. Publicarla como Makemake
 * sería inventarse la imagen, que es peor que no tener ninguna.
 *
 * Se mira el título Y la descripción: las concepciones oficiales de Eris y
 * Haumea se llaman `2006-16-a-full-1-.jpg` y `2003EL61art.jpg`, y solo la
 * descripción dice de qué son.
 */
function mentionsBody(c, id) {
  const needle = new RegExp(`\\b${id}\\b`, 'i');
  if (needle.test(c.title)) return true;
  // Solo el ARRANQUE de la descripción, no toda: la de `Dwarfplanet.jpg` es un
  // ensayo sobre qué es un planeta enano y nombra a Makemake de pasada, así que
  // buscar en el texto entero volvía a colarla. Una descripción dice de qué es
  // en su primera frase: "Eris and its moon", "An artist's impression of
  // (136108) Haumea and moons".
  return needle.test(c.desc.slice(0, 120));
}

/** Cuadrada-ish y con resolución suficiente para un 256 nítido. */
function usable(c, id) {
  if (!c.url || !c.width || !c.height) return false;
  if (c.width < 400) return false;
  const aspect = c.width / c.height;
  if (aspect < 0.6 || aspect > 1.7) return false;
  if (!LICENSE_OK.test(c.license)) return false;
  return mentionsBody(c, id);
}

async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', ...params })}`;
  const res = await fetchPolite(url);
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  return res.json();
}

async function byTitle(title) {
  const j = await api({
    action: 'query', titles: title,
    prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1024',
  });
  const page = Object.values(j?.query?.pages || {})[0];
  return page && page.imageinfo ? describe(page) : null;
}

async function bySearch(query) {
  const j = await api({
    action: 'query', generator: 'search', gsrnamespace: '6', gsrlimit: '10',
    gsrsearch: `${query} filetype:bitmap`,
    prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1024',
  });
  // El orden del generador no es el de relevancia: se reordena por índice.
  return Object.values(j?.query?.pages || {})
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map(describe);
}

/** Candidatos aceptables, en orden: primero los preferidos, luego la búsqueda. */
async function candidates(body) {
  const good = [];
  const rejected = [];
  for (const title of body.prefer) {
    const c = await byTitle(title);
    await wait(1200);
    if (c && usable(c, body.id)) good.push(c);
    else rejected.push(`${title} → ${c ? (c.license || 'sin licencia declarada') : 'no existe'}`);
  }
  // Varias búsquedas por cuerpo: la primera de Ceres solo devolvía mapas
  // anotados de la Photojournal, todos sin licencia declarada.
  for (const query of body.queries) {
    for (const c of await bySearch(query)) {
      if (usable(c, body.id)) {
        if (!good.some(g => g.title === c.title)) good.push(c);
      } else {
        const why = !LICENSE_OK.test(c.license) ? (c.license || 'sin licencia declarada')
          : !mentionsBody(c, body.id) ? `no menciona "${body.id}"`
          : 'formato';
        rejected.push(`${c.title} → ${why}`);
      }
    }
    if (good.length > 0) break;
    await wait(1200);
  }
  return { good, rejected };
}

(async () => {
  const only = process.argv.includes('--only')
    ? process.argv[process.argv.indexOf('--only') + 1]
    : null;

  fs.mkdirSync(OUT, { recursive: true });
  const credits = fs.existsSync(CREDITS) ? JSON.parse(fs.readFileSync(CREDITS, 'utf8')) : {};
  let ok = 0, missing = 0;

  for (const body of BODIES) {
    if (only && body.id !== only) continue;
    const { good, rejected } = await candidates(body);
    let saved = null;

    for (const c of good) {
      const res = await fetchPolite(c.url);
      if (!res.ok) { rejected.push(`${c.title} → descarga HTTP ${res.status}`); continue; }
      const out = await squareCrop(Buffer.from(await res.arrayBuffer()), body.focus);
      const brightness = await meanBrightness(out);
      if (brightness < MIN_BRIGHTNESS) {
        rejected.push(`${c.title} → sigue oscura tras recortar (${brightness.toFixed(0)})`);
        await wait(1200);
        continue;
      }
      fs.writeFileSync(path.join(OUT, `${body.id}.jpg`), out);
      saved = c;
      break;
    }

    if (!saved) {
      missing++;
      console.warn(`✗ ${body.id}: sin imagen utilizable.`);
      for (const r of rejected.slice(0, 5)) console.warn(`    descartado: ${r}`);
      continue;
    }

    credits[body.id] = {
      kind: body.kind,
      title: saved.title,
      license: saved.license,
      author: saved.author,
      source: `https://commons.wikimedia.org/wiki/${encodeURIComponent(saved.title)}`,
    };
    ok++;
    // Se escribe tras CADA cuerpo, no al final: con los 429 de Wikimedia una
    // ejecución puede morir a medias, y sin esto las imágenes ya bajadas se
    // quedaban sin crédito y había que repetirlo todo.
    fs.writeFileSync(CREDITS, JSON.stringify(credits, null, 2) + '\n');
    const kb = Math.round(fs.statSync(path.join(OUT, `${body.id}.jpg`)).size / 1024);
    console.log(`✓ ${body.id.padEnd(10)} ${String(kb).padStart(3)}KB  ${saved.license.padEnd(14)} ${saved.title}`);
    await wait(1500);
  }

  fs.writeFileSync(CREDITS, JSON.stringify(credits, null, 2) + '\n');
  console.log(`\n${ok} imágenes, ${missing} sin imagen. Créditos en ${path.relative(process.cwd(), CREDITS)}`);
})().catch(e => { console.error(e.message); process.exit(1); });
