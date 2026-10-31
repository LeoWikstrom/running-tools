import L from 'leaflet';
import { panToVisible } from './ui/visibleMap';

export interface LocateHandle {
  /** Place or move the dot from outside (the run service's GPS fixes). */
  setPosition(lat: number, lon: number): void;
  /** Run mode: the dot defaults on (service fixes, no watch); turning it off
      there is remembered for the next run. */
  enterRunMode(): void;
  exitRunMode(): void;
  stop(): void;
}

const RUN_GPS_OFF_KEY = 'runtour.runGpsOff';

/**
 * A blue "you are here" dot with a toggle button on the map. Planning mode:
 * on, it follows navigator.geolocation; off, the dot goes away. Run mode: the
 * service's GPS drives it through setPosition instead.
 */
export function initLocate(
  map: L.Map,
  sheet: HTMLElement,
  button: HTMLButtonElement,
): LocateHandle {
  let marker: L.CircleMarker | null = null;
  let watchId: number | null = null;
  let runMode = false;
  let runEnabled = true;
  /** Switching the dot on centres the map on the first fix that arrives. */
  let centerNext = false;

  const show = (lat: number, lon: number): void => {
    if (centerNext) {
      centerNext = false;
      panToVisible(map, sheet, lat, lon);
    }
    if (!marker) {
      marker = L.circleMarker([lat, lon], {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: '#1976d2',
        fillOpacity: 1,
      }).addTo(map);
    } else {
      marker.setLatLng([lat, lon]);
    }
  };

  const hide = (): void => {
    marker?.remove();
    marker = null;
  };

  const reflect = (on: boolean): void => {
    button.setAttribute('aria-pressed', String(on));
    button.classList.toggle('active', on);
  };

  function stopWatching(): void {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    reflect(false);
    hide();
  }

  function startWatching(): void {
    if (!('geolocation' in navigator)) {
      button.disabled = true;
      return;
    }
    reflect(true);
    centerNext = true;
    watchId = navigator.geolocation.watchPosition(
      (pos) => show(pos.coords.latitude, pos.coords.longitude),
      () => stopWatching(),
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
  }

  button.addEventListener('click', () => {
    if (runMode) {
      runEnabled = !runEnabled;
      localStorage.setItem(RUN_GPS_OFF_KEY, runEnabled ? '0' : '1');
      if (runEnabled) startWatching();
      else stopWatching();
      return;
    }
    if (watchId !== null) stopWatching();
    else startWatching();
  });

  return {
    setPosition(lat: number, lon: number): void {
      if (runMode && !runEnabled) return;
      show(lat, lon);
    },
    enterRunMode(): void {
      stopWatching();
      runMode = true;
      runEnabled = localStorage.getItem(RUN_GPS_OFF_KEY) !== '1';
      // The service's GPS drives setPosition too, but it is GPS-only and dry
      // indoors; the browser watch (fused providers) keeps the dot alive.
      if (runEnabled) startWatching();
      else reflect(false);
    },
    exitRunMode(): void {
      stopWatching();
      runMode = false;
      reflect(false);
      hide();
    },
    stop(): void {
      stopWatching();
    },
  };
}
