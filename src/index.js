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
  
  try {
    const { message } = req.body;

    if (message?.type !== 'tool-calls'||!message?.toolCallList || message.toolCallList.length === 0) {
      return res.json({ result: 'ok' });
    }

    const userInstruction = extractUserInstruction(req.body);
    const callId = message?.toolCallList?.[0]?.id || 'unknown';
    //const callId = message?.call?.id || message?.toolCallId || 'unknown';
    //const callId = message?.call?.id || message?.toolCalls?.[0]?.id || 'unknown';
    
    if (!callId?.function?.arguments && !callId?.arguments) {
      return res.json({ result: 'ok' });
    }

    
    const sessionId = req.body?.call?.id || req.body?.message?.call?.id;

    const messageId = message?.id;
    
    console.log(`Session ID: ${sessionId}`);

    
    // ✅ 2. dedupe
    global.processedMessages = global.processedMessages || new Set();
    
    if (global.processedMessages.has(messageId)) {
      return res.json({ result: "duplicate ignored" });
    }
    global.processedMessages.add(messageId);

    // ✅ 3. enforce sessionId ONLY callId
    if (!sessionId) {
      return res.json({ result: "no session id yet" });
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
      res.status(200).json(errorResponse);
      return;
    }

    const clawPayload = {
      model: 'openclaw/default',
      messages: [
        {
          role: 'user',
          content: userInstruction
        }
      ]
    };

    const clawResponse = await axios.post(
      `${OPENCLAW_URL}/v1/chat/completions`,
      clawPayload,
      {
        headers: {
          Authorization: `Bearer ${OPENCLAW_TOKEN}`,
          'Content-Type': 'application/json',
          'x-openclaw-session-id': sessionId   // ⭐关键
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

    const successResponse = {
      results: [
        {
          toolCallId: callId,
          result: result
        }
      ]
    };

    console.log(`[${timestamp}] RESPONSE:`, JSON.stringify(successResponse, null, 2));
    //res.status(200).json(successResponse);

    return res.json({
      results: [
        {
          toolCallId: callId,
          result: result
        }
      ]
    });


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
    res.status(200).json(errorResponse);
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});
