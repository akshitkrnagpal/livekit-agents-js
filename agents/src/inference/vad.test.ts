// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import type { VADStream } from '../vad.js';
import * as warmup from './_warmup.js';
import { VAD, type VADOptions } from './vad.js';

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
});

/** White-box view of an `InferenceVADStream`'s internal buffer state. */
type StreamInternals = {
  _opts: VADOptions;
  _speechBuffer: Int16Array | null;
  _prefixPaddingSamples: number;
  _inputSampleRate: number;
};

const internals = (stream: VADStream): StreamInternals => stream as unknown as StreamInternals;

it('pauses native VAD inference until its consumer resumes reading', async () => {
  const native = warmup._getLocalInferenceModule();
  expect(native).toBeDefined();
  const predict = vi.fn().mockResolvedValue(0);
  const moduleSpy = vi.spyOn(warmup, '_getLocalInferenceModule').mockReturnValue({
    ...native!,
    createVad: () => ({ predict, reset: vi.fn() }),
  });
  const stream = new VAD().stream();
  let pulls = 0;
  stream.updateInputStream(
    new ReadableStream<AudioFrame>({
      pull(controller) {
        pulls++;
        controller.enqueue(AudioFrame.create(16000, 1, 512));
      },
    }),
  );
  const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    await nextTick();
    expect(predict.mock.calls.length).toBeGreaterThan(0);
    expect(predict.mock.calls.length).toBeLessThan(5);
    expect(pulls).toBeLessThan(20);
    const stalledAt = predict.mock.calls.length;
    await nextTick();
    expect(predict).toHaveBeenCalledTimes(stalledAt);
    for (let index = 0; index < 10; index++) await stream.next();
    await nextTick();
    expect(predict.mock.calls.length).toBeGreaterThan(stalledAt);
  } finally {
    stream.close();
    await nextTick();
    moduleSpy.mockRestore();
  }
});

describe('inference.VAD updateOptions propagation', () => {
  it('fans out option changes to live streams', () => {
    const vad = new VAD({ minSilenceDuration: 250 });
    const stream = vad.stream();
    try {
      expect(internals(stream)._opts.minSilenceDuration).toBe(250);

      vad.updateOptions({ minSilenceDuration: 800 });

      // The already-created stream observes the new value, not a stale snapshot.
      expect(internals(stream)._opts.minSilenceDuration).toBe(800);
    } finally {
      stream.close();
    }
  });

  it('resizes a live stream speech buffer once the sample rate is known', () => {
    const sampleRate = 16000;
    const vad = new VAD({ maxBufferedSpeech: 10_000, prefixPaddingDuration: 500 });
    const stream = vad.stream();
    try {
      // Simulate a stream that has already seen its first frame.
      const s = internals(stream);
      s._inputSampleRate = sampleRate;
      s._prefixPaddingSamples = Math.trunc((500 * sampleRate) / 1000);
      s._speechBuffer = new Int16Array(
        Math.trunc((10_000 * sampleRate) / 1000) + s._prefixPaddingSamples,
      );

      vad.updateOptions({ maxBufferedSpeech: 20_000, prefixPaddingDuration: 1000 });

      const expectedPrefix = Math.trunc((1000 * sampleRate) / 1000);
      expect(s._prefixPaddingSamples).toBe(expectedPrefix);
      expect(s._speechBuffer?.length).toBe(
        Math.trunc((20_000 * sampleRate) / 1000) + expectedPrefix,
      );
    } finally {
      stream.close();
    }
  });
});
