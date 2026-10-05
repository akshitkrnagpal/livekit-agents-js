<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# OpenAI plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the OpenAI plugin, which allows for TTS, STT, LLM, as well
as using the Realtime API and Responses API. Refer to the
[documentation](https://docs.livekit.io/agents/overview/) for information on how
to use it, or browse the [API
reference](https://docs.livekit.io/agents-js/modules/plugins_agents_plugin_openai.html).
See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.

Provider-specific chat completion parameters can be configured once with `extraKwargs`:

```ts
import * as openai from '@livekit/agents-plugin-openai';

const model = openai.LLM.withTelnyx({
  apiKey: process.env.TELNYX_API_KEY,
  extraKwargs: { enable_thinking: false },
});
```

These defaults are sent on every chat completion request, including requests made by an
`AgentSession`. A call to `model.chat({ chatCtx, extraKwargs: { ... } })` can override individual
defaults for that request without changing subsequent requests.
