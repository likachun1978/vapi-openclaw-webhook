const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const OPENCLAW_URL = process.env.OPENCLAW_URL;
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'vapi-openclaw-webhook' });
});

app.post('/webhook', async (req, res) => {
  //console.log("🔥 WEBHOOK HIT:", JSON.stringify(req.body, null, 2));
  console.log("🔥 WEBHOOK HIT");
  
  try {
    const { message } = req.body;
    console.log("Message type:", message?.type);

    if (message?.type !== 'function-call') {
      return res.json({ result: 'ok' });
    }

    const userInstruction = message?.functionCall?.parameters?.instruction || '';
    const callId = message?.call?.id || 'unknown';

    console.log(`[${callId}] Instruction: ${userInstruction}`);
  
    const clawResponse = await axios.post(
      `${OPENCLAW_URL}/api/v1/message`,
      {
        message: userInstruction,
        stream: false
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000
      }
    );

    const result = clawResponse.data?.text
      || clawResponse.data?.output
      || clawResponse.data?.result
      || '任務已完成';

    console.log(`[${callId}] Result: ${result}`);
    res.json({ result });

  } catch (error) {
    console.error('Webhook error:', error.message);
    res.json({ result: '抱歉，我遇到了一些問題，請稍後再試。' });
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});
