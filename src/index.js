const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const OPENCLAW_URL = process.env.OPENCLAW_URL;
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
const PORT = process.env.PORT || 3000;

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
  console.log(`\n[${timestamp}] ===== WEBHOOK REQUEST RECEIVED =====`);
  
  try {
    // ===== DEBUG: Log full incoming payload =====
    console.log(`[${timestamp}] Full incoming payload:`, JSON.stringify(req.body, null, 2));
    console.log(`[${timestamp}] Request headers:`, JSON.stringify(req.headers, null, 2));

    const { message } = req.body;
    console.log(`[${timestamp}] Message type: ${message?.type}`);
    console.log(`[${timestamp}] Message structure:`, JSON.stringify(message, null, 2));

    if (message?.type !== 'tool-calls') {
      console.log(`[${timestamp}] ⏭️  Skipping non-tool-calls message type: ${message?.type}`);
      return res.json({ result: 'ok' });
    }

    console.log(`[${timestamp}] 🔥 TOOL-CALLS MESSAGE DETECTED`);

    const userInstruction = extractUserInstruction(req.body);
    const callId = message?.call?.id || message?.toolCallId || 'unknown';

    console.log(`[${timestamp}] Call ID: ${callId}`);
    console.log(`[${timestamp}] Extracted instruction: ${userInstruction}`);

    if (!userInstruction) {
      console.log(`[${timestamp}] ❌ No user instruction found`);
      const errorResponse = {
        results: [
          {
            toolCallId: callId,
            result: '抱歉，我暫時讀不到用戶的訊息內容。'
          }
        ]
      };
      console.log(`[${timestamp}] Sending error response:`, JSON.stringify(errorResponse, null, 2));
      res.status(200).json(errorResponse);
      console.log(`[${timestamp}] Error response sent successfully`);
      return;
    }

    console.log(`[${timestamp}] 📤 Calling OpenClaw API at: ${OPENCLAW_URL}/v1/chat/completions`);
    const clawPayload = {
      model: 'openclaw/default',
      messages: [
        {
          role: 'user',
          content: userInstruction
        }
      ]
    };
    console.log(`[${timestamp}] OpenClaw request payload:`, JSON.stringify(clawPayload, null, 2));

    const clawResponse = await axios.post(
      `${OPENCLAW_URL}/v1/chat/completions`,
      clawPayload,
      {
        headers: {
          Authorization: `Bearer ${OPENCLAW_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000
      }
    );

    console.log(`[${timestamp}] ✅ OpenClaw response received`);
    console.log(`[${timestamp}] OpenClaw status: ${clawResponse.status}`);
    console.log(`[${timestamp}] OpenClaw response data:`, JSON.stringify(clawResponse.data, null, 2));

    const result =
      clawResponse.data?.choices?.[0]?.message?.content ||
      clawResponse.data?.text ||
      clawResponse.data?.output ||
      clawResponse.data?.result ||
      '任務已完成';

    console.log(`[${timestamp}] Extracted result: ${result}`);

    const successResponse = {
      results: [
        {
          toolCallId: callId,
          result: result
        }
      ]
    };

    console.log(`[${timestamp}] 📤 Sending response to VAPI:`, JSON.stringify(successResponse, null, 2));
    res.status(200).json(successResponse);
    console.log(`[${timestamp}] ✅ Response sent successfully to VAPI`);
    console.log(`[${timestamp}] ===== WEBHOOK COMPLETED SUCCESSFULLY =====\n`);

  } catch (error) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ❌ WEBHOOK ERROR OCCURRED`);
    console.error(`[${timestamp}] Error message: ${error.message}`);
    console.error(`[${timestamp}] Error code: ${error.code}`);
    console.error(`[${timestamp}] Error status: ${error.response?.status}`);
    console.error(`[${timestamp}] Error response data:`, JSON.stringify(error.response?.data, null, 2));
    console.error(`[${timestamp}] Full error stack:`, error.stack);

    const errorResponse = {
      results: [
        {
          toolCallId: 'unknown',
          result: '抱歉，我遇到了一些問題，請稍後再試。'
        }
      ]
    };

    console.log(`[${timestamp}] 📤 Sending error response:`, JSON.stringify(errorResponse, null, 2));
    res.status(200).json(errorResponse);
    console.log(`[${timestamp}] ===== WEBHOOK ERROR HANDLED =====\n`);
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});
