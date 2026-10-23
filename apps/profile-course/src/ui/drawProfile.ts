import { buildProfileFromSamples, SAMPLE_STEP_M, type TargetProfile } from '../gpx/profile';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 360;
const H = 150;
const PAD_L = 30;
const PAD_R = 6;
const PAD_T = 6;
const PAD_B = 16;
/** Steepest drawable slope — also what turns a vertical pull into distance. */
const MAX_GRADE = 0.2;
/** A drawn profile says nothing about turns; claim a typical urban course. */
const DRAWN_TURNS_PER_KM = 4;
/** How close to the knob a press must land to pick it up, in viewBox units. */
const GRAB_RADIUS = 26;

/**
 * A drawing pad for inventing a race: a km/elevation grid whose scales the two
 * sliders set, and a knob that starts on the centre line at the left. Pulling
 * it right draws the profile (up/down clamped to MAX_GRADE, so a vertical pull
 * still advances); pulling it left erases. "Use as input" turns the drawing
 * into the TargetProfile the search chases, exactly as an uploaded GPX would.
 */
export function initDrawProfile(onUse: (profile: TargetProfile) => void): void {
  const canvas = document.getElementById('draw-canvas') as HTMLElement;
  const lengthSlider = document.getElementById('draw-length') as HTMLInputElement;
  const elevSlider = document.getElementById('draw-elev') as HTMLInputElement;
  const lengthOut = document.getElementById('draw-length-value') as HTMLOutputElement;
  const elevOut = document.getElementById('draw-elev-value') as HTMLOutputElement;
  const useButton = document.getElementById('draw-use') as HTMLButtonElement;

  let lenM = Number(lengthSlider.value) * 1000;
  let maxE = Number(elevSlider.value);
  /** Elevation every 25 m relative to the start; the knob rides the end. */
  const samples: number[] = [0];

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Draw an elevation profile');
  svg.style.touchAction = 'none';
  const grid = document.createElementNS(SVG_NS, 'g');
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#c63d80');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-linejoin', 'round');
  const knob = document.createElementNS(SVG_NS, 'circle');
  knob.setAttribute('r', '7');
  knob.setAttribute('fill', '#c63d80');
  knob.setAttribute('stroke', '#fff');
  knob.setAttribute('stroke-width', '2');
  knob.style.cursor = 'grab';
  svg.append(grid, line, knob);
  canvas.appendChild(svg);

  const x = (d: number): number => PAD_L + (d / lenM) * (W - PAD_L - PAD_R);
  const y = (e: number): number => PAD_T + ((maxE - e) / (2 * maxE)) * (H - PAD_T - PAD_B);
  const endDist = (): number => (samples.length - 1) * SAMPLE_STEP_M;

  function gridLine(x1: number, y1: number, x2: number, y2: number, opacity: number): void {
    const l = document.createElementNS(SVG_NS, 'line');
    l.setAttribute('x1', String(x1));
    l.setAttribute('y1', String(y1));
    l.setAttribute('x2', String(x2));
    l.setAttribute('y2', String(y2));
    l.setAttribute('stroke', 'currentColor');
    l.setAttribute('stroke-opacity', String(opacity));
    grid.appendChild(l);
  }

  function gridLabel(text: string, lx: number, ly: number, anchor: string): void {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', String(lx));
    t.setAttribute('y', String(ly));
    t.setAttribute('font-size', '8');
    t.setAttribute('fill', 'currentColor');
    t.setAttribute('fill-opacity', '0.6');
    t.setAttribute('text-anchor', anchor);
    t.textContent = text;
    grid.appendChild(t);
  }

  function drawGrid(): void {
    grid.textContent = '';
    const lenKm = lenM / 1000;
    const kmStep = lenKm <= 12 ? 1 : lenKm <= 25 ? 2 : 5;
    for (let km = kmStep; km <= lenKm + 1e-6; km += kmStep) {
      const gx = x(km * 1000);
      gridLine(gx, PAD_T, gx, H - PAD_B, 0.12);
      gridLabel(String(km), gx, H - 4, 'middle');
    }
    const eStep = maxE <= 60 ? 20 : maxE <= 150 ? 50 : 100;
    for (let e = -Math.floor(maxE / eStep) * eStep; e <= maxE; e += eStep) {
      const gy = y(e);
      // The centre line is the start's own elevation; it reads strongest.
      gridLine(PAD_L, gy, W - PAD_R, gy, e === 0 ? 0.35 : 0.12);
      gridLabel(String(e), PAD_L - 3, gy + 2.5, 'end');
    }
  }

  function redrawPlot(): void {
    const pts: string[] = [];
    for (let i = 0; i < samples.length; i++) {
      pts.push(`${x(i * SAMPLE_STEP_M).toFixed(1)},${y(samples[i]!).toFixed(1)}`);
    }
    line.setAttribute('points', pts.join(' '));
    knob.setAttribute('cx', x(endDist()).toFixed(1));
    knob.setAttribute('cy', y(samples[samples.length - 1]!).toFixed(1));
    useButton.disabled = endDist() < 1000;
  }

  function toViewBox(e: PointerEvent): { x: number; y: number } {
    const rect = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  }

  function apply(e: PointerEvent): void {
    const p = toViewBox(e);
    const dist = Math.min(lenM, Math.max(0, ((p.x - PAD_L) / (W - PAD_L - PAD_R)) * lenM));
    const ele = Math.max(
      -maxE,
      Math.min(maxE, maxE - ((p.y - PAD_T) / (H - PAD_T - PAD_B)) * 2 * maxE),
    );
    const end = endDist();
    if (dist < end - SAMPLE_STEP_M / 2) {
      // Left of the knob erases back to the finger.
      samples.length = Math.max(1, Math.round(dist / SAMPLE_STEP_M) + 1);
      redrawPlot();
      return;
    }
    // A vertical pull still advances at least a step, so the slope cap is what
    // shapes the climb — there are no sheer walls to draw.
    const wantsClimb = Math.abs(ele - samples[samples.length - 1]!) > 1;
    const target = Math.min(lenM, Math.max(dist, end + (wantsClimb ? SAMPLE_STEP_M : 0)));
    while (endDist() + SAMPLE_STEP_M <= target + 1e-6) {
      const prev = samples[samples.length - 1]!;
      const step = Math.max(
        -MAX_GRADE * SAMPLE_STEP_M,
        Math.min(MAX_GRADE * SAMPLE_STEP_M, ele - prev),
      );
      samples.push(prev + step);
    }
    redrawPlot();
  }

  let dragging = false;
  svg.addEventListener('pointerdown', (e) => {
    const p = toViewBox(e);
    const kx = x(endDist());
    const ky = y(samples[samples.length - 1]!);
    if (Math.hypot(p.x - kx, p.y - ky) > GRAB_RADIUS) return;
    dragging = true;
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (dragging) apply(e);
  });
  const release = (): void => {
    dragging = false;
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);

  lengthSlider.addEventListener('input', () => {
    lenM = Number(lengthSlider.value) * 1000;
    lengthOut.textContent = Number(lengthSlider.value).toFixed(1);
    if (endDist() > lenM) samples.length = Math.floor(lenM / SAMPLE_STEP_M) + 1;
    drawGrid();
    redrawPlot();
  });

  elevSlider.addEventListener('input', () => {
    maxE = Number(elevSlider.value);
    elevOut.textContent = String(maxE);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.max(-maxE, Math.min(maxE, samples[i]!));
    }
    drawGrid();
    redrawPlot();
  });

  // Two light box-blur passes (±2 samples, ~250 m combined): the drawn
  // staircase becomes rolling terrain, as a real race profile would be.
  function smoothed(values: number[]): Float32Array {
    let cur = Float32Array.from(values);
    for (let pass = 0; pass < 2; pass++) {
      const next = new Float32Array(cur.length);
      for (let i = 0; i < cur.length; i++) {
        let sum = 0;
        let n = 0;
        for (let j = Math.max(0, i - 2); j <= Math.min(cur.length - 1, i + 2); j++) {
          sum += cur[j]!;
          n++;
        }
        next[i] = sum / n;
      }
      cur = next;
    }
    return cur;
  }

  useButton.addEventListener('click', () => {
    onUse(buildProfileFromSamples(smoothed(samples), endDist(), DRAWN_TURNS_PER_KM));
  });

  drawGrid();
  redrawPlot();
}
