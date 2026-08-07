/**
 * The `inputsDB` contract, verified against what
 * `vendor/methods/loadDefaultValues.js` actually does. Every assertion here
 * corresponds to a line of that file.
 */

import { describe, expect, it } from 'vitest';
import { decodeInputs, encodeInputs } from '../src/index.ts';

describe('encodeInputs', () => {
  it('writes booleans as the strings Tdarr compares against', () => {
    // loadDefaultValues does `value === 'true'`, so 'false' is a real false and
    // anything else - 'True', '1', 'no' - is also false.
    expect(encodeInputs('ffmpegCommandEnsureAudioStream@1.0.0', { enableBitrate: true }))
      .toEqual({ enableBitrate: 'true' });
    expect(encodeInputs('ffmpegCommandEnsureAudioStream@1.0.0', { enableBitrate: false }))
      .toEqual({ enableBitrate: 'false' });
  });

  it('writes values that equal the default, as Tdarr\'s editor does', () => {
    // The reference pipeline stores enableSamplerate:"false" even though false
    // is the default. Matching that keeps diffs against an exported flow clean.
    expect(encodeInputs('ffmpegCommandEnsureAudioStream@1.0.0', { enableSamplerate: false }))
      .toEqual({ enableSamplerate: 'false' });
  });

  it('rejects an empty string, which silently means "use the default"', () => {
    expect(() => encodeInputs('checkVideoCodec@1.0.0', { codec: '' }))
      .toThrow(/cannot mean "no value"/);
    expect(() => encodeInputs('checkVideoCodec@1.0.0', { codec: '   ' }))
      .toThrow(/cannot mean "no value"/);
  });

  it('rejects non-finite numbers, which would silently become zero', () => {
    expect(() => encodeInputs('compareFileSizeRatio@2.0.0', { greaterThan: NaN }))
      .toThrow(/turns NaN into 0/);
    expect(() => encodeInputs('compareFileSizeRatio@2.0.0', { lessThan: Infinity }))
      .toThrow(/turns NaN into 0/);
  });

  it('trims, because Tdarr trims before comparing', () => {
    expect(encodeInputs('checkVideoCodec@1.0.0', { codec: ' hevc ' })).toEqual({ codec: 'hevc' });
  });

  it('names the legal inputs when given an unknown one', () => {
    expect(() => encodeInputs('checkVideoCodec@1.0.0', { codecs: 'hevc' } as never))
      .toThrow(/has no input "codecs"\. It accepts: codec\./);
  });

  it('skips undefined so callers can spread optional config', () => {
    expect(encodeInputs('checkVideoCodec@1.0.0', { codec: undefined })).toEqual({});
    expect(encodeInputs('checkVideoCodec@1.0.0', undefined)).toEqual({});
  });
});

describe('decodeInputs', () => {
  it('coerces per the declared type', () => {
    expect(decodeInputs('ffmpegCommandEnsureAudioStream@1.0.0', {
      audioEncoder: 'eac3',
      channels: '6',
      enableBitrate: 'true',
      enableSamplerate: 'false',
    })).toEqual({ audioEncoder: 'eac3', channels: 6, enableBitrate: true, enableSamplerate: false });
  });

  it('drops empty values, which are indistinguishable from absent', () => {
    expect(decodeInputs('checkVideoCodec@1.0.0', { codec: '' })).toEqual({});
  });

  it('turns an unparseable number into 0, exactly as Tdarr does', () => {
    // Not a design choice - reproducing it is the point, so an imported flow
    // decodes to what the server would actually run.
    expect(decodeInputs('compareFileSizeRatio@2.0.0', { greaterThan: 'abc' }))
      .toEqual({ greaterThan: 0 });
  });

  it('passes unknown plugins through as strings', () => {
    // Local plugins are not in the catalog, so there is no type to coerce to.
    expect(decodeInputs('normaliseAudioTracks@1.0.0', { surroundMinChannels: '4' }))
      .toEqual({ surroundMinChannels: '4' });
  });

  it('round-trips through encode', () => {
    const original = { audioEncoder: 'eac3' as const, channels: 6 as const, enableBitrate: true };
    const encoded = encodeInputs('ffmpegCommandEnsureAudioStream@1.0.0', original);
    expect(decodeInputs('ffmpegCommandEnsureAudioStream@1.0.0', encoded)).toEqual(original);
  });
});
