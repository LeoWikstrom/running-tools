export interface ExportPoint {
  lat: number;
  lon: number;
  ele: number;
}

export function buildGpx(name: string, desc: string, points: ExportPoint[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pts = points
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>${p.ele.toFixed(1)}</ele></trkpt>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="profile-course" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(name)}</name>
    <desc>${esc(desc)}</desc>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}
