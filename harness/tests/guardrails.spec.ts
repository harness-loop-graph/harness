import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ALLOWED_COMMAND_PREFIXES,
  PolicyGuardrails,
  splitCommandSegments,
} from '../src/index.js';

const WORKSPACE = '/tmp/harness-guardrails-workspace';

function guardrailsFor(allowedCommandPrefixes: string[] = DEFAULT_ALLOWED_COMMAND_PREFIXES) {
  return new PolicyGuardrails({
    workspaceRoot: WORKSPACE,
    allowedTools: ['run_command'],
    allowedCommandPrefixes,
    maxFileBytes: 1024,
  });
}

async function decide(command: string, allowedCommandPrefixes?: string[]) {
  return guardrailsFor(allowedCommandPrefixes).evaluate({ kind: 'command', command, cwd: WORKSPACE });
}

describe('PolicyGuardrails command segments', () => {
  describe('allowed', () => {
    it.each([
      'npm test && echo ok',
      "echo 'a && curl'",
      'echo "a ; rm -rf x"',
      'echo a\\;b',
      'FOO=1 npm test',
      'FOO=1 BAR=2',
      'npm test 2>&1 | tail -5',
      'npm test &> out.log',
      'ls > out.txt',
      'cat < in.txt',
      '> out.txt',
      'cd backend && npm install',
      'bash run.sh',
      'rm file.txt',
      'ls;',
      'ls &',
      'ls # && curl x',
      'env',
      'xargs',
      'env FOO=1 npm test',
      'xargs -n 1 -I {} echo {}',
      'ls\n\n  git status\n',
      'ls &&\n  echo ok',
    ])('allows %j', async (command) => {
      expect((await decide(command)).decision).toBe('allowed');
    });
  });

  describe('every segment is checked against the whitelist', () => {
    it('denies a non-whitelisted command after &&', async () => {
      const decision = await decide('ls && curl x', ['ls', 'echo']);
      expect(decision.decision).toBe('denied');
      expect(decision.reason).toBe("Command 'curl' is not in the allowed command prefix list");
    });

    it('denies a non-whitelisted command after a pipe', async () => {
      const decision = await decide('ls | sh', ['ls']);
      expect(decision).toEqual({
        decision: 'denied',
        reason: "Command 'sh' is not in the allowed command prefix list",
      });
    });

    it.each(['ls || curl x', 'ls ; curl x', 'ls & curl x', 'ls |& curl x', 'ls 2>&1 | curl x', "echo 'a' && curl x"])(
      'denies %j',
      async (command) => {
        const decision = await decide(command, ['ls', 'echo']);
        expect(decision.decision).toBe('denied');
        expect(decision.reason).toContain("'curl'");
      },
    );

    it('validates each newline-separated command', async () => {
      const decision = await decide('ls\ncurl x', ['ls']);
      expect(decision.decision).toBe('denied');
      expect(decision.reason).toContain("'curl'");
    });

    it('denies a quoted command word that is not whitelisted', async () => {
      expect((await decide("'curl' x", ['ls'])).decision).toBe('denied');
    });

    it('denies assignments in front of a non-whitelisted command', async () => {
      const decision = await decide('FOO=1 curl x', ['ls', 'npm']);
      expect(decision.decision).toBe('denied');
      expect(decision.reason).toContain("'curl'");
    });
  });

  describe('wrappers', () => {
    it('denies env wrapping a non-whitelisted command', async () => {
      const decision = await decide('env FOO=1 curl x', ['env', 'ls']);
      expect(decision.decision).toBe('denied');
      expect(decision.reason).toContain("'curl'");
    });

    it('denies xargs / nice / nohup / time wrapping a non-whitelisted command', async () => {
      const allowed = ['xargs', 'nice', 'nohup', 'time', 'ls'];
      for (const command of [
        'ls | xargs -n 1 curl',
        'nice -n 5 curl x',
        'nohup curl x',
        'time -p curl x',
        'nice nohup env curl x',
      ]) {
        const decision = await decide(command, [...allowed, 'env']);
        expect(decision.decision, command).toBe('denied');
        expect(decision.reason, command).toContain("'curl'");
      }
    });

    it('does not mistake a flag that takes no value for the wrapped command', async () => {
      expect((await decide('xargs -r curl', ['xargs'])).decision).toBe('denied');
    });

    it('denies env -S because the string cannot be inspected', async () => {
      expect((await decide("env -S 'curl x'")).decision).toBe('denied');
    });

    it('allows a whitelisted wrapped command', async () => {
      expect((await decide('nice -n 5 npm test', ['nice', 'npm'])).decision).toBe('allowed');
    });
  });

  describe('inline shell scripts', () => {
    it.each(["bash -c 'x'", 'bash -lc x', 'sh -ec x', 'bash -o pipefail -c x', 'env bash -c x', 'xargs sh -c x'])(
      'denies %j',
      async (command) => {
        const decision = await decide(command);
        expect(decision.decision).toBe('denied');
        expect(decision.reason).toMatch(/-c/);
      },
    );

    it('allows running a script file', async () => {
      expect((await decide('bash run.sh --color')).decision).toBe('allowed');
      expect((await decide('bash -e -o pipefail run.sh')).decision).toBe('allowed');
    });

    it.each(['sh <<< "cd x; rm -rf d"', 'echo " rm -rf d" | sh', 'cat s | bash -e', 'bash -s < s.sh', 'bash -o pipefail'])(
      'denies a shell that reads its script from stdin: %j',
      async (command) => {
        const decision = await decide(command);
        expect(decision.decision).toBe('denied');
        expect(decision.reason).toMatch(/stdin/);
      },
    );
  });

  describe('recursive/forced rm run by another command', () => {
    it.each(['find . -name x -exec rm -rf {} \\;', 'timeout 5 rm -rf d', 'echo rm -f x'])('denies %j', async (command) => {
      const decision = await decide(command, [...DEFAULT_ALLOWED_COMMAND_PREFIXES, 'timeout']);
      expect(decision.decision).toBe('denied');
      expect(decision.reason).toMatch(/rm/);
    });

    it('allows a non-recursive rm run by another command', async () => {
      expect((await decide('find . -name x -exec rm {} \\;')).decision).toBe('allowed');
    });
  });

  describe('recursive/forced rm', () => {
    it.each([
      'rm -rf d',
      'rm -fr d',
      'rm -Rf d',
      'rm -v -r d',
      'rm -f x',
      'rm d -r',
      'rm --recursive d',
      'rm --force d',
      'rm --rec d',
      'xargs rm -rf',
      'ls | xargs -n 1 rm -f',
      'ls && rm -rf d',
      'FOO=1 rm -rf d',
    ])('denies %j', async (command) => {
      const decision = await decide(command);
      expect(decision).toEqual({ decision: 'denied', reason: 'Recursive/forced rm is always denied' });
    });

    it('allows plain rm and file names that merely look like flags after --', async () => {
      expect((await decide('rm file.txt other.txt')).decision).toBe('allowed');
      expect((await decide('rm -v file.txt')).decision).toBe('allowed');
      expect((await decide('rm -- -rf')).decision).toBe('allowed');
    });
  });

  describe('fail closed', () => {
    it.each([
      ["echo 'unterminated", /unbalanced/i],
      ['echo "unterminated', /unbalanced/i],
      ['echo trailing\\', /backslash/i],
      ['cat <<EOF\nhi\nEOF', /heredoc/i],
      ['cat <<-EOF\nhi\nEOF', /heredoc/i],
      ['(cd a && ls)', /subshell|grouping/i],
      ['{ ls; }', /subshell|grouping/i],
      ['ls ;; ls', /empty/i],
      ['&& ls', /empty/i],
      ['; ls', /empty/i],
      ['ls &&', /empty/i],
      ['ls |', /empty/i],
      ['ls >', /redirection/i],
    ])('denies %j', async (command, reason) => {
      const decision = await decide(command);
      expect(decision.decision).toBe('denied');
      expect(decision.reason).toMatch(reason);
    });

    it.each([
      ['echo $(curl x)', /command substitution/i],
      ['echo "$(curl x)"', /command substitution/i],
      ['echo `curl x`', /command substitution/i],
      ['echo "`curl x`"', /command substitution/i],
      ['echo $((1 + 2))', /command substitution/i],
      ['diff <(ls a) <(ls b)', /process substitution/i],
      ['ls >(cat)', /process substitution/i],
      ['npm test && echo $(rm -rf d)', /command substitution/i],
      ['echo "$\\\n(curl x)"', /command substitution/i],
      ['echo $\\\n(curl x)', /command substitution/i],
      ['diff <\\\n(ls a)', /process substitution/i],
    ])('denies substitution %j', async (command, reason) => {
      const decision = await decide(command);
      expect(decision.decision).toBe('denied');
      expect(decision.reason).toMatch(reason);
    });

    it.each(["echo '$(curl x)'", "echo '`curl x`'", 'echo \\$\\(x\\)', 'echo "\\$(x)"', 'echo $HOME "${PWD}"'])(
      'allows literal or plain-variable text %j',
      async (command) => {
        expect((await decide(command)).decision).toBe('allowed');
      },
    );

    it('denies an empty command', async () => {
      expect(await decide('   ')).toEqual({ decision: 'denied', reason: 'Empty command' });
    });
  });

  it('records the decision in the audit log', async () => {
    const guardrails = guardrailsFor(['ls']);
    await guardrails.evaluate({ kind: 'command', command: 'ls && curl x', cwd: WORKSPACE });
    expect(guardrails.getAuditLog()).toEqual([
      { decision: 'denied', reason: "Command 'curl' is not in the allowed command prefix list" },
    ]);
  });
});

describe('splitCommandSegments', () => {
  const words = (input: string) => {
    const result = splitCommandSegments(input);
    if (!result.ok) throw new Error(result.reason);
    return result.segments.map((s) => s.words);
  };

  it('splits on every control operator', () => {
    expect(words('a && b || c ; d | e |& f & g\nh')).toEqual([
      ['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g'], ['h'],
    ]);
  });

  it('removes quotes and honours escapes', () => {
    expect(words(`echo 'a b' "c  d" e\\ f "g\\"h" i"j"k ''`)).toEqual([
      ['echo', 'a b', 'c  d', 'e f', 'g"h', 'ijk', ''],
    ]);
  });

  it('keeps operators inside quotes', () => {
    expect(words(`echo "a && b" 'c | d'`)).toEqual([['echo', 'a && b', 'c | d']]);
  });

  it('drops redirections and their targets from the words', () => {
    expect(words('npm test 2>&1 > out.log')).toEqual([['npm', 'test']]);
    expect(words('> out.txt echo hi')).toEqual([['echo', 'hi']]);
    expect(words('cmd &>log && next')).toEqual([['cmd'], ['next']]);
  });

  it('keeps a here-string target out of the words', () => {
    expect(words('cat <<< hello')).toEqual([['cat']]);
  });

  it('reports an error instead of guessing on malformed input', () => {
    expect(splitCommandSegments("echo '")).toMatchObject({ ok: false });
    expect(splitCommandSegments('cat <<EOF')).toMatchObject({ ok: false });
  });
});
