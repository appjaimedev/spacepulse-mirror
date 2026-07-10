#!/usr/bin/env node

/**
 * scripts/make-thumbs.js
 * Genera thumbnails (~480px de ancho, JPEG q72) de las imágenes de hitos:
 *   docs/img/milestones/<id>.jpg  →  docs/img/milestones/thumb/<id>.jpg
 *
 * La app usa el thumb en las tarjetas de listado (cascada thumb → full →
 * emoji vía FallbackImage) y la imagen completa en el modal de detalle.
 * Idempotente: se salta los thumbs ya generados y más recientes que su
 * original. Requiere `sharp` (npm i sharp).
 *
 * Uso:  node scripts/make-thumbs.js
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'docs', 'img', 'milestones');
const OUT_DIR = path.join(SRC_DIR, 'thumb');
const WIDTH = 480;
const QUALITY = 72;

async function main() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.error('sharp no está instalado — ejecuta: npm i sharp');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = fs.readdirSync(SRC_DIR).filter(f => f.toLowerCase().endsWith('.jpg'));

  let made = 0, skipped = 0, before = 0, after = 0;
  for (const f of files) {
    const src = path.join(SRC_DIR, f);
    const out = path.join(OUT_DIR, f);
    const srcStat = fs.statSync(src);
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= srcStat.mtimeMs) {
      skipped++;
      continue;
    }
    await sharp(src)
      .resize({ width: WIDTH, withoutEnlargement: true })
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .toFile(out);
    before += srcStat.size;
    after += fs.statSync(out).size;
    made++;
  }

  console.log(`✅ thumbs: ${made} generados, ${skipped} al día (${files.length} total)`);
  if (made > 0) {
    console.log(`   ${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(1)} MB (${Math.round((1 - after / before) * 100)}% menos)`);
  }
}

main().catch(err => { console.error('❌', err); process.exit(1); });
