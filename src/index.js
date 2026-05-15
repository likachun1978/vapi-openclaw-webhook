const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const OPENCLAW_URL = process.env.OPENCLAW_URL;
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
const PORT = process.env.PORT || 3000;

// In-memory conversation history keyed by VAPI call ID
const sessionStore = new Map();

function extractUserInstruction(body) {
  const message = body?.message;

  const candidates = [
    message?.toolCalls?.[0]?.function?.arguments,
    message?.toolCalls?.[0]?.arguments,
    message?.call?.parameters,
    message?.functionCall?.parameters,
    body?.message?.content,
    body?.content
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (typeof candidate === 'string') {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed?.instruction) return parsed.instruction;
        if (parsed?.message) return parsed.message;
        if (parsed?.query) return parsed.query;
        if (parsed?.content) return parsed.content;
      } catch {
        return candidate;
      }
    }

    if (typeof candidate === 'object') {
      if (candidate?.instruction) return candidate.instruction;
      if (candidate?.message) return candidate.message;
      if (candidate?.query) return candidate.query;
      if (candidate?.content) return candidate.content;
    }
  }

  const messages = body?.messages || body?.conversation?.messages;
  if (Array.isArray(messages)) {
    const lastUserMessage = [...messages].reverse().find((m) => m?.role === 'user');
    if (lastUserMessage?.content) return lastUserMessage.content;
  }

  return '';
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'vapi-openclaw-webhook' });
});

app.post('/webhook', async (req, res) => {
  const timestamp = new Date().toISOString();

  try {
    const { message } = req.body;
    const sessionId = req.body?.call?.id || req.body?.message?.call?.id;

    // Clean up session when the call ends
    if (message?.type === 'end-of-call-report' || message?.type === 'call-ended') {
      if (sessionId) {
        sessionStore.delete(sessionId);
        console.log(`[${timestamp}] Session cleaned up: ${sessionId}`);
      }
      return res.json({ result: 'ok' });
    }

    if (message?.type !== 'tool-calls' || !message?.toolCallList || message.toolCallList.length === 0) {
      return res.json({ result: 'ok' });
    }

    const userInstruction = extractUserInstruction(req.body);
    const callId = message?.toolCallList?.[0]?.id || 'unknown';

    console.log(`[${timestamp}] Session ID: ${sessionId}`);

    if (!sessionId) {
      return res.json({ result: 'no session id yet' });
    }

    if (!userInstruction) {
      const errorResponse = {
        results: [
          {
            toolCallId: callId,
            result: '抱歉，我暫時讀不到用戶的訊息內容。'
          }
        ]
      };
      console.log(`[${timestamp}] RESPONSE:`, JSON.stringify(errorResponse, null, 2));
      return res.status(200).json(errorResponse);
    }

    // Get or create conversation history for this session
    if (!sessionStore.has(sessionId)) {
      sessionStore.set(sessionId, []);
    }
    const history = sessionStore.get(sessionId);

    // Append the new user message to the history
    history.push({ role: 'user', content: userInstruction });

    const clawPayload = {
      model: 'openclaw/default',
      messages: history
    };

    const clawResponse = await axios.post(
      `${OPENCLAW_URL}/v1/chat/completions`,
      clawPayload,
      {
        headers: {
          Authorization: `Bearer ${OPENCLAW_TOKEN}`,
          'Content-Type': 'application/json',
          'x-openclaw-session-id': sessionId
        },
        timeout: 25000
      }
    );

    const result =
      clawResponse.data?.choices?.[0]?.message?.content ||
      clawResponse.data?.text ||
      clawResponse.data?.output ||
      clawResponse.data?.result ||
      '任務已完成';

    // Append the assistant reply to the history so the next turn has context
    history.push({ role: 'assistant', content: result });

    const successResponse = {
      results: [
        {
          toolCallId: callId,
          result: result
        }
      ]
    };

    console.log(`[${timestamp}] RESPONSE:`, JSON.stringify(successResponse, null, 2));
    return res.json(successResponse);

  } catch (error) {
    const timestamp = new Date().toISOString();

    const errorResponse = {
      results: [
        {
          toolCallId: 'unknown',
          result: '抱歉，我遇到了一些問題，請稍後再試。'
        }
      ]
    };

    console.error(`[${timestamp}] ERROR:`, error.message);
    console.log(`[${timestamp}] RESPONSE:`, JSON.stringify(errorResponse, null, 2));
    return res.status(200).json(errorResponse);
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});
