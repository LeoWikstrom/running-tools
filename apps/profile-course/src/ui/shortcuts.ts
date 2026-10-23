/**
 * One list, rendered twice: the ? overlay a desktop user calls up, and a
 * section of Advanced settings — on a phone there is no keyboard to press ?
 * with, so the panel is the only place the list can be read.
 */
export const SHORTCUTS: [key: string, what: string][] = [
  ['Enter', 'Find course'],
  ['T', 'Try another (next seed)'],
  ['G', 'Download the shown course as GPX'],
  ['E', 'Editing mode on or off'],
  ['N', 'Node submode while editing'],
  ['V', 'Add a via point'],
  ['Ctrl/⌘ Z', 'Undo the last edit (while editing)'],
  ['Del', 'Delete the marked nodes'],
  ['Esc', 'Back out one step'],
  ['1–9', 'Show that course'],
  ['← →', 'Walk the course tabs'],
  ['?', 'This list'],
];

export function renderShortcuts(into: HTMLElement): void {
  into.replaceChildren();
  for (const [key, what] of SHORTCUTS) {
    const dt = document.createElement('dt');
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    dt.append(kbd);
    const dd = document.createElement('dd');
    dd.textContent = what;
    into.append(dt, dd);
  }
}

/** The same list as a node for the dialog. */
export function shortcutsContent(): HTMLElement {
  const dl = document.createElement('dl');
  dl.className = 'shortcuts';
  renderShortcuts(dl);
  return dl;
}
