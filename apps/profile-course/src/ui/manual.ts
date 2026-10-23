/**
 * The manual the Documentation button opens. Plain data so the structure stays
 * readable; rendered to DOM nodes, never HTML strings.
 */
const SECTIONS: [heading: string, ...paragraphs: string[]][] = [
  [
    'What this app does',
    'Upload the GPX of a race, pick where you want to train, and the app searches the ' +
      'real path network for a runnable course whose elevation profile matches the race — ' +
      'so the long climb at km 7 of the race is a long climb at km 7 of your training run.',
    'Everything runs in your browser. The only servers involved hand out map data, and ' +
      'what you download is cached on the device, so a saved area works offline.',
  ],
  [
    'Getting started',
    '1. Upload a race GPX. Its elevation profile appears in the chart.',
    '2. Tap the map where you want to start. The circle is your start/finish zone — the ' +
      'course must start and end inside it, but may leave it in between.',
    '3. Press Find course. The best match is drawn on the map and overlaid on the chart; ' +
      'up to four alternatives appear as tabs at the top of the screen.',
    'The mismatch number scores how far the course is from the race profile — lower is ' +
      'better, and it is only comparable between courses scored with the same weights.',
  ],
  [
    'The map',
    'Tap to set the start marker, or enter exact coordinates under Advanced settings. ' +
      'The buttons on the right edge below the zoom control act on the shown course: ' +
      'edit it (✎), copy a shareable link (🔗), or search again with a fresh seed (🎲).',
    'With a mouse, hovering near the course shows distance, height and gradient at that ' +
      'point, and moves the crosshair in the chart; hovering the chart marks the map. ' +
      'A hill can be found from either side.',
  ],
  [
    'Course settings',
    'Start/finish zone: how far from the marker the course may start and finish — not a ' +
      'limit on where it goes in between. With "start anywhere in the zone" off, the ' +
      'course starts at the marker itself.',
    'Return to start makes the finish the start. Course distance overrides the race ' +
      'distance, scaling the profile to match. Surface picks what the course should run ' +
      'on: road (paved or firm gravel), gravel, trail, or anything.',
  ],
  [
    'Match race section',
    'The two sliders under the chart pick which part of the race to match — the first ' +
      '10 km, the final hill, anything in between. The course is then matched against ' +
      'that slice only.',
  ],
  [
    'Via points',
    'Add via point, then tap the map: the course must pass there, in list order. Each ' +
      'via can be pinned to a km of the course, with an adjustable ± window, or left ' +
      'unpinned — then it is simply visited somewhere between its neighbours in the ' +
      'list, and its ↑/↓ buttons say which neighbours. While placing one, you can also ' +
      'pick its distance by pressing on the chart and letting go.',
  ],
  [
    'Courses and tabs',
    'A search offers up to four genuinely different courses as tabs at the top, each ' +
      'labelled with its mismatch. Tap a tab, press its number, or walk them with the ' +
      'arrow keys. Each tab remembers its own course, including edits.',
    'Try another (🎲) re-runs the search with a fresh seed. The seed is visible in ' +
      'Advanced settings, so a course can be reproduced: the same seed and settings ' +
      'always find the same course.',
  ],
  [
    'Editing a course',
    'Editing (✎) is a mode: pull the course where you want it, or tap a point on the ' +
      'course and then its destination, as many times as you like. Each edit replaces a ' +
      'stretch around the point you took hold of — the window size is under Advanced ' +
      'settings, and a mouse wheel resizes it mid-pull. The rest of the course does not ' +
      'move. Undo (↶ or Ctrl+Z) steps back; Esc backs out one level at a time.',
    'Where the course passes the same spot twice, hold the point: it offers each pass ' +
      'in turn, and the pull or release takes the one last offered. You can also pick ' +
      'the exact distance to edit at by scrubbing the chart and letting go.',
    'Edits reroute along real paths and respect via points — the course is pulled, ' +
      'never redrawn freehand.',
  ],
  [
    'Node editing',
    'The Nodes button inside editing treats the course as waypoints and ignores the ' +
      'score entirely: every junction is a dot. Pull a dot to move it, tap one to ' +
      'delete it, tap or pull the course between dots to add one. Hold a dot to mark ' +
      'it red — mark several and Delete removes them in one edit, rerouting around all ' +
      'of them at once.',
  ],
  [
    'Your own course',
    'Upload a course of your own under Advanced settings and it is matched to the path ' +
      'network and scored exactly like a generated one — then edit it, or press ↻ to ' +
      'let the search improve it.',
    'You can also draw the race profile you want instead of uploading one: set the ' +
      'length and elevation range with the sliders, pull the knob right to draw and ' +
      'left to erase (climbs are capped at 20 %), and press Use as input. The drawing ' +
      'then stands in for the race GPX.',
  ],
  [
    'Offline areas',
    'Download area around start saves the path network within the chosen radius on ' +
      'your device. Searches inside a saved area skip the public Overpass servers ' +
      'entirely — faster, and it works with no connection. Elevation tiles are cached ' +
      'as they are used.',
  ],
  [
    'GPS traces',
    'Downloads public GPS traces from OpenStreetMap around the start and keeps only ' +
      'points recorded at a running pace (3–11 min/km), so cars, bikes and walks drop ' +
      'out. This is slow — the API hands out 5 000 points at a time — and cancelling ' +
      'saves nothing.',
    'The "prefer paths people actually run" weight then charges ground no kept trace ' +
      'covers. Everything outside a download counts as unrun, so the option only makes ' +
      'sense where you have downloaded traces.',
  ],
  [
    'Weights',
    'The weights decide what the search cares about; each has an ⓘ explaining it. ' +
      'They are for experimenting — the defaults are tuned so that local profile ' +
      'similarity outranks everything else. Note that changing weights changes what ' +
      'the mismatch number means: only compare mismatches produced with the same ' +
      'weights.',
  ],
  [
    'Sharing and persistence',
    'Copy link (🔗) encodes everything that decides the result into the address bar: ' +
      'the start, zone, distance and race window, surface, seed, search effort, all the ' +
      'weights, via points and the advanced toggles. A simple link spells its settings ' +
      'out readably; one with many edits is packed into a short code instead. Opening ' +
      'the link runs the same search and finds the same first course — with three caveats.',
    'The race itself is not in the link: whoever opens it must load the same GPX (or ' +
      'drawn profile) first. The map data must match too — searches run on the ' +
      'network your device has downloaded or cached, and OpenStreetMap itself changes ' +
      'over time, so an old link may find a slightly different course on newer data. ' +
      'And GPS trace downloads are per device, so with the unrun-ground weight on, the ' +
      'result also depends on which traces the opening device holds.',
    'The link does not carry which tab was selected or any hand edits made after the ' +
      'search. Everything you do is also saved on the device: closing or reloading the ' +
      'tab brings back the race, the settings, every course tab and your edits.',
  ],
];

export function manualContent(): HTMLElement {
  const root = document.createElement('div');
  for (const [heading, ...paragraphs] of SECTIONS) {
    const h = document.createElement('h3');
    h.textContent = heading;
    root.appendChild(h);
    for (const text of paragraphs) {
      const p = document.createElement('p');
      p.textContent = text;
      root.appendChild(p);
    }
  }
  return root;
}
