/**
 * Incremental scanner for an Overpass JSON response: emits each element of
 * the top-level `elements` array as soon as its closing brace has arrived,
 * so a caller can use the first lines of a big answer while the rest is
 * still downloading. Overpass computes the whole result before sending the
 * first byte, but the body itself streams — and it streams in output-
 * statement order, so a query that prints relations, then nodes, then ways
 * hands the caller a usable line list long before the geometry lands.
 *
 * The scanner is a character state machine, not a JSON parser: it only
 * tracks strings (with escapes) and brace depth, and hands each complete
 * element substring to JSON.parse. Anything malformed surfaces there.
 */
export interface ElementScanner {
  push(chunk: string): void;
}

export function createElementScanner(
  onElement: (el: Record<string, unknown>) => void,
): ElementScanner {
  // Phase 0: looking for the `"elements"` key; 1: looking for its `[`;
  // 2: inside the array, collecting elements; 3: done.
  let phase = 0;
  let head = '';
  let element = '';
  let depth = 0;
  let inString = false;
  let escaped = false;

  const scanArray = (chunk: string, from: number): void => {
    for (let i = from; i < chunk.length; i++) {
      const c = chunk[i]!;
      if (depth > 0) element += c;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
      } else if (c === '{') {
        if (depth === 0) element = '{';
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          onElement(JSON.parse(element) as Record<string, unknown>);
          element = '';
        }
      } else if (c === ']' && depth === 0) {
        phase = 3;
        return;
      }
    }
  };

  return {
    push(chunk: string): void {
      if (phase === 3) return;
      if (phase === 2) {
        scanArray(chunk, 0);
        return;
      }
      head += chunk;
      if (phase === 0) {
        const at = head.indexOf('"elements"');
        if (at < 0) {
          // Keep only a tail that could still hold a split key.
          head = head.slice(-12);
          return;
        }
        head = head.slice(at + '"elements"'.length);
        phase = 1;
      }
      const bracket = head.indexOf('[');
      if (bracket < 0) return;
      phase = 2;
      const rest = head;
      head = '';
      scanArray(rest, bracket + 1);
    },
  };
}
