#!/usr/bin/env node
/**
 * scripts/build-ics.js
 * Publica docs/api/launches.ics: un calendario SUSCRIBIBLE con los próximos
 * lanzamientos. Como el fichero se regenera en cada sync, quien se suscriba
 * ve las fechas nuevas sin volver a exportar nada.
 *
 * Solo entran los lanzamientos con fecha real. LL2 rellena el NET de los que
 * no tienen fecha con el último día del periodo conocido —el 31 de diciembre
 * para los que solo se sabe el año—, y meter eso en el calendario de alguien
 * sería sembrarlo de citas falsas.
 *
 * Uso: node scripts/build-ics.js
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'api');
const UPCOMING = path.join(OUT_DIR, 'upcoming.json');
const OUT_FILE = path.join(OUT_DIR, 'launches.ics');

/** Precisiones que describen un día concreto. */
const EXACT = new Set(['second', 'minute', 'hour', 'day']);

/** Duración por defecto de la cita, en minutos. Un lanzamiento no "dura", pero
 *  un evento de 0 minutos se pinta raro en casi todos los calendarios. */
const EVENT_MINUTES = 60;

function icsTime(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Escapa según RFC 5545: comas, puntos y comas, barras y saltos de línea. */
function esc(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Plegado de líneas a 75 octetos, que exige el RFC y algunos clientes aplican. */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '';
  for (const ch of line) {
    const next = cur + ch;
    if (Buffer.from(next, 'utf8').length > 73) { out.push(cur); cur = ' ' + ch; }
    else cur = next;
  }
  if (cur) out.push(cur);
  return out.join('\r\n');
}

function main() {
  let upcoming;
  try {
    upcoming = JSON.parse(fs.readFileSync(UPCOMING, 'utf8'));
  } catch {
    console.warn('⚠ upcoming.json ausente; no se genera el .ics.');
    return;
  }
  if (!Array.isArray(upcoming)) return;

  const now = new Date();
  const stamp = icsTime(now);

  const events = [];
  let skipped = 0;

  for (const l of upcoming) {
    const precision = (l.net_precision && l.net_precision.name || '').toLowerCase();
    if (precision && !EXACT.has(precision)) { skipped++; continue; }
    const start = new Date(l.net);
    if (Number.isNaN(start.getTime())) { skipped++; continue; }
    // Sin net_precision (mirror antiguo) se descarta lo que huele a relleno:
    // 00:00:00Z del último día de un mes.
    if (!precision) {
      const isMidnight = start.getUTCHours() === 0 && start.getUTCMinutes() === 0 && start.getUTCSeconds() === 0;
      const nextDay = new Date(start.getTime() + 86400000);
      if (isMidnight && nextDay.getUTCMonth() !== start.getUTCMonth()) { skipped++; continue; }
    }

    const end = new Date(start.getTime() + EVENT_MINUTES * 60 * 1000);
    const provider = (l.launch_service_provider && l.launch_service_provider.name) || '';
    const pad = (l.pad && l.pad.name) || '';
    const place = (l.pad && l.pad.location && l.pad.location.name) || '';
    const status = (l.status && l.status.name) || '';
    const desc = [
      provider && `Provider: ${provider}`,
      status && `Status: ${status}`,
      `https://appjaimedev.github.io/spacepulse-mirror/`,
    ].filter(Boolean).join('\n');

    events.push([
      'BEGIN:VEVENT',
      fold(`UID:${l.id}@spacepulse`),
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(start)}`,
      `DTEND:${icsTime(end)}`,
      fold(`SUMMARY:🚀 ${esc(l.name)}`),
      fold(`DESCRIPTION:${esc(desc)}`),
      fold(`LOCATION:${esc([pad, place].filter(Boolean).join(', '))}`),
      'END:VEVENT',
    ].join('\r\n'));
  }

  const cal = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SpacePulse//Mission Control//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:SpacePulse — Upcoming launches',
    'X-WR-CALDESC:Confirmed upcoming orbital launches. Updates automatically.',
    // Dos formas de pedir lo mismo: los clientes modernos leen REFRESH-INTERVAL,
    // los viejos X-PUBLISHED-TTL.
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';

  fs.writeFileSync(OUT_FILE, cal);
  const kb = (fs.statSync(OUT_FILE).size / 1024).toFixed(0);
  console.log(`  💾 launches.ics (${kb} KB, ${events.length} eventos; ${skipped} sin fecha confirmada, omitidos)`);
}

main();
