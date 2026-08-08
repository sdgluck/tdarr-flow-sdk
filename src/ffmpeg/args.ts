/**
 * Custom ffmpeg arguments: parsing, a flag catalogue for completion, and linting.
 *
 * `ffmpegCommandCustomArguments` takes two strings - arguments before the input
 * and arguments after it - and splices them into the command Tdarr is already
 * assembling. That framing is the whole reason this file exists: the mistakes
 * worth catching are not "is this valid ffmpeg" but "is this something the
 * surrounding command already does, or is about to undo".
 *
 * Passing `-i` is the clearest example. It is perfectly good ffmpeg and
 * completely wrong here, because Tdarr supplies the input itself - the result is
 * two inputs and a command that does something nobody asked for. A syntax
 * checker would wave it through.
 */

export type ArgPosition = 'input' | 'output';

export interface FfmpegFlag {
  flag: string;
  /** Where it belongs. `both` is rare but real (`-loglevel`). */
  position: ArgPosition | 'both';
  /** What the flag takes, for completion hints. `none` is a bare switch. */
  takes: 'none' | 'value';
  description: string;
  /** Common values, offered after the flag is typed. */
  values?: string[];
}

/**
 * Not exhaustive - ffmpeg has hundreds - but the ones people reach for when
 * hand-tuning a Tdarr flow. An unknown flag is a warning, never an error,
 * precisely because this list cannot be complete.
 */
export const FFMPEG_FLAGS: readonly FfmpegFlag[] = [
  // --- input side ---
  { flag: '-ss', position: 'input', takes: 'value', description: 'Seek to a timestamp before decoding' },
  { flag: '-t', position: 'input', takes: 'value', description: 'Limit the duration read' },
  { flag: '-hwaccel', position: 'input', takes: 'value', description: 'Hardware decoder', values: ['auto', 'cuda', 'qsv', 'vaapi', 'videotoolbox', 'd3d11va'] },
  { flag: '-hwaccel_output_format', position: 'input', takes: 'value', description: 'Keep decoded frames on the GPU', values: ['cuda', 'qsv', 'vaapi'] },
  { flag: '-init_hw_device', position: 'input', takes: 'value', description: 'Initialise a hardware device' },
  { flag: '-fflags', position: 'input', takes: 'value', description: 'Format flags', values: ['+genpts', '+igndts', '+discardcorrupt'] },
  { flag: '-analyzeduration', position: 'input', takes: 'value', description: 'How long to probe the input' },
  { flag: '-probesize', position: 'input', takes: 'value', description: 'How many bytes to probe' },
  { flag: '-r', position: 'both', takes: 'value', description: 'Frame rate' },
  { flag: '-loglevel', position: 'both', takes: 'value', description: 'Logging verbosity', values: ['quiet', 'error', 'warning', 'info', 'verbose', 'debug'] },

  // --- output side: video ---
  { flag: '-c:v', position: 'output', takes: 'value', description: 'Video codec', values: ['copy', 'libx264', 'libx265', 'libsvtav1', 'hevc_nvenc', 'h264_nvenc', 'av1_nvenc', 'hevc_qsv', 'h264_qsv', 'hevc_vaapi', 'hevc_videotoolbox'] },
  { flag: '-crf', position: 'output', takes: 'value', description: 'Constant rate factor - lower is better quality' },
  { flag: '-cq', position: 'output', takes: 'value', description: 'Constant quality (NVENC)' },
  { flag: '-qp', position: 'output', takes: 'value', description: 'Constant quantiser' },
  { flag: '-preset', position: 'output', takes: 'value', description: 'Encoder speed/quality trade-off', values: ['ultrafast', 'veryfast', 'fast', 'medium', 'slow', 'slower', 'veryslow', 'p1', 'p4', 'p7'] },
  { flag: '-tune', position: 'output', takes: 'value', description: 'Encoder tuning', values: ['film', 'animation', 'grain', 'fastdecode', 'zerolatency'] },
  { flag: '-profile:v', position: 'output', takes: 'value', description: 'Video profile', values: ['main', 'main10', 'high'] },
  { flag: '-level', position: 'output', takes: 'value', description: 'Codec level' },
  { flag: '-pix_fmt', position: 'output', takes: 'value', description: 'Pixel format', values: ['yuv420p', 'yuv420p10le', 'p010le', 'nv12'] },
  { flag: '-b:v', position: 'output', takes: 'value', description: 'Video bitrate' },
  { flag: '-maxrate', position: 'output', takes: 'value', description: 'Peak bitrate' },
  { flag: '-bufsize', position: 'output', takes: 'value', description: 'Rate-control buffer size' },
  { flag: '-g', position: 'output', takes: 'value', description: 'Keyframe interval' },
  { flag: '-vf', position: 'output', takes: 'value', description: 'Video filter chain' },
  { flag: '-filter:v', position: 'output', takes: 'value', description: 'Video filter chain' },
  { flag: '-s', position: 'output', takes: 'value', description: 'Output resolution' },
  { flag: '-aspect', position: 'output', takes: 'value', description: 'Display aspect ratio' },

  // --- output side: audio ---
  { flag: '-c:a', position: 'output', takes: 'value', description: 'Audio codec', values: ['copy', 'aac', 'ac3', 'eac3', 'libopus', 'flac', 'libmp3lame'] },
  { flag: '-b:a', position: 'output', takes: 'value', description: 'Audio bitrate' },
  { flag: '-ac', position: 'output', takes: 'value', description: 'Audio channel count' },
  { flag: '-ar', position: 'output', takes: 'value', description: 'Audio sample rate' },
  { flag: '-af', position: 'output', takes: 'value', description: 'Audio filter chain' },

  // --- output side: subtitles, mapping, metadata ---
  { flag: '-c:s', position: 'output', takes: 'value', description: 'Subtitle codec', values: ['copy', 'srt', 'mov_text', 'ass'] },
  { flag: '-map', position: 'output', takes: 'value', description: 'Select a stream' },
  { flag: '-map_metadata', position: 'output', takes: 'value', description: 'Copy metadata from an input' },
  { flag: '-metadata', position: 'output', takes: 'value', description: 'Set a metadata tag' },
  { flag: '-disposition:s:0', position: 'output', takes: 'value', description: 'Stream disposition' },
  { flag: '-movflags', position: 'output', takes: 'value', description: 'MP4 muxer flags', values: ['+faststart'] },
  { flag: '-max_muxing_queue_size', position: 'output', takes: 'value', description: 'Muxer queue size - raise it when ffmpeg complains' },
  { flag: '-shortest', position: 'output', takes: 'none', description: 'Stop at the shortest stream' },
  { flag: '-sn', position: 'output', takes: 'none', description: 'Drop all subtitles' },
  { flag: '-an', position: 'output', takes: 'none', description: 'Drop all audio' },
  { flag: '-vn', position: 'output', takes: 'none', description: 'Drop all video' },
  { flag: '-dn', position: 'output', takes: 'none', description: 'Drop all data streams' },
];

const FLAG_BY_NAME = new Map(FFMPEG_FLAGS.map((entry) => [entry.flag, entry]));

/** Flags the surrounding Tdarr command owns; passing them here fights it. */
const RESERVED: Record<string, string> = {
  '-i': 'Tdarr supplies the input file. A second -i adds a second input.',
  '-y': 'Tdarr decides whether to overwrite; -y here has no effect it wants.',
  '-n': 'Tdarr decides whether to overwrite; -n can make the command fail outright.',
  '-hide_banner': 'Tdarr already sets its own logging options.',
};

export interface ArgToken {
  text: string;
  /** Index in the original string, for pointing at a problem. */
  start: number;
  quoted: boolean;
}

export interface TokenizeResult {
  tokens: ArgToken[];
  /** Set when a quote is never closed, which would break the whole command. */
  error: string | null;
}

/**
 * Splits on whitespace, honouring single and double quotes.
 *
 * ffmpeg arguments routinely contain quoted filter graphs with spaces and
 * commas, so a naive `split(' ')` produces tokens that look like flags and are
 * not.
 */
export function tokenizeArgs(text: string): TokenizeResult {
  const tokens: ArgToken[] = [];
  let current = '';
  let start = 0;
  let quote: string | null = null;
  let quoted = false;

  const push = () => {
    if (current !== '' || quoted) tokens.push({ text: current, start, quoted });
    current = '';
    quoted = false;
  };

  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;

    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      quoted = true;
      if (current === '') start = i;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    if (current === '' && !quoted) start = i;
    current += character;
  }

  push();

  return {
    tokens,
    error: quote ? `unclosed ${quote === '"' ? 'double' : 'single'} quote` : null,
  };
}

export interface ArgFinding {
  severity: 'error' | 'warning';
  message: string;
  /** The token it concerns, when it concerns one. */
  token?: string;
}

export interface LintArgsOptions {
  position: ArgPosition;
  /**
   * Flags the wizard is already setting elsewhere in the block. Repeating one
   * here is not an ffmpeg error - the last wins - but it does mean a setting in
   * the form above is silently doing nothing.
   */
  managed?: readonly string[];
}

export function lintFfmpegArgs(text: string, options: LintArgsOptions): ArgFinding[] {
  const { position, managed = [] } = options;
  const findings: ArgFinding[] = [];

  if (!text.trim()) return findings;

  const { tokens, error } = tokenizeArgs(text);
  if (error) {
    return [{
      severity: 'error',
      message: `${error} - ffmpeg would receive a mangled command, so this is not safe to run.`,
    }];
  }

  const seen = new Set<string>();

  tokens.forEach((token, index) => {
    // A quoted token is a value even when it starts with a dash.
    const isFlag = !token.quoted && token.text.startsWith('-') && token.text.length > 1;
    if (!isFlag) {
      // A bare word in the first position, or one following a switch that takes
      // no value, is usually a stray output filename.
      const previous = tokens[index - 1];
      const previousFlag = previous && !previous.quoted && previous.text.startsWith('-')
        ? FLAG_BY_NAME.get(previous.text)
        : undefined;
      const isValue = previous && previous.text.startsWith('-')
        && (!previousFlag || previousFlag.takes === 'value');

      if (!isValue && /\.\w{2,4}$/.test(token.text)) {
        findings.push({
          severity: 'error',
          token: token.text,
          message:
            `"${token.text}" looks like a file path. Tdarr names the output itself; a filename `
            + 'here becomes an extra output and the real one is left unwritten.',
        });
      }
      return;
    }

    const reserved = RESERVED[token.text];
    if (reserved) {
      findings.push({ severity: 'error', token: token.text, message: reserved });
      return;
    }

    if (seen.has(token.text)) {
      findings.push({
        severity: 'warning',
        token: token.text,
        message: `${token.text} appears more than once; ffmpeg takes the last one.`,
      });
    }
    seen.add(token.text);

    if (managed.includes(token.text)) {
      findings.push({
        severity: 'warning',
        token: token.text,
        message:
          `${token.text} is already set by the options above, and this overrides them. Change it `
          + 'there instead, or accept that the control above now does nothing.',
      });
    }

    const known = FLAG_BY_NAME.get(token.text);
    if (!known) {
      // Not an error: the catalogue is a convenience, not an authority.
      findings.push({
        severity: 'warning',
        token: token.text,
        message: `${token.text} is not one of the flags this editor knows. It may still be valid.`,
      });
      return;
    }

    if (known.position !== 'both' && known.position !== position) {
      findings.push({
        severity: 'warning',
        token: token.text,
        message:
          `${token.text} is an ${known.position} option, and this is the ${position} field. `
          + `ffmpeg applies it to the wrong side of -i, where it usually does nothing.`,
      });
    }

    if (known.takes === 'value') {
      const next = tokens[index + 1];
      if (!next || (!next.quoted && next.text.startsWith('-'))) {
        findings.push({
          severity: 'error',
          token: token.text,
          message: `${token.text} needs a value after it.`,
        });
      }
    }
  });

  return findings;
}

/** Flags worth offering for the field being edited, ranked by relevance. */
export function completeFlag(partial: string, position: ArgPosition): readonly FfmpegFlag[] {
  const needle = partial.toLowerCase();
  return FFMPEG_FLAGS
    .filter((entry) => entry.position === position || entry.position === 'both')
    .filter((entry) => !needle || entry.flag.toLowerCase().startsWith(needle))
    .slice(0, 40);
}

// --- command preview ---------------------------------------------------------

export interface CommandPart {
  text: string;
  /**
   * `binary`      - ffmpeg itself.
   * `custom`      - what the user typed, verbatim.
   * `generated`   - a stand-in for the options this step's own controls produce.
   * `placeholder` - a stand-in for something Tdarr fills in.
   */
  kind: 'binary' | 'custom' | 'generated' | 'placeholder';
}

/**
 * The command the block will run, as far as it can honestly be known.
 *
 * The options the wizard's own controls generate are shown as a placeholder
 * rather than spelled out. Tdarr assembles them at run time from the file it is
 * actually looking at - which streams exist, what the source codec is - so any
 * concrete list here would be a guess presented as fact. What this *can* show
 * truthfully, and what matters when hand-writing arguments, is exactly where
 * your text lands relative to `-i` and to everything else.
 */
export function describeCommand(
  args: { input?: string; output?: string } | undefined,
  options: { generatedLabel?: string } = {},
): CommandPart[] {
  const { generatedLabel = 'options from this step' } = options;
  const input = args?.input?.trim();
  const output = args?.output?.trim();

  const parts: CommandPart[] = [{ text: 'ffmpeg', kind: 'binary' }];

  if (input) parts.push({ text: input, kind: 'custom' });
  parts.push({ text: '-i', kind: 'placeholder' }, { text: 'input file', kind: 'placeholder' });
  parts.push({ text: generatedLabel, kind: 'generated' });
  if (output) parts.push({ text: output, kind: 'custom' });
  parts.push({ text: 'output file', kind: 'placeholder' });

  return parts;
}
