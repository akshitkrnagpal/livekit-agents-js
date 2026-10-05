// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { VAD, type VADEvent, VADEventType, VADStream } from './vad.js';

function event(index: number, type = VADEventType.INFERENCE_DONE): VADEvent {
  return {
    type,
    samplesIndex: index,
    timestamp: index * 32,
    speechDuration: 0,
    silenceDuration: 0,
    frames: [AudioFrame.create(16000, 1, 512)],
    probability: 0,
    inferenceDuration: 2,
    speaking: type === VADEventType.START_OF_SPEECH,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech: 0,
  };
}

class TestVAD extends VAD {
  label = 'test-vad';

  constructor() {
    super({ updateInterval: 1000 });
  }

  stream(): TestVADStream {
    return new TestVADStream(this);
  }
}

class TestVADStream extends VADStream {
  sent = 0;

  emit(event: VADEvent): Promise<boolean> {
    return Promise.resolve(this.sendVADEvent(event));
  }

  async produce(count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      if (!(await this.emit(event(index)))) return;
      this.sent++;
    }
  }

  async pumpFrames(): Promise<void> {
    while (!this.closed) {
      const { done } = await this.inputReader.read();
      if (done) return;
      if (!(await this.emit(event(this.sent)))) return;
      this.sent++;
    }
  }

  finish(): Promise<void> {
    return this.outputWriter.close();
  }
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('VADStream backpressure', () => {
  it('blocks an awaited producer while its consumer is stalled', async () => {
    const stream = new TestVAD().stream();
    const producing = stream.produce(100);
    try {
      await nextTick();
      expect(stream.sent).toBeLessThan(5);
      const stalledAt = stream.sent;
      await nextTick();
      expect(stream.sent).toBe(stalledAt);

      const received: number[] = [];
      for (let index = 0; index < 10; index++) {
        const result = await stream.next();
        expect(result.done).toBe(false);
        received.push(result.value.samplesIndex);
      }
      expect(received).toEqual(Array.from({ length: 10 }, (_, index) => index));
      await nextTick();
      expect(stream.sent).toBeGreaterThan(stalledAt);
      expect(stream.sent).toBeLessThan(15);
    } finally {
      stream.close();
      await producing;
    }
  });

  it('propagates a stalled consumer back to the attached audio source', async () => {
    let pulls = 0;
    const source = new ReadableStream<AudioFrame>(
      {
        pull(controller) {
          if (pulls === 100) {
            controller.close();
            return;
          }
          pulls++;
          controller.enqueue(AudioFrame.create(16000, 1, 512));
        },
      },
      { highWaterMark: 1 },
    );
    const stream = new TestVAD().stream();
    const pumping = stream.pumpFrames();
    stream.updateInputStream(source);
    try {
      await nextTick();
      expect(pulls).toBeLessThan(20);
      expect(stream.sent).toBeLessThan(5);
      const stalledAt = pulls;
      await nextTick();
      expect(pulls).toBe(stalledAt);

      for (let index = 0; index < 10; index++) {
        await stream.next();
      }
      await nextTick();
      expect(pulls).toBeGreaterThan(stalledAt);
      expect(pulls).toBeLessThan(30);
    } finally {
      stream.close();
      await pumping;
    }
  });

  it('preserves event order and metrics while forwarding to the consumer', async () => {
    const vad = new TestVAD();
    const metrics = vi.fn();
    vad.on('metrics_collected', metrics);
    const stream = vad.stream();
    const events = [
      event(0),
      event(1, VADEventType.START_OF_SPEECH),
      event(2),
      event(3, VADEventType.END_OF_SPEECH),
    ];
    const producing = (async () => {
      for (const value of events) await stream.emit(value);
      await stream.finish();
    })();
    try {
      const received: VADEvent[] = [];
      for await (const value of stream) received.push(value);
      await producing;

      expect(received).toEqual(events);
      expect(metrics).toHaveBeenCalledOnce();
      expect(metrics).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'vad_metrics',
          label: 'test-vad',
          inferenceCount: 1,
          inferenceDurationTotalMs: 2,
        }),
      );
    } finally {
      stream.close();
    }
  });

  it('settles pending writes and reads when closed without a consumer', async () => {
    const stream = new TestVAD().stream();
    const pending = stream.produce(100);
    await nextTick();
    stream.close();
    stream.close();

    await expect(pending).resolves.toBeUndefined();
    await expect(stream.emit(event(101))).resolves.toBe(false);
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
