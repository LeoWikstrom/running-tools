import { validateTour, type Tour } from '@running/core/tour/types';
import {
  audioFilename,
  deleteTour,
  getTourJson,
  listTours,
  native,
  playFile,
  saveTourToPhone,
  startRun,
  stopPlayback,
  synthesize,
} from './native';

export interface ShelfHandle {
  refresh(): void;
  /** Kick off audio generation for one stored tour, as its button would. */
  generate(id: string): void;
}

/** The "on this phone" section: saved tours, audio generation, clip preview. */
export function initShelf(
  container: HTMLElement,
  openTour: (tour: Tour) => void,
  setStatus: (text: string) => void,
  onRunStarted?: () => void,
): ShelfHandle {
  if (!native) {
    container.hidden = true;
    return { refresh: () => {}, generate: () => {} };
  }

  /** The audio buttons' click actions by tour id, for generate(). */
  const generators = new Map<string, () => void>();

  function generateAudio(id: string, progress: HTMLProgressElement): Promise<void> {
    return (async () => {
      const tour = validateTour(JSON.parse(getTourJson(id)));
      const withText = tour.places.filter((p) => p.text.length > 0);
      if (withText.length === 0) {
        setStatus('No texts in this tour yet — fetch texts first.');
        return;
      }
      progress.hidden = false;
      progress.max = withText.length;
      let done = 0;
      for (const p of withText) {
        const filename = audioFilename(p.id);
        await synthesize(id, filename, p.text, tour.lang);
        p.audio = filename;
        done++;
        progress.value = done;
        setStatus(`Synthesising ${done}/${withText.length}…`);
      }
      saveTourToPhone(JSON.stringify(tour));
      setStatus(`Audio ready for ${done} places.`);
    })();
  }

  function renderPlaces(tour: Tour, into: HTMLElement): void {
    into.innerHTML = '';
    for (const p of tour.places) {
      const row = document.createElement('div');
      row.className = 'shelf-place';
      const label = document.createElement('span');
      label.textContent = `${(p.d / 1000).toFixed(2)} km — ${p.name}`;
      row.appendChild(label);
      if (p.audio) {
        const play = document.createElement('button');
        play.textContent = '▶';
        play.title = `Play the clip for ${p.name}`;
        play.addEventListener('click', () => {
          stopPlayback();
          if (!playFile(tour.id, p.audio!)) setStatus(`Audio file missing for ${p.name}.`);
        });
        row.appendChild(play);
      }
      into.appendChild(row);
    }
  }

  function refresh(): void {
    container.innerHTML = '';
    generators.clear();
    const tours = listTours();
    container.hidden = false;
    const heading = document.createElement('h2');
    heading.textContent = 'On this phone';
    container.appendChild(heading);
    if (tours.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No tours stored yet. Prepare one and press “Save to phone”.';
      container.appendChild(p);
      return;
    }
    for (const info of tours) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${info.name} — ${info.places} places, audio ${info.audio}/${info.places}`;
      const body = document.createElement('div');

      const row = document.createElement('div');
      row.className = 'row wrap';
      const run = document.createElement('button');
      run.textContent = 'Start run';
      run.className = 'start-run';
      run.addEventListener('click', () => {
        startRun(info.id);
        onRunStarted?.();
      });
      row.appendChild(run);
      const open = document.createElement('button');
      open.textContent = 'Open';
      open.addEventListener('click', () => {
        try {
          openTour(validateTour(JSON.parse(getTourJson(info.id))));
        } catch (err) {
          setStatus(err instanceof Error ? err.message : String(err));
        }
      });
      // No button: audio generates by itself after Save to phone.
      const progress = document.createElement('progress');
      progress.hidden = true;
      let generating = false;
      const runGeneration = (): void => {
        if (generating) return;
        generating = true;
        void generateAudio(info.id, progress)
          .catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err)))
          .finally(() => {
            generating = false;
            refresh();
          });
      };
      generators.set(info.id, runGeneration);
      const rename = document.createElement('button');
      rename.textContent = 'Rename';
      rename.addEventListener('click', () => {
        const name = prompt('New name for the tour', info.name)?.trim();
        if (!name) return;
        try {
          const tour = validateTour(JSON.parse(getTourJson(info.id)));
          tour.name = name;
          saveTourToPhone(JSON.stringify(tour));
          refresh();
        } catch (err) {
          setStatus(err instanceof Error ? err.message : String(err));
        }
      });
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.addEventListener('click', () => {
        if (!confirm(`Delete the tour “${info.name}” and its audio?`)) return;
        deleteTour(info.id);
        refresh();
      });
      row.append(open, rename, del);
      body.append(row, progress);

      const placesBox = document.createElement('div');
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        try {
          renderPlaces(validateTour(JSON.parse(getTourJson(info.id))), placesBox);
        } catch {
          placesBox.textContent = 'Could not read this tour.';
        }
      });
      body.appendChild(placesBox);
      details.append(summary, body);
      container.appendChild(details);
    }
  }

  refresh();
  return {
    refresh,
    generate(id: string): void {
      generators.get(id)?.();
    },
  };
}
