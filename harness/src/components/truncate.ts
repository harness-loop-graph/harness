const HEAD_FRACTION = 1 / 3;

function marker(removed: number): string {
  return `\n…[truncated ${removed} chars]…\n`;
}

/**
 * Shortens `text` to at most `maxChars` characters by dropping the middle.
 * Keeps ~1/3 head and ~2/3 tail (errors usually surface at the end) and
 * inserts a marker with the number of removed chars. Text within the limit
 * is returned unchanged.
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // Size the marker for the largest possible count so the result never exceeds maxChars.
  const budget = maxChars - marker(text.length).length;
  if (budget <= 0) return text.slice(-Math.max(0, maxChars));

  const head = Math.floor(budget * HEAD_FRACTION);
  const tail = budget - head;
  const removed = text.length - head - tail;
  return text.slice(0, head) + marker(removed) + text.slice(text.length - tail);
}

/**
 * Accumulates streamed output in bounded memory: keeps the first part and a
 * rolling tail, and reports the dropped middle in `toString()`.
 */
export class BoundedOutput {
  private readonly headCap: number;
  private readonly tailCap: number;
  private head = '';
  private tail = '';
  private dropped = 0;

  constructor(maxChars: number) {
    // Reserve room for the marker (newlines, ellipses, label, up to ~15 digits).
    const budget = Math.max(0, maxChars - marker(Number.MAX_SAFE_INTEGER).length);
    this.headCap = Math.floor(budget * HEAD_FRACTION);
    this.tailCap = budget - this.headCap;
  }

  append(chunk: string): void {
    let rest = chunk;
    if (this.head.length < this.headCap) {
      const take = this.headCap - this.head.length;
      this.head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (rest === '') return;

    this.tail += rest;
    if (this.tail.length > this.tailCap) {
      this.dropped += this.tail.length - this.tailCap;
      this.tail = this.tail.slice(this.tail.length - this.tailCap);
    }
  }

  toString(): string {
    return this.dropped === 0 ? this.head + this.tail : this.head + marker(this.dropped) + this.tail;
  }
}
