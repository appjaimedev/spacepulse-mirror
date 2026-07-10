#!/usr/bin/env node

/**
 * scripts/fetch-milestone-images.js
 * Busca en la API de Wikimedia Commons una imagen por hito (términos
 * curados), descarga el thumb real (iiurlwidth) y lo procesa con sharp a
 * JPEG ≤1200px (mismo estilo que el resto de docs/img/milestones/).
 * Se salta los ids que ya tienen fichero. Tras esto: node scripts/make-thumbs.js
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'img', 'milestones');
const UA = { 'User-Agent': 'SpacePulse-mirror/1.0 (image sourcing; contact: app.jaimedev@gmail.com)' };

// id → términos de búsqueda en Commons (curados a mano)
const SEARCH = {
  luna1_1959:        'Luna 1 spacecraft',
  voskhod1_1964:     'Voskhod 1 spacecraft',
  asterix_1965:      'Asterix A-1 satellite France',
  gemini6a7_1965:    'Gemini 7 seen from Gemini 6',
  surveyor1_1966:    'Surveyor 1 lunar lander',
  apollo4_1967:      'Apollo 4 Saturn V launch',
  dongfanghong1_1970:'Dong Fang Hong 1 satellite',
  ohsumi_1970:       'Ohsumi satellite Japan',
  luna16_1970:       '"Luna 16"',
  apollo15_1971:     'Apollo 15 Lunar Roving Vehicle',
  soyuz11_1971:      'Soyuz 11 crew',
  venera9_1975:      'Venera 9 Venus surface',
  aryabhata_1975:    '"Aryabhata" satellite',
  esa_founded_1975:  'European Space Agency ESOC main control room',
  ariane1_1979:      'Ariane 1 rocket',
  merbold_sts9_1983: 'Ulf Merbold astronaut',
  giotto_halley_1986:'Giotto spacecraft Halley',
  columbus_2008:     'Columbus module International Space Station',
  atv_julesverne_2008:'Jules Verne ATV approaching ISS',
  hayabusa_2010:     'Hayabusa spacecraft asteroid',
  shenzhou9_2012:    'Shenzhou 9 mission 2012',
  change5_2020:      "Chang'e 5 launch Long March 5",
  ingenuity_2021:    'Ingenuity Mars helicopter Perseverance',
  tiangong_2022:     'Tiangong space station orbit',
  nuri_2022:         'KSLV-2 Nuri',
  osirisrex_2023:    'OSIRIS-REx sample return capsule',
  juice_2023:        'JUICE Jupiter Icy Moons Explorer spacecraft',
};

async function commonsSearch(terms) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `filetype:bitmap ${terms}`,
    gsrnamespace: '6',
    gsrlimit: '6',
    prop: 'imageinfo',
    iiprop: 'url|size|mime',
    iiurlwidth: '1200',
    format: 'json',
  });
  const resp = await fetch(url, { headers: UA });
  if (!resp.ok) throw new Error(`API HTTP ${resp.status}`);
  const data = await resp.json();
  const pages = Object.values(data.query?.pages ?? {});
  pages.sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii) continue;
    if (!/jpeg|png/.test(ii.mime)) continue;
    if ((ii.width ?? 0) < 500) continue;           // demasiado pequeña
    return { title: p.title, url: ii.thumburl || ii.url };
  }
  return null;
}

async function main() {
  const sharp = require('sharp');
  const report = [];
  for (const [id, terms] of Object.entries(SEARCH)) {
    const out = path.join(OUT_DIR, `${id}.jpg`);
    if (fs.existsSync(out)) { report.push(`⏭ ${id} (ya existe)`); continue; }
    try {
      const hit = await commonsSearch(terms);
      if (!hit) { report.push(`✗ ${id}: sin resultados para "${terms}"`); continue; }
      const resp = await fetch(hit.url, { headers: UA });
      if (!resp.ok) { report.push(`✗ ${id}: descarga HTTP ${resp.status}`); continue; }
      const buf = Buffer.from(await resp.arrayBuffer());
      await sharp(buf)
        .resize({ width: 1200, withoutEnlargement: true })
        .jpeg({ quality: 80, mozjpeg: true })
        .toFile(out);
      const kb = Math.round(fs.statSync(out).size / 1024);
      report.push(`✓ ${id} ← ${hit.title} (${kb} KB)`);
    } catch (e) {
      report.push(`✗ ${id}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(report.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
