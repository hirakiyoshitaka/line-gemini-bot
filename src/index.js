import 'dotenv/config';
import express from 'express';
import { messagingApi, middleware, HTTPFetchError } from '@line/bot-sdk';
import { GoogleGenAI } from '@google/genai';

const {
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  GEMINI_API_KEY,
  PORT = '3000',
} = process.env;

if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN || !GEMINI_API_KEY) {
  console.error('ERROR: .env の LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, GEMINI_API_KEY を設定してください');
  process.exit(1);
}

const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

async function askGemini(userMessage) {
  const response = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: userMessage,
  });
  return response.text;
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userText = event.message.text;
  console.log(`受信: ${userText}`);

  let replyText;
  try {
    replyText = await askGemini(userText);
  } catch (err) {
    console.error('Gemini APIエラー:', err);
    replyText = 'すみません、エラーが発生しました。もう一度試してください。';
  }

  await lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: replyText }],
  });
}

const app = express();

app.post(
  '/webhook',
  (req, res, next) => {
    console.log(`[${new Date().toISOString()}] POST /webhook 受信`);
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    next();
  },
  middleware({ channelSecret: LINE_CHANNEL_SECRET }),
  (req, res) => {
    console.log('Events:', JSON.stringify(req.body.events, null, 2));
    Promise.all(req.body.events.map(handleEvent))
      .then(() => res.json({ status: 'ok' }))
      .catch((err) => {
        if (err instanceof HTTPFetchError) {
          console.error('LINE APIエラー:', err.status, err.headers, err.body);
        } else {
          console.error(err);
        }
        res.status(500).json({ status: 'error' });
      });
  }
);

app.listen(Number(PORT), () => {
  console.log(`LINE Gemini Bot が起動しました: http://localhost:${PORT}/webhook`);
});
