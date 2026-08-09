#!/usr/bin/env node
/**
 * scripts/generate-briefings.js
 * Redacta los briefings de misión con un modelo de lenguaje y los publica como
 * JSON estático, uno por idioma, en docs/api/briefings/{lang}.json.
 *
 * Por qué aquí y no en la app: llamar a un modelo desde el móvil obligaría a
 * embarcar una clave de API en el APK, que cualquiera puede extraer. El mirror
 * ya es el sitio donde vive el dato horneado, y este workflow sí tiene un
 * secreto.
 *
 * Coste acotado a propósito:
 *   - Solo se generan los lanzamientos que NO estén ya en el fichero con el
 *     mismo hash de entrada. Un día normal son unos pocos.
 *   - Los 6 idiomas salen en UNA sola llamada por lanzamiento.
 *   - MAX_NEW_PER_RUN corta la primera ejecución para que no se dispare.
 *
 * Si no hay ninguna clave configurada el script no falla: avisa y sale con 0.
 * La app cae a sus plantillas locales y nadie nota nada.
 *
 * Proveedores (ver PROVIDERS más abajo): GitHub Models entra gratis con el
 * propio token del workflow; Claude, Gemini, Groq u OpenRouter con su secreto.
 *
 * Uso: node scripts/generate-briefings.js [--limit N]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'api');
const BRIEF_DIR = path.join(OUT_DIR, 'briefings');
const UPCOMING = path.join(OUT_DIR, 'upcoming.json');

const LANGS = ['en', 'es', 'fr', 'de', 'ja', 'zh'];
const LANG_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French',
  de: 'German', ja: 'Japanese', zh: 'Simplified Chinese',
};

// Claves de sección de la app: los títulos NO los escribe el modelo, se
// reutilizan las de la interfaz para que sigan traducidas y consistentes.
const SECTIONS = [
  { k: 'ai_brief_sec_overview', ask: 'what the mission is and why it matters' },
  { k: 'ai_brief_sec_vehicle',  ask: 'the rocket flying it and what stands out about it' },
  { k: 'ai_brief_sec_orbit',    ask: 'the target orbit and what that orbit is for' },
  { k: 'ai_brief_sec_site',     ask: 'the launch site and what it means to fly from there' },
  { k: 'ai_brief_sec_verdict',  ask: 'a short closing verdict on what to watch for' },
];

/**
 * Proveedor del modelo. Hay dos protocolos y con eso se cubre casi todo:
 *
 *   - 'anthropic'  → API de Claude (de pago).
 *   - 'openai'     → cualquier endpoint compatible con /chat/completions:
 *                    GitHub Models (gratis con límites, con el propio token del
 *                    workflow), Gemini por su endpoint compatible, Groq,
 *                    OpenRouter… Solo cambian BASE y MODEL.
 *
 * Se elige solo según la clave que exista, así que basta con añadir el secreto
 * correspondiente y no tocar nada más. Sin ninguna clave, el script no hace
 * nada y la app usa sus plantillas.
 */
const PROVIDERS = {
  anthropic: {
    key:   () => process.env.ANTHROPIC_API_KEY,
    base:  () => process.env.BRIEFING_BASE || 'https://api.anthropic.com/v1/messages',
    model: () => process.env.BRIEFING_MODEL || 'claude-haiku-4-5-20251001',
  },
  openai: {
    // Cualquier endpoint compatible con /chat/completions. El valor por defecto
    // apunta a Gemini porque es la opción con nivel gratuito más accesible,
    // pero solo se activa si hay clave: sin BRIEFING_API_KEY no se llama a nada.
    //
    // NO se usa el GITHUB_TOKEN del workflow: GitHub Models se está retirando y
    // responde 410 (github_models_retirement_brownout). Se probó el 8 de agosto
    // de 2026 y falló en todas las peticiones.
    key:   () => process.env.BRIEFING_API_KEY,
    base:  () => process.env.BRIEFING_BASE
             || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    // Solo la red de seguridad: si nadie fija BRIEFING_MODEL, el modelo se
    // descubre preguntando al proveedor (ver MODEL_PINNED más abajo).
    model: () => process.env.BRIEFING_MODEL || 'gemini-2.0-flash',
  },
};

const PROVIDER = process.env.BRIEFING_PROVIDER
  || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');
const CFG = PROVIDERS[PROVIDER];
const API_KEY = CFG ? CFG.key() : null;

// El modelo por defecto de arriba envejece: los nombres cambian y los retirados
// pierden su cuota gratuita, que se manifiesta como un 429 sin más pistas. Si
// nadie fija BRIEFING_MODEL se pregunta al proveedor qué modelos ve esta clave
// y se elige uno — la misma lección que GitHub Models y la API de Marte: no dar
// por hecho que sigue existiendo lo que existía.
let MODEL = CFG ? CFG.model() : null;
const MODEL_PINNED = !!process.env.BRIEFING_MODEL;

// Códigos que no son mala suerte de una petición: la clave no vale, no hay
// cuota o el modelo no existe. Reintentar los 11 lanzamientos restantes solo
// llena el log de lo mismo.
const FATAL_STATUS = new Set([400, 401, 403, 404, 429]);

// Qué modelo tiene cuota gratuita no lo dice ningún listado: hay que llamarlo.
// Por eso se prueban varios en orden y se para en el primero que responde.
const MAX_MODEL_TRIES = 4;
let fallbackModels = [];

/** Tope duro por sección. El texto viene de un modelo y va directo a la app. */
const MAX_SECTION_CHARS = 400;

const MAX_NEW_PER_RUN = Number(
  process.argv.includes('--limit')
    ? process.argv[process.argv.indexOf('--limit') + 1]
    : process.env.BRIEFING_LIMIT || 12,
);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Firma de los datos que alimentan el texto: si no cambian, no se regenera. */
function launchHash(l) {
  const sig = [
    l.id, l.name, l.net,
    l.rocket && l.rocket.configuration && l.rocket.configuration.full_name,
    l.mission && l.mission.name,
    l.mission && l.mission.type,
    l.mission && l.mission.orbit && l.mission.orbit.abbrev,
    l.pad && l.pad.name,
    l.launch_service_provider && l.launch_service_provider.name,
  ].join('|');
  return crypto.createHash('sha1').update(sig).digest('hex').slice(0, 12);
}

function launchFacts(l) {
  const cfg = (l.rocket && l.rocket.configuration) || {};
  return {
    name: l.name,
    provider: l.launch_service_provider && l.launch_service_provider.name,
    rocket: cfg.full_name || cfg.name,
    mission: l.mission && l.mission.name,
    missionType: l.mission && l.mission.type,
    orbit: l.mission && l.mission.orbit && (l.mission.orbit.abbrev || l.mission.orbit.name),
    pad: l.pad && l.pad.name,
    place: l.pad && l.pad.location && l.pad.location.name,
    net: l.net,
    netPrecision: l.net_precision && l.net_precision.name,
    status: l.status && l.status.name,
    description: (l.mission && l.mission.description) ? String(l.mission.description).slice(0, 600) : null,
  };
}

function buildPrompt(facts) {
  const sections = SECTIONS.map((s, i) => `${i + 1}. ${s.k} — ${s.ask}`).join('\n');
  return [
    'You write short mission briefings for a space-launch app. Tone: a knowledgeable',
    'flight analyst — factual, specific, never breathless. No emoji, no markdown, no headings.',
    '',
    'Rules that matter:',
    '- Use ONLY the facts given. Never invent dates, numbers, customers or outcomes.',
    '- If a fact is missing, write around it instead of guessing.',
    '- If netPrecision is coarser than "Day", the date is a placeholder: say the timing is not',
    '  yet confirmed rather than quoting a specific day.',
    '- Each section is ONE paragraph, 2 sentences, under 320 characters.',
    '- Say something specific to THIS launch in every section. Generic filler is a failure.',
    '',
    `Sections, in order:\n${sections}`,
    '',
    `Launch facts (JSON):\n${JSON.stringify(facts, null, 1)}`,
    '',
    `Write the briefing in each of these languages: ${LANGS.map(l => `${l} (${LANG_NAMES[l]})`).join(', ')}.`,
    'Write natively in each language — translate the meaning, not the words.',
    '',
    'Reply with JSON only, no prose around it, shaped exactly like:',
    '{"en":{"ai_brief_sec_overview":"…","ai_brief_sec_vehicle":"…","ai_brief_sec_orbit":"…","ai_brief_sec_site":"…","ai_brief_sec_verdict":"…"},"es":{…},"fr":{…},"de":{…},"ja":{…},"zh":{…}}',
  ].join('\n');
}

function authHeaders() {
  return PROVIDER === 'anthropic'
    ? { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${API_KEY}` };
}

/** El endpoint hermano de listado, derivado de la base del proveedor. */
function modelsUrl() {
  const base = CFG.base();
  return PROVIDER === 'anthropic'
    ? base.replace(/\/messages$/, '/models')
    : base.replace(/\/chat\/completions$/, '/models');
}

/** Ids de modelo que esta clave puede ver. Vacío si el listado no responde. */
async function listModels() {
  const res = await fetch(modelsUrl(), { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const list = data.data || data.models || [];
  return list
    .map(m => String((m && (m.id || m.name)) || ''))
    .filter(Boolean)
    // Gemini devuelve "models/gemini-…"; el endpoint de chat quiere el id pelado.
    .map(id => id.replace(/^models\//, ''));
}

/**
 * Candidatos ordenados: los que sirven para redactar texto, gama rápida primero
 * y estable antes que preview.
 *
 * Los límites de palabra son load-bearing: "gemini" CONTIENE "mini", así que sin
 * ellos todos los modelos de Google puntuaban como gama barata y el desempate
 * por nombre corto elegía "gemini-2.5-pro" — el único que seguro no entra en el
 * nivel gratuito. Se prefiere lo barato porque lo gratis vive ahí.
 */
function rankModels(ids) {
  const notChat  = /embed|aqa|image|imagen|veo|tts|audio|live|rerank|guard|vision|banana/i;
  const cheap    = /(^|[-_.])(flash|haiku|mini|lite|small|nano)/i;
  const premium  = /(^|[-_.])(pro|opus|ultra|max)/i;
  const unstable = /preview|exp|experimental|thinking/i;
  return ids
    .filter(id => !notChat.test(id))
    .map(id => ({
      id,
      score: (cheap.test(id) ? 2 : 0) + (premium.test(id) ? -2 : 0) + (unstable.test(id) ? 0 : 1),
    }))
    .sort((a, b) => b.score - a.score || a.id.length - b.id.length)
    .map(m => m.id);
}

async function callModel(prompt) {
  const isAnthropic = PROVIDER === 'anthropic';
  const headers = { 'content-type': 'application/json', ...authHeaders() };
  const body = isAnthropic
    ? { model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }
    : { model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] };

  const res = await fetch(CFG.base(), { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = isAnthropic
    ? (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
    : ((data.choices || [])[0] || {}).message?.content || '';
  // El modelo puede envolver el JSON en un bloque de código pese a lo pedido.
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('respuesta sin JSON');
  return JSON.parse(match[0]);
}

/**
 * Limpia el texto del modelo antes de guardarlo.
 *
 * Los nombres de misión vienen de LL2, es decir, de fuera: alguien podría meter
 * instrucciones en uno y torcer la respuesta. No se puede evitar del todo, pero
 * sí acotar el daño — el texto acaba mostrándose como párrafo plano en la app,
 * así que se recortan caracteres de control y longitud.
 */
function sanitize(text) {
  const clean = String(text)
    // Caracteres de control: nunca deben llegar a un <Text> de la app.
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length <= MAX_SECTION_CHARS
    ? clean
    : clean.slice(0, MAX_SECTION_CHARS - 1).trimEnd() + '…';
}

function validate(parsed) {
  for (const lang of LANGS) {
    const sec = parsed[lang];
    if (!sec || typeof sec !== 'object') return `falta el idioma ${lang}`;
    for (const s of SECTIONS) {
      if (typeof sec[s.k] !== 'string' || sec[s.k].trim().length < 20) {
        return `${lang}: sección ${s.k} vacía o demasiado corta`;
      }
    }
  }
  return null;
}

/**
 * Como callModel, pero si el modelo elegido no responde por algo estructural
 * (sin cuota, no existe, sin permiso) baja al siguiente candidato en vez de dar
 * por perdida la ejecución. Al primero que funciona se queda.
 */
async function callModelWithFallback(prompt) {
  for (;;) {
    try {
      return await callModel(prompt);
    } catch (err) {
      if (!FATAL_STATUS.has(err.status) || fallbackModels.length === 0) throw err;
      const next = fallbackModels.shift();
      console.warn(`   ↻ "${MODEL}" no vale (HTTP ${err.status}); se prueba "${next}".`);
      MODEL = next;
    }
  }
}

/**
 * Qué mirar cuando el fallo es de los que no se arreglan solos. El log de un
 * workflow es lo único que se puede leer después, así que aquí se deja escrito
 * qué significa el código y qué modelos ve la clave — sin la lista, un 429 no
 * distingue "sin cuota" de "modelo que ya no existe".
 */
async function explainFatal(status) {
  const hint = {
    400: 'petición o clave rechazadas: revisa que la clave sea del proveedor correcto.',
    401: 'clave inválida o caducada.',
    403: 'la clave no tiene permiso para este modelo o esta API.',
    404: 'el endpoint o el modelo no existen: revisa BRIEFING_BASE y BRIEFING_MODEL.',
    429: 'sin cuota. En Gemini esto sale también cuando el proyecto no tiene nivel gratuito para el modelo pedido, no solo al pasarse de peticiones.',
  }[status];
  if (hint) console.warn(`   ↳ ${hint}`);
  try {
    const ids = await listModels();
    console.warn(`   ↳ La clave ve ${ids.length} modelos: ${ids.slice(0, 25).join(', ')}${ids.length > 25 ? '…' : ''}`);
  } catch (err) {
    console.warn(`   ↳ Tampoco se pudo listar modelos: ${err.message}`);
  }
}

async function main() {
  if (!CFG) {
    console.warn(`⚠ BRIEFING_PROVIDER desconocido: ${PROVIDER}. Se omiten los briefings.`);
    return;
  }
  if (!API_KEY) {
    console.log(`ℹ Sin clave para el proveedor "${PROVIDER}" — se omiten los briefings.`);
    console.log('  La app seguirá usando sus plantillas locales.');
    return;
  }
  if (!MODEL_PINNED) {
    try {
      const ids = await listModels();
      const ranked = rankModels(ids).slice(0, MAX_MODEL_TRIES);
      if (ranked.length > 0) {
        console.log(`🔎 ${ids.length} modelos visibles; se probarán: ${ranked.join(' → ')}.`);
        MODEL = ranked[0];
        fallbackModels = ranked.slice(1);
      } else if (ids.length > 0) {
        console.warn(`⚠ Ninguno de los ${ids.length} modelos visibles sirve para chat; se prueba "${MODEL}".`);
      }
    } catch (err) {
      // El listado no es imprescindible: se sigue con el modelo por defecto y,
      // si falla, el diagnóstico de abajo lo cuenta.
      console.warn(`⚠ No se pudo listar modelos (${err.message}); se prueba "${MODEL}".`);
    }
  }
  console.log(`🤖 Proveedor: ${PROVIDER} · modelo: ${MODEL}`);

  const upcoming = readJson(UPCOMING, []);
  if (!Array.isArray(upcoming) || upcoming.length === 0) {
    console.warn('⚠ upcoming.json vacío o ausente; nada que redactar.');
    return;
  }

  fs.mkdirSync(BRIEF_DIR, { recursive: true });
  const stores = {};
  for (const lang of LANGS) {
    stores[lang] = readJson(path.join(BRIEF_DIR, `${lang}.json`), { items: {} });
    if (!stores[lang].items) stores[lang].items = {};
  }

  // Solo lo que falta o ha cambiado. El hash cubre el caso de un lanzamiento
  // que cambia de cohete, plataforma o ventana: el texto viejo dejaría de ser
  // cierto y hay que rehacerlo.
  const hashes = new Map(upcoming.map(l => [l.id, launchHash(l)]));
  const pending = upcoming.filter(l => {
    const stored = stores.en.items[l.id];
    return !stored || stored.hash !== hashes.get(l.id);
  });

  console.log(`📝 ${pending.length} briefings pendientes de ${upcoming.length} lanzamientos.`);
  const batch = pending.slice(0, MAX_NEW_PER_RUN);
  if (batch.length < pending.length) {
    console.log(`   Se redactan ${batch.length} en esta ejecución; el resto en las siguientes.`);
  }

  let written = 0;
  for (const launch of batch) {
    try {
      const parsed = await callModelWithFallback(buildPrompt(launchFacts(launch)));
      const problem = validate(parsed);
      if (problem) throw new Error(problem);

      for (const lang of LANGS) {
        stores[lang].items[launch.id] = {
          hash: hashes.get(launch.id),
          blocks: SECTIONS.map(s => ({ k: s.k, b: sanitize(parsed[lang][s.k]) })),
        };
      }
      written++;
      console.log(`   ✓ ${launch.name}`);
    } catch (err) {
      // Un fallo puntual no debe tumbar el build: ese lanzamiento se queda sin
      // briefing horneado y la app usa la plantilla.
      console.warn(`   ✗ ${launch.name}: ${err.message}`);
      if (FATAL_STATUS.has(err.status)) {
        console.warn(`   ⏹ ${err.status} no se arregla reintentando; se corta la tanda.`);
        await explainFatal(err.status);
        break;
      }
    }
  }

  // Si no hay ni un briefing (proveedor caído, sin cuota…) no se publican
  // ficheros vacíos: serían seis descargas por usuario para no encontrar nada.
  // Sin ellos, la app cae a plantillas exactamente igual.
  const anyContent = LANGS.some(lang => Object.keys(stores[lang].items).length > 0);
  if (!anyContent) {
    console.log('ℹ Ningún briefing disponible; no se publica nada. La app usa sus plantillas.');
    return;
  }

  // Poda: fuera los lanzamientos que ya no están en upcoming, o el fichero
  // crecería sin fin y el móvil se descargaría texto muerto.
  const live = new Set(upcoming.map(l => l.id));
  for (const lang of LANGS) {
    for (const id of Object.keys(stores[lang].items)) {
      if (!live.has(id)) delete stores[lang].items[id];
    }
    stores[lang].generatedAt = new Date().toISOString();
    const file = path.join(BRIEF_DIR, `${lang}.json`);
    fs.writeFileSync(file, JSON.stringify(stores[lang]));
    const kb = (fs.statSync(file).size / 1024).toFixed(0);
    console.log(`  💾 briefings/${lang}.json (${kb} KB, ${Object.keys(stores[lang].items).length} misiones)`);
  }

  console.log(`✅ ${written} briefings nuevos.`);
}

main().catch(err => {
  // Nunca se rompe el build del mirror por esto.
  console.warn(`⚠ generate-briefings falló: ${err.message}`);
});
