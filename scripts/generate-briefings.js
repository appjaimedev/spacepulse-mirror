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
    // GITHUB_TOKEN sirve si el workflow declara `permissions: models: read`.
    key:   () => process.env.BRIEFING_API_KEY || process.env.GITHUB_TOKEN,
    base:  () => process.env.BRIEFING_BASE || 'https://models.github.ai/inference/chat/completions',
    model: () => process.env.BRIEFING_MODEL || 'openai/gpt-4o-mini',
  },
};

const PROVIDER = process.env.BRIEFING_PROVIDER
  || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');
const CFG = PROVIDERS[PROVIDER];
const API_KEY = CFG ? CFG.key() : null;
const MODEL = CFG ? CFG.model() : null;

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

async function callModel(prompt) {
  const isAnthropic = PROVIDER === 'anthropic';
  const headers = isAnthropic
    ? { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` };
  const body = isAnthropic
    ? { model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }
    : { model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] };

  const res = await fetch(CFG.base(), { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
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
      const parsed = await callModel(buildPrompt(launchFacts(launch)));
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
    }
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
