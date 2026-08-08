import { describe, expect, it } from 'vitest';
import { completeFlag, describeCommand, lintFfmpegArgs, tokenizeArgs } from '../src/index.ts';

const messages = (text: string, position: 'input' | 'output' = 'output') =>
  lintFfmpegArgs(text, { position }).map((f) => f.message);

describe('tokenizeArgs', () => {
  it('splits on whitespace', () => {
    expect(tokenizeArgs('-c:v libx265 -crf 22').tokens.map((t) => t.text))
      .toEqual(['-c:v', 'libx265', '-crf', '22']);
  });

  it('keeps a quoted filter graph in one piece', () => {
    // Filter graphs contain spaces and commas; splitting them would produce
    // tokens that look like flags and are not.
    const { tokens } = tokenizeArgs(`-vf "scale=1920:-2, unsharp=5:5:1.0"`);
    expect(tokens.map((t) => t.text)).toEqual(['-vf', 'scale=1920:-2, unsharp=5:5:1.0']);
    expect(tokens[1]!.quoted).toBe(true);
  });

  it('reports an unclosed quote rather than guessing', () => {
    expect(tokenizeArgs('-vf "scale=1920:-2').error).toMatch(/unclosed double quote/);
    expect(tokenizeArgs("-metadata title='x").error).toMatch(/unclosed single quote/);
  });

  it('records where each token started', () => {
    expect(tokenizeArgs('  -crf 22').tokens[0]).toMatchObject({ text: '-crf', start: 2 });
  });
});

describe('lintFfmpegArgs', () => {
  it('passes ordinary arguments', () => {
    expect(messages('-c:v libx265 -crf 22 -preset slow')).toEqual([]);
  });

  it('rejects an unclosed quote outright', () => {
    const findings = lintFfmpegArgs('-vf "scale=1920', { position: 'output' });
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.message).toMatch(/not safe to run/);
  });

  it('rejects flags the surrounding command owns', () => {
    // Valid ffmpeg, wrong here: Tdarr supplies the input itself.
    expect(messages('-i /mnt/media/in.mkv')).toContainEqual(
      expect.stringMatching(/Tdarr supplies the input file/),
    );
    expect(messages('-y -c:v copy')).toContainEqual(expect.stringMatching(/Tdarr decides whether/));
  });

  it('catches a stray output filename', () => {
    expect(messages('-c:v libx265 out.mkv')).toContainEqual(
      expect.stringMatching(/looks like a file path/),
    );
  });

  it('does not mistake a flag value for a filename', () => {
    // `-vf` legitimately takes something ending in what looks like an extension.
    expect(messages('-i2 x -vf subtitles=sub.srt')).not.toContainEqual(
      expect.stringMatching(/looks like a file path/),
    );
  });

  it('flags an option used on the wrong side of the input', () => {
    expect(messages('-hwaccel cuda', 'output')).toContainEqual(
      expect.stringMatching(/is an input option, and this is the output field/),
    );
    expect(messages('-crf 22', 'input')).toContainEqual(
      expect.stringMatching(/is an output option, and this is the input field/),
    );
  });

  it('accepts an option valid on both sides', () => {
    expect(messages('-loglevel error', 'input')).toEqual([]);
    expect(messages('-loglevel error', 'output')).toEqual([]);
  });

  it('notices a flag with no value', () => {
    expect(messages('-crf')).toContainEqual(expect.stringMatching(/needs a value after it/));
    expect(messages('-crf -preset slow')).toContainEqual(
      expect.stringMatching(/-crf needs a value/),
    );
  });

  it('allows bare switches to stand alone', () => {
    expect(messages('-sn -dn')).toEqual([]);
  });

  it('warns about a repeated flag, since only the last one counts', () => {
    expect(messages('-crf 22 -crf 18')).toContainEqual(
      expect.stringMatching(/appears more than once/),
    );
  });

  it('warns when an argument overrides a control in the form above', () => {
    const findings = lintFfmpegArgs('-c:v libx264', { position: 'output', managed: ['-c:v'] });
    expect(findings[0]!.message).toMatch(/already set by the options above/);
    // A warning, not an error: overriding is a legitimate thing to want.
    expect(findings[0]!.severity).toBe('warning');
  });

  it('treats an unknown flag as merely unknown', () => {
    // The catalogue is a convenience, not an authority on what ffmpeg accepts.
    const findings = lintFfmpegArgs('-nonsense 1', { position: 'output' });
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.message).toMatch(/not one of the flags this editor knows/);
  });

  it('says nothing about an empty field', () => {
    expect(messages('')).toEqual([]);
    expect(messages('   ')).toEqual([]);
  });
});

describe('completeFlag', () => {
  it('offers only flags valid for the field being edited', () => {
    const output = completeFlag('-c', 'output').map((f) => f.flag);
    expect(output).toContain('-c:v');
    expect(output).not.toContain('-hwaccel');

    expect(completeFlag('-hw', 'input').map((f) => f.flag)).toContain('-hwaccel');
  });

  it('includes flags valid on both sides', () => {
    expect(completeFlag('-log', 'input').map((f) => f.flag)).toContain('-loglevel');
    expect(completeFlag('-log', 'output').map((f) => f.flag)).toContain('-loglevel');
  });

  it('returns the whole set for the field when nothing is typed', () => {
    expect(completeFlag('', 'output').length).toBeGreaterThan(10);
  });

  it('carries example values for the flags that have them', () => {
    expect(completeFlag('-c:v', 'output')[0]!.values).toContain('hevc_nvenc');
  });
});

describe('describeCommand', () => {
  const text = (parts: ReturnType<typeof describeCommand>) => parts.map((p) => p.text).join(' ');

  it('puts input arguments before -i and output arguments after', () => {
    const parts = describeCommand({ input: '-hwaccel cuda', output: '-c:v hevc_nvenc' });
    expect(text(parts)).toBe(
      'ffmpeg -hwaccel cuda -i input file options from this step -c:v hevc_nvenc output file',
    );
  });

  it('shows the shape even when nothing is typed', () => {
    expect(text(describeCommand(undefined)))
      .toBe('ffmpeg -i input file options from this step output file');
  });

  it('marks what the user wrote apart from what is filled in', () => {
    const parts = describeCommand({ output: '-crf 22' });
    expect(parts.find((p) => p.kind === 'custom')?.text).toBe('-crf 22');
    // The generated options are a placeholder, not a guess presented as fact:
    // Tdarr builds them at run time from the file it is actually looking at.
    expect(parts.some((p) => p.kind === 'generated')).toBe(true);
  });

  it('takes a label for the generated section', () => {
    expect(text(describeCommand({}, { generatedLabel: 'audio options' })))
      .toContain('audio options');
  });
});
