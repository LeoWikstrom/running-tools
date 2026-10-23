import { openDialog } from './dialog';

/**
 * What each weight is for, shown by the ⓘ beside it — as a hover tooltip on
 * desktop and as a dialog on tap, since a finger has no hover.
 */
export const WEIGHT_INFO: Record<string, { name: string; text: string }> = {
  localShape: {
    name: 'Local shape',
    text:
      'How closely the course follows the race profile stretch by stretch, over every ' +
      '500 m window. This is the "same feel underfoot" term: it keeps the course flat ' +
      'where the race is flat and climbing where it climbs, and deliberately outranks ' +
      'matching the totals — a sawtooth of small hills can fake the right total gain ' +
      'while feeling nothing like one long climb.',
  },
  gainLoss: {
    name: 'Total gain/loss',
    text:
      'How closely the course matches the race\u2019s total climb and total descent. ' +
      'Kept below Local shape on purpose: totals can be manufactured with the wrong ' +
      'hills, and elevation data is noisy enough that chasing them too hard distorts ' +
      'the course.',
  },
  turns: {
    name: 'Turns',
    text:
      'Keeps the number of turns per km close to the race\u2019s, and separately ' +
      'penalises turns in quick succession (closer than 100 m), which break running ' +
      'rhythm. Set to 0 to ignore turning entirely.',
  },
  surface: {
    name: 'Surface',
    text:
      'Ground that differs from the chosen surface preset. Asphalt and firm gravel ' +
      'count as nearly the same thing — for a runner they are — while trail is a real ' +
      'difference in both directions.',
  },
  penalty: {
    name: 'Safety',
    text:
      'Tagged unpleasantness and risk: busy roads without sidewalks, steps, crossings ' +
      'and similar. Higher values keep the course on calmer ways at some cost to the ' +
      'profile match.',
  },
  oscillation: {
    name: 'Repeats',
    text:
      'Ground covered more than once — bouncing back and forth, tight circles, and ' +
      'laps that come back round even on a parallel path. Without this a course could ' +
      're-climb the same hill to fake the race\u2019s gain. Also scales the related ' +
      'terms for far-apart laps and for never leaving the neighbourhood, so 0 turns ' +
      'repeated ground into free distance.',
  },
  trafficLights: {
    name: 'Avoid traffic lights',
    text:
      'Charges the course for every signalised crossing it meets, so a higher ' +
      'weight means fewer traffic lights on the course. 0 ignores them entirely; ' +
      'raise it if standing at red lights ruins a training run for you.',
  },
  untracked: {
    name: 'Unrun ground',
    text:
      'Ground no downloaded GPS trace covers at a running pace, charged only while ' +
      'the checkbox is on. Download GPS traces first (Offline areas → GPS traces): ' +
      'without a download everything counts as unrun and the weight has nothing to ' +
      'prefer. Benchmarks say keep this a tie-breaker: much above 10 and courses ' +
      'start lapping the few paths the traces cover.',
  },
};

/**
 * Each weight is a small number box and a slider showing the same value. The
 * slider spans the sensible range; the box accepts more, and the slider then
 * just sits at its end.
 */
export function initWeightControls(): void {
  for (const row of document.querySelectorAll<HTMLElement>('.weight')) {
    const box = row.querySelector<HTMLInputElement>('input[type="number"]');
    const slider = row.querySelector<HTMLInputElement>('input[type="range"]');
    if (!box || !slider) continue;
    slider.addEventListener('input', () => {
      box.value = slider.value;
    });
    box.addEventListener('input', () => {
      slider.value = box.value;
    });
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('.info-button')) {
    const info = WEIGHT_INFO[b.dataset.weight ?? ''];
    if (!info) continue;
    b.title = info.text;
    b.addEventListener('click', () => {
      const p = document.createElement('p');
      p.textContent = info.text;
      openDialog(info.name, p);
    });
  }
}
