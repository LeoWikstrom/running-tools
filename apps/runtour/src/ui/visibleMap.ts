import L from 'leaflet';

/** How much of the window the sheet covers: its bottom on a phone, left on desktop. */
function cover(sheet: HTMLElement): { left: number; bottom: number } {
  const r = sheet.getBoundingClientRect();
  const wide = window.matchMedia('(min-width: 900px)').matches;
  return {
    left: wide ? r.width : 0,
    bottom: wide ? 0 : Math.max(0, window.innerHeight - Math.max(0, r.top)),
  };
}

/** fitBounds into the part of the map the sheet leaves visible. */
export function fitVisible(map: L.Map, sheet: HTMLElement, bounds: L.LatLngBounds): void {
  const c = cover(sheet);
  map.fitBounds(bounds, {
    paddingTopLeft: L.point(24 + c.left, 24),
    paddingBottomRight: L.point(24, 24 + c.bottom),
  });
}

/** Centre a point in the visible part of the map, not the window. */
export function panToVisible(map: L.Map, sheet: HTMLElement, lat: number, lon: number): void {
  const c = cover(sheet);
  const shifted = map
    .project([lat, lon], map.getZoom())
    .add(L.point(-c.left / 2, c.bottom / 2));
  map.panTo(map.unproject(shifted, map.getZoom()));
}
