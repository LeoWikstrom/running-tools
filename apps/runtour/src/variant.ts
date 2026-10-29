/** Build-time variant: one codebase, two builds (vite --mode bus). */
export const VARIANT: 'run' | 'bus' = import.meta.env.MODE === 'bus' ? 'bus' : 'run';

export const APP_NAME = VARIANT === 'bus' ? 'BusTour' : 'RunTour';
export const THEME_COLOR = VARIANT === 'bus' ? '#1d5fa8' : '#2d7a4f';
/** Course line and pipeline place markers follow the variant accent. */
export const PLACE_COLOR = THEME_COLOR;

export interface VariantDefaults {
  /** Travel pace, seconds per km (run ≈ 5:30/km; bus ≈ 22 km/h in city). */
  paceSecPerKm: number;
  /** Audio starts this far before the place, metres. */
  leadDistance: number;
  /** Along-course gap under which the lower-scored place is thinned, metres. */
  minSpacing: number;
  /** Player: how early a queued clip may fire, metres before its trigger. */
  triggerWindowM: number;
  /** Player: drop a queued clip once this far past its trigger, metres. */
  dropAfterM: number;
  /** Lateral reach of the place search, metres. A tram window sweeps much
      further than a runner's eyes; line of sight culls what walls hide. */
  corridorWidth: number;
}

export const VARIANT_DEFAULTS: VariantDefaults =
  VARIANT === 'bus'
    ? {
        paceSecPerKm: 160,
        leadDistance: 120,
        minSpacing: 350,
        triggerWindowM: 300,
        dropAfterM: 450,
        corridorWidth: 350,
      }
    : {
        paceSecPerKm: 330,
        leadDistance: 30,
        minSpacing: 200,
        triggerWindowM: 150,
        dropAfterM: 200,
        corridorWidth: 60,
      };
