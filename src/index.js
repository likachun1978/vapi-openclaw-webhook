const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const OPENCLAW_URL = process.env.OPENCLAW_URL;
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
const PORT = process.env.PORT || 3000;

// In-memory conversation history keyed by VAPI call ID
const sessionStore = new Map();

// Persists history across calls keyed by customer phone number, with TTL
// so that a callback 1 minute later can resume the prior conversation.
const callbackStore = new Map();
const CALLBACK_TTL_MS = 10 * 60 * 1000; // 10 minutes

const cleanupInterval = setInterval(cleanupExpiredCallbacks, 60 * 1000);

function extractPhoneNumber(body) {
  const message = body?.message;

  const raw = 
    // ✅ toolCall arguments 裡面（如果 agent 有傳）
    message?.toolCalls?.[0]?.function?.arguments?.number ||
    message?.toolCalls?.[0]?.function?.arguments?.phone ||
    message?.toolCalls?.[0]?.function?.arguments?.phoneNumber ||
    message?.toolCalls?.[0]?.function?.arguments?.customerNumber ||
    
    // ✅ 其他 fallback path
    message?.call?.customer?.number ||
    message?.call?.customer?.phoneNumber ||
    message?.call?.customer?.callerNumber ||
    message?.call?.customer?.telephone ||
    message?.call?.customer?.tel ||
    message?.call?.customer?.from ||
    message?.call?.from ||

    // ✅ 最常見：Vapi inbound call 的電話號碼
    body?.message?.call?.customer?.number ||
    body?.call?.customer?.number ||

    // ✅ 其他常見 path
    body?.message?.call?.customer?.phoneNumber ||
    body?.call?.customer?.phoneNumber ||
    body?.message?.customer?.number ||
    body?.customer?.number ||

    null;

  if (!raw) return null;
  return String(raw).replace(/[^\d+]/g, '');
}

// Remove entries whose TTL has expired to prevent memory leaks
function cleanupExpiredCallbacks() {
  const now = Date.now();
  for (const [phone, entry] of callbackStore.entries()) {
    if (entry.expiresAt <= now) {
      callbackStore.delete(phone);
    }
  }
}

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

app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});

app.post('/webhook', async (req, res) => {
  const timestamp = new Date().toISOString();

  try {
    const { message } = req.body;
    //const sessionId = req.body?.call?.id || req.body?.message?.call?.id;
    const phone = extractPhoneNumber(req.body);
    const callId = req.body?.call?.id || req.body?.message?.call?.id;
    const sessionId = phone ? `caller:${phone}` : (callId ? `call:${callId}` : null); 

    // Clean up session when the call ends, preserving history for callbacks
    if (message?.type === 'end-of-call-report' || message?.type === 'call-ended') {
      if (sessionId) {
        const history = sessionStore.get(sessionId);
        if (history && history.length > 0) {
          const phone = extractPhoneNumber(req.body);
          if (phone) {
            //callbackStore.set(phone, { history, expiresAt: Date.now() + CALLBACK_TTL_MS });
            callbackStore.set(sessionId, { history, expiresAt: Date.now() + CALLBACK_TTL_MS });
            console.log(`[${timestamp}] History saved for callback: phone=${phone}, turns=${history.length}`);
          }
        }
        sessionStore.delete(sessionId);
        console.log(`[${timestamp}] Session cleaned up: ${sessionId}`);
      }
      return res.json({ result: 'ok' });
    }

    if (message?.type !== 'tool-calls' || !message?.toolCallList || message.toolCallList.length === 0) {
      return res.json({ result: 'ok' });
    }

    const userInstruction = extractUserInstruction(req.body);
    const toolCallId = message?.toolCallList?.[0]?.id || 'unknown';

    //console.log(`[${timestamp}] RESPONSE:`, JSON.stringify(req.body, null, 2));

    console.log(`[${timestamp}] phone: ${phone}`);
    console.log(`[${timestamp}] callId: ${callId}`);
    console.log(`[${timestamp}] sessionId: ${sessionId}`);

    if (!sessionId) {
      return res.json({ result: 'no session id yet' });
    }

    if (!userInstruction) {
      const errorResponse = {
        results: [
          {
            toolCallId: toolCallId,
            result: '抱歉，我暫時讀不到用戶的訊息內容。'
          }
        ]
      };
      console.log(`[${timestamp}] RESPONSE:`, JSON.stringify(errorResponse, null, 2));
      return res.status(200).json(errorResponse);
    }
    else {
      console.log(`[${timestamp}] Request: ${userInstruction}`);
    }

    // Get or create conversation history for this session.
    // If this is a new session, check callbackStore for history from a prior call
    // (e.g. OpenClaw called back after 1 minute) so context is preserved.
    if (!sessionStore.has(sessionId)) {
      //const phone = extractPhoneNumber(req.body);
      //const callbackEntry = phone ? callbackStore.get(phone) : null;
      
      const callbackEntry = callbackStore.get(sessionId); 
      if (callbackEntry && callbackEntry.expiresAt > Date.now()) {
        sessionStore.set(sessionId, callbackEntry.history);
        callbackStore.delete(sessionId);
        console.log(`[${timestamp}] Restored callback history for session ${sessionId} from phone ${phone}, turns=${callbackEntry.history.length}`);
      } else {
        sessionStore.set(sessionId, []);
      }
    }
    const history = sessionStore.get(sessionId);

    // Append the new user message to the history
    history.push({role: 'user', content: userInstruction});

    const clawPayload = {
      model: 'openclaw/default',
      messages: history, 
      user: sessionId
    };

    const clawResponse = await axios.post(
      `${OPENCLAW_URL}/v1/chat/completions`,
      clawPayload,
      {
        headers: {
          Authorization: `Bearer ${OPENCLAW_TOKEN}`,
          'Content-Type': 'application/json',
          'x-openclaw-session-key': sessionId
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
          toolCallId: toolCallId,
          result: result
        }
      ]
    };
    console.log(`[${timestamp}] Response: ${successResponse.results?.[0]?.result}`);

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

process.on('SIGTERM', () => { clearInterval(cleanupInterval); process.exit(0); });
process.on('SIGINT', () => { clearInterval(cleanupInterval); process.exit(0); });