import 'dotenv/config';
import express from 'express';
import { messagingApi, middleware, HTTPFetchError, SignatureValidationFailed } from '@line/bot-sdk';
import { GoogleGenAI } from '@google/genai';

const {
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  GEMINI_API_KEY,
  OPENAI_API_KEY,
  AI_MODEL = 'gemini-2.5-pro',
  AI_TIMEOUT_MS = '45000',
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
const handledWebhookEventIds = new Set();

function hasEnv(value) {
  return value ? 'set' : 'missing';
}

function logStartupDiagnostics() {
  console.log('環境変数チェック:', {
    LINE_CHANNEL_SECRET: hasEnv(LINE_CHANNEL_SECRET),
    LINE_CHANNEL_ACCESS_TOKEN: hasEnv(LINE_CHANNEL_ACCESS_TOKEN),
    GEMINI_API_KEY: hasEnv(GEMINI_API_KEY),
    OPENAI_API_KEY: hasEnv(OPENAI_API_KEY),
    AI_MODEL,
    AI_TIMEOUT_MS,
    PORT,
  });
}

function logLineError(prefix, err) {
  if (err instanceof HTTPFetchError) {
    console.error(prefix, {
      status: err.status,
      body: err.body,
      requestId: err.headers?.get?.('x-line-request-id') ?? err.headers?.['x-line-request-id'],
    });
    return;
  }

  console.error(prefix, err);
}

function rememberWebhookEvent(webhookEventId) {
  if (!webhookEventId) return;

  handledWebhookEventIds.add(webhookEventId);
  if (handledWebhookEventIds.size > 1000) {
    const oldestId = handledWebhookEventIds.values().next().value;
    handledWebhookEventIds.delete(oldestId);
  }
}

function normalizeReplyText(text) {
  const fallbackText = 'すみません、応答を生成できませんでした。もう一度試してください。';
  const normalized = typeof text === 'string' && text.trim() ? text.trim() : fallbackText;
  return normalized.length > 5000 ? `${normalized.slice(0, 4990)}\n...` : normalized;
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function askGemini(userMessage) {
  const response = await genAI.models.generateContent({
    model: AI_MODEL,
    contents: userMessage,
  });
  return normalizeReplyText(response.text);
}

async function handleEvent(event) {
  const eventId = event.webhookEventId ?? 'unknown';
  const isRedelivery = Boolean(event.deliveryContext?.isRedelivery);

  console.log('Webhookイベント受信:', {
    eventId,
    type: event.type,
    isRedelivery,
    hasReplyToken: Boolean(event.replyToken),
  });

  if (event.webhookEventId && handledWebhookEventIds.has(event.webhookEventId)) {
    console.warn('同一Webhookイベントの再処理をスキップ:', { eventId });
    return { eventId, status: 'skipped_duplicate' };
  }

  if (isRedelivery) {
    console.warn('LINE再送イベントのため返信をスキップ:', { eventId });
    rememberWebhookEvent(event.webhookEventId);
    return { eventId, status: 'skipped_redelivery' };
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    rememberWebhookEvent(event.webhookEventId);
    return { eventId, status: 'ignored' };
  }

  if (!event.replyToken) {
    console.error('replyToken がないため返信できません:', { eventId });
    rememberWebhookEvent(event.webhookEventId);
    return { eventId, status: 'missing_reply_token' };
  }

  const userText = event.message.text;
  console.log('テキストメッセージ受信:', { eventId, textLength: userText.length });

  let replyText;
  try {
    replyText = await withTimeout(askGemini(userText), Number(AI_TIMEOUT_MS), 'AI response');
  } catch (err) {
    console.error('Gemini APIエラー:', {
      eventId,
      model: AI_MODEL,
      message: err instanceof Error ? err.message : String(err),
    });
    replyText = 'すみません、エラーが発生しました。もう一度試してください。';
  }

  try {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: normalizeReplyText(replyText) }],
    });
    console.log('LINE返信成功:', { eventId });
    rememberWebhookEvent(event.webhookEventId);
    return { eventId, status: 'replied' };
  } catch (err) {
    logLineError('LINE返信エラー:', err);
    rememberWebhookEvent(event.webhookEventId);
    return { eventId, status: 'reply_failed' };
  }
}

const app = express();

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    aiModel: AI_MODEL,
    env: {
      LINE_CHANNEL_SECRET: hasEnv(LINE_CHANNEL_SECRET),
      LINE_CHANNEL_ACCESS_TOKEN: hasEnv(LINE_CHANNEL_ACCESS_TOKEN),
      GEMINI_API_KEY: hasEnv(GEMINI_API_KEY),
      OPENAI_API_KEY: hasEnv(OPENAI_API_KEY),
    },
  });
});

app.post(
  '/webhook',
  (req, res, next) => {
    console.log(`[${new Date().toISOString()}] POST /webhook 受信`);
    console.log('Webhookヘッダー:', {
      hasLineSignature: Boolean(req.headers['x-line-signature']),
      contentLength: req.headers['content-length'],
      userAgent: req.headers['user-agent'],
    });
    next();
  },
  middleware({ channelSecret: LINE_CHANNEL_SECRET }),
  async (req, res) => {
    const events = Array.isArray(req.body.events) ? req.body.events : [];
    console.log('LINEイベント数:', events.length);

    const results = await Promise.allSettled(events.map(handleEvent));
    const statuses = results.map((result) => {
      if (result.status === 'fulfilled') return result.value;

      console.error('イベント処理で未捕捉エラー:', result.reason);
      return { status: 'handler_rejected' };
    });

    res.json({ status: 'ok', events: statuses });
  }
);

app.use((err, req, res, next) => {
  if (err instanceof SignatureValidationFailed) {
    console.error('LINE署名検証エラー:', { path: req.path, message: err.message });
    res.status(401).json({ status: 'invalid_signature' });
    return;
  }

  console.error('Express未捕捉エラー:', err);
  res.status(500).json({ status: 'error' });
});

process.on('unhandledRejection', (reason) => {
  console.error('未処理のPromise拒否:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('未捕捉例外:', err);
  process.exit(1);
});

logStartupDiagnostics();

const server = app.listen(Number(PORT), () => {
  console.log(`LINE Gemini Bot が起動しました: http://localhost:${PORT}/webhook`);
});

export { app, server };
