/** One simple command of a command line: its words (quotes removed) and whether it has redirections. */
export interface CommandSegment {
  /** Words of the segment. Redirection operators and their targets are not included. */
  words: string[];
  /** True when the segment contains at least one redirection (`>`, `2>&1`, `<`, ...). */
  hasRedirection: boolean;
}

export type CommandSegmentsResult =
  | { ok: true; segments: CommandSegment[] }
  | { ok: false; reason: string };

/** Redirection operators, longest first so `>>` wins over `>`. `<<` and `<<<` are handled separately. */
const REDIRECTION_OPERATOR = /&>>|&>|>>|>&|>\||<&|<>|>|</y;

/**
 * Split a shell command line into segments on the control operators
 * `&&`, `||`, `;`, `|`, `|&`, `&` and newlines. Quote-aware: single quotes,
 * double quotes and backslash escapes keep operators inside a word.
 *
 * Fails closed (`ok: false`) on anything that cannot be inspected statically:
 * unbalanced quotes, a trailing backslash, heredocs and subshell/grouping
 * parentheses. Empty segments (`a ;; b`, a leading `&&`) are returned as
 * segments without words so the caller can reject them; only a single trailing
 * `;`, `&` or newline is dropped.
 *
 * Command substitution (`$(...)`, `$((...))`, backticks) outside single quotes
 * and process substitution (`<(`, `>(`) are denied: they run commands hidden
 * inside a word. Plain variables (`$HOME`, `${PWD}`) are allowed.
 */
export function splitCommandSegments(input: string): CommandSegmentsResult {
  const segments: CommandSegment[] = [];
  let words: string[] = [];
  let hasRedirection = false;
  let word = '';
  let inWord = false; // true once a word started, even an empty one such as ''
  let skipNextWord = false; // the next word is a redirection target
  let lastSeparator = '';

  const endWord = (): void => {
    if (!inWord) return;
    if (skipNextWord) skipNextWord = false;
    else words.push(word);
    word = '';
    inWord = false;
  };
  const isEmptySegment = (): boolean => words.length === 0 && !hasRedirection && !skipNextWord && !inWord;
  const endSegment = (separator: string): string | null => {
    endWord();
    if (skipNextWord) return 'Redirection without a target';
    segments.push({ words, hasRedirection });
    words = [];
    hasRedirection = false;
    lastSeparator = separator;
    return null;
  };
  const fail = (reason: string): CommandSegmentsResult => ({ ok: false, reason });
  const commandSubstitution = (at: number): boolean =>
    input[at] === '`' || (input[at] === '$' && input[at + 1] === '(');
  const COMMAND_SUBSTITUTION_DENIED = 'Command substitution ($(...) or backticks) cannot be inspected and is denied';

  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (commandSubstitution(i)) return fail(COMMAND_SUBSTITUTION_DENIED);
    if ((ch === '<' || ch === '>') && input[i + 1] === '(') {
      return fail('Process substitution (<(...) or >(...)) cannot be inspected and is denied');
    }
    if (ch === '\\') {
      if (i + 1 >= input.length) return fail('Command ends with a trailing backslash');
      if (input[i + 1] !== '\n') {
        word += input[i + 1];
        inWord = true;
      }
      i += 2;
    } else if (ch === "'") {
      const close = input.indexOf("'", i + 1);
      if (close === -1) return fail('Command has an unbalanced single quote');
      word += input.slice(i + 1, close);
      inWord = true;
      i = close + 1;
    } else if (ch === '"') {
      i++;
      for (;;) {
        if (i >= input.length) return fail('Command has an unbalanced double quote');
        const c = input[i];
        if (c === '"') break;
        if (commandSubstitution(i)) return fail(COMMAND_SUBSTITUTION_DENIED);
        if (c === '\\' && i + 1 < input.length && '$`"\\\n'.includes(input[i + 1])) {
          if (input[i + 1] !== '\n') word += input[i + 1];
          i += 2;
        } else {
          word += c;
          i++;
        }
      }
      inWord = true;
      i++;
    } else if (ch === ' ' || ch === '\t') {
      endWord();
      i++;
    } else if (ch === '\n') {
      endWord();
      if (!isEmptySegment()) {
        const error = endSegment('\n');
        if (error) return fail(error);
      }
      i++;
    } else if (ch === '#' && !inWord) {
      while (i < input.length && input[i] !== '\n') i++;
    } else if (ch === '<' || ch === '>' || (ch === '&' && input[i + 1] === '>')) {
      // A bare number right before the operator is the file descriptor (`2>&1`), not a word.
      if (inWord && /^[0-9]+$/.test(word)) {
        word = '';
        inWord = false;
      } else {
        endWord();
      }
      if (input.startsWith('<<<', i)) {
        i += 3;
      } else if (input.startsWith('<<', i)) {
        return fail('Heredocs cannot be inspected and are denied');
      } else {
        REDIRECTION_OPERATOR.lastIndex = i;
        i += REDIRECTION_OPERATOR.exec(input)![0].length;
      }
      hasRedirection = true;
      skipNextWord = true;
    } else if (ch === ';' || ch === '|' || ch === '&') {
      const pair = input.slice(i, i + 2);
      const operator = pair === '&&' || pair === '||' || pair === '|&' ? pair : ch;
      const error = endSegment(operator);
      if (error) return fail(error);
      i += operator.length;
    } else if (ch === '(' || ch === ')') {
      return fail('Subshells and command grouping are not allowed');
    } else {
      word += ch;
      inWord = true;
      i++;
    }
  }

  endWord();
  if (skipNextWord) return fail('Redirection without a target');
  // A single trailing `;`, `&` or newline is fine; a dangling `&&` / `|` leaves an empty segment to reject.
  const dangling = isEmptySegment() && (lastSeparator === '' || ';&\n'.includes(lastSeparator));
  if (!dangling) segments.push({ words, hasRedirection });
  return { ok: true, segments };
}
