import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { parseGpx } from '@running/core/gpx/parse';
import { haversineMeters } from '@running/core/geo';
import { initSheet } from './ui/sheet';

const sheet = document.getElementById('sheet')!;
const handle = document.getElementById('sheet-handle')!;
initSheet(sheet, handle);

const map = L.map('map', { zoomControl: true }).setView([57.7089, 11.9746], 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

let courseLine: L.Polyline | null = null;

const gpxInput = document.getElementById('gpx-input') as HTMLInputElement;
const stats = document.getElementById('course-stats') as HTMLParagraphElement;
const hint = document.getElementById('hint') as HTMLParagraphElement;

gpxInput.addEventListener('change', () => {
  const file = gpxInput.files?.[0];
  if (!file) return;
  void (async () => {
    try {
      const gpx = parseGpx(await file.text());
      if (gpx.points.length < 2) throw new Error('No track points found in the file.');
      const latlngs = gpx.points.map((p) => [p.lat, p.lon] as [number, number]);
      let distance = 0;
      for (let i = 1; i < gpx.points.length; i++) {
        const a = gpx.points[i - 1]!;
        const b = gpx.points[i]!;
        distance += haversineMeters(a.lat, a.lon, b.lat, b.lon);
      }
      courseLine?.remove();
      courseLine = L.polyline(latlngs, { color: '#2d7a4f', weight: 4 }).addTo(map);
      map.fitBounds(courseLine.getBounds(), { padding: [24, 24] });
      stats.textContent = `${gpx.name ?? file.name} — ${(distance / 1000).toFixed(1)} km, ${gpx.points.length} points`;
      stats.hidden = false;
      hint.hidden = true;
    } catch (err) {
      stats.textContent = err instanceof Error ? err.message : String(err);
      stats.hidden = false;
    }
  })();
});
