// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { TransformStream } from 'node:stream/web';

export class IdentityTransform<T> extends TransformStream<T, T> {
  /**
   * @param highWaterMark - Maximum queued chunks on each side of the transform.
   * Defaults to effectively unlimited buffering for compatibility with existing channels.
   */
  constructor(highWaterMark = Number.MAX_SAFE_INTEGER) {
    super(
      {
        transform: (chunk, controller) => controller.enqueue(chunk),
      },
      { highWaterMark },
      { highWaterMark },
    );
  }
}
