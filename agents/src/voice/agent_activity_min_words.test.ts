// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import type { AudioRecognition } from './audio_recognition.js';
import { AudioOutput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

class HeldAudioOutput extends AudioOutput {
  constructor() {
    super(24000);
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.onPlaybackStarted(Date.now());
  }

  override clearBuffer(): void {
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
  }
}

class ScriptedAgent extends Agent {
  controller!: ReadableStreamDefaultController<SpeechEvent>;

  constructor() {
    super({ instructions: 'test' });
  }

  override async sttNode(): Promise<ReadableStream<SpeechEvent>> {
    return new ReadableStream<SpeechEvent>({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  override async ttsNode(): Promise<null> {
    return null;
  }

  final(text: string): void {
    this.controller.enqueue({
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ text, language: 'en', startTime: 0, endTime: 0, confidence: 0.9 }],
    });
  }

  startTurn(): void {
    this.controller.enqueue({ type: SpeechEventType.START_OF_SPEECH, alternatives: [] });
  }

  endTurn(): void {
    this.controller.enqueue({ type: SpeechEventType.END_OF_SPEECH, alternatives: [] });
  }
}

async function openSession() {
  const agent = new ScriptedAgent();
  const session = new AgentSession({
    stt: new FakeSTT(),
    llm: new FakeLLM(),
    turnHandling: {
      turnDetection: 'stt',
      endpointing: { minDelay: 0, maxDelay: 0 },
      interruption: { mode: 'vad', minWords: 2 },
      preemptiveGeneration: { enabled: false },
    },
  });
  session.output.audio = new HeldAudioOutput();
  await session.start({ agent });
  const speech = session.say('A long reply.', {
    audio: new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(new AudioFrame(new Int16Array(480), 24000, 1, 480));
        controller.close();
      },
    }),
  });
  await vi.waitFor(() => expect(session.agentState).toBe('speaking'));
  const activity = session._activity!;
  const recognition = (activity as unknown as { audioRecognition: AudioRecognition })
    .audioRecognition;
  const decisions = vi.spyOn(activity, 'onEndOfTurn');
  return { agent, session, speech, recognition, decisions };
}

describe('minimum interruption words', () => {
  it('does not accumulate rejected backchannels into an interruption', async () => {
    const { agent, session, speech, recognition, decisions } = await openSession();
    try {
      for (const [index, text] of ['okay', 'right', 'right'].entries()) {
        agent.final(text);
        agent.endTurn();
        await vi.waitFor(() => expect(decisions).toHaveBeenCalledTimes(index + 1));
        await recognition.waitForEndOfTurnTask();
      }

      expect(decisions.mock.calls.map(([info]) => info.newTranscript)).toEqual([
        'okay',
        'right',
        'right',
      ]);
      expect(recognition.currentTranscript).toBe('');
      expect(speech.interrupted).toBe(false);
      expect(
        session.history.items.filter((item) => item.type === 'message' && item.role === 'user'),
      ).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  it('does not prefix the next committed turn with a rejected backchannel', async () => {
    const { agent, session, recognition, decisions } = await openSession();
    try {
      agent.final('okay');
      agent.endTurn();
      await vi.waitFor(() => expect(decisions).toHaveBeenCalledOnce());
      await recognition.waitForEndOfTurnTask();

      agent.final('please stop');
      agent.endTurn();
      await vi.waitFor(() => expect(decisions).toHaveBeenCalledTimes(2));
      await recognition.waitForEndOfTurnTask();

      expect(decisions.mock.calls[1]![0].newTranscript).toBe('please stop');
      await vi.waitFor(() =>
        expect(
          session.history.items.some(
            (item) =>
              item.type === 'message' && item.role === 'user' && item.textContent === 'please stop',
          ),
        ).toBe(true),
      );
    } finally {
      await session.close();
    }
  });

  it('still combines transcript segments within one utterance', async () => {
    const { agent, session, recognition, decisions } = await openSession();
    try {
      agent.final('hey');
      agent.final('please stop');
      agent.endTurn();
      await vi.waitFor(() => expect(decisions).toHaveBeenCalledOnce());
      await recognition.waitForEndOfTurnTask();

      expect(decisions.mock.calls[0]![0].newTranscript).toBe('hey please stop');
    } finally {
      await session.close();
    }
  });

  it('preserves a new final transcript received while a rejected decision settles', async () => {
    const { agent, session, recognition, decisions } = await openSession();
    const activity = session._activity!;
    decisions.mockImplementation(async (info) => {
      const committed = await AgentActivity.prototype.onEndOfTurn.call(activity, info);
      if (info.newTranscript === 'okay') {
        agent.startTurn();
        agent.final('please stop');
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return committed;
    });

    try {
      agent.final('okay');
      agent.endTurn();
      await vi.waitFor(() => expect(decisions).toHaveBeenCalledOnce());
      await recognition.waitForEndOfTurnTask();
      expect(recognition.currentTranscript).toBe('please stop');

      agent.endTurn();
      await vi.waitFor(() => expect(decisions).toHaveBeenCalledTimes(2));
      await recognition.waitForEndOfTurnTask();
      expect(decisions.mock.calls[1]![0].newTranscript).toBe('please stop');
    } finally {
      decisions.mockRestore();
      await session.close();
    }
  });

  it('retains transcripts when the activity defers rather than discards a turn', async () => {
    const { agent, session, recognition, decisions } = await openSession();
    decisions.mockResolvedValueOnce(false);
    try {
      agent.final('hey');
      agent.endTurn();
      await vi.waitFor(() => expect(decisions).toHaveBeenCalledOnce());
      await recognition.waitForEndOfTurnTask();

      expect(recognition.currentTranscript).toBe('hey');
    } finally {
      await session.close();
    }
  });
});
