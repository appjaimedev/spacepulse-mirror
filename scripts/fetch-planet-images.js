/**
 * scripts/fetch-planet-images.js
 * Descarga imágenes de planetas desde Wikimedia Commons (API imageinfo →
 * URL real, nunca URLs construidas a mano) y las procesa al formato del
 * mirror: 256x256 JPEG centrado, como las 6 existentes.
 *
 *   node scripts/fetch-planet-images.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const UA = 'SpacePulseMirror/1.0 (github.com/appjaimedev/spacepulse-mirror)';
const OUT = path.join(__dirname, '..', 'docs', 'img', 'planets');

// Ficheros exactos en Commons — todos dominio público NASA.
const WANTED = [
  { id: 'earth', title: 'File:The Earth seen from Apollo 17.jpg' },          // Blue Marble, Apollo 17
  { id: 'mars',  title: 'File:Mars Valles Marineris EDIT.jpg' },             // mosaico Viking 1
  { id: 'pluto', title: 'File:Pluto in True Color - High-Res.jpg' },         // New Horizons 2015
];

async function commonsUrl(title) {
  const api = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url|size&iiurlwidth=1024&format=json`;
  const resp = await fetch(api, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`API HTTP ${resp.status} for ${title}`);
  const json = await resp.json();
  const pages = json?.query?.pages || {};
  const page = Object.values(pages)[0];
  const info = page?.imageinfo?.[0];
  if (!info) throw new Error(`no imageinfo for ${title} (missing/renamed?)`);
  return info.thumburl || info.url;
}

(async () => {
  for (const { id, title } of WANTED) {
    const url = await commonsUrl(title);
    console.log(`${id}: ${url}`);
    const resp = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!resp.ok) throw new Error(`download HTTP ${resp.status} for ${id}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const out = path.join(OUT, `${id}.jpg`);
    await sharp(buf)
      .resize(256, 256, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 82 })
      .toFile(out);
    const kb = Math.round(fs.statSync(out).size / 1024);
    console.log(`  -> ${out} (${kb}KB)`);
  }
  console.log('done');
})().catch((e) => { console.error(e.message); process.exit(1); });
