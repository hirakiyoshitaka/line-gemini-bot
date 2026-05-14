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

const AI_PROVIDER = 'Google Gemini';
const LINE_REPLY_MAX_LENGTH = 800;

if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN) {
  console.error('ERROR: .env の LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN を設定してください');
  process.exit(1);
}

const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

const genAI = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const handledWebhookEventIds = new Set();
const inFlightWebhookEventIds = new Set();

function hasEnv(value) {
  return value ? 'set' : 'missing';
}

function logStartupDiagnostics() {
  console.log('環境変数チェック:', {
    LINE_CHANNEL_SECRET: hasEnv(LINE_CHANNEL_SECRET),
    LINE_CHANNEL_ACCESS_TOKEN: hasEnv(LINE_CHANNEL_ACCESS_TOKEN),
    GEMINI_API_KEY: hasEnv(GEMINI_API_KEY),
    OPENAI_API_KEY: hasEnv(OPENAI_API_KEY),
    AI_PROVIDER,
    AI_MODEL,
    AI_TIMEOUT_MS,
    PORT,
  });

  if (!GEMINI_API_KEY) {
    console.error('AI設定エラー: GEMINI_API_KEY が未設定または空です。AI応答はエラーメッセージになります。');
  }
}

function errorDetails(err) {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }

  return {
    name: typeof err,
    message: String(err),
    stack: undefined,
  };
}

function eventDetails(event, userText) {
  return {
    eventId: event?.webhookEventId ?? 'unknown',
    eventType: event?.type,
    messageType: event?.message?.type,
    userMessageText: userText ?? event?.message?.text,
    aiProvider: AI_PROVIDER,
    aiModel: AI_MODEL,
    isRedelivery: Boolean(event?.deliveryContext?.isRedelivery),
    hasReplyToken: Boolean(event?.replyToken),
  };
}

function logAiError(err, event, userText) {
  console.error('AI呼び出しエラー:', {
    ...eventDetails(event, userText),
    error: errorDetails(err),
  });
}

function logLineError(prefix, err, event, userText) {
  if (err instanceof HTTPFetchError) {
    console.error(prefix, {
      ...eventDetails(event, userText),
      status: err.status,
      body: err.body,
      requestId: err.headers?.get?.('x-line-request-id') ?? err.headers?.['x-line-request-id'],
      error: errorDetails(err),
    });
    return;
  }

  console.error(prefix, {
    ...eventDetails(event, userText),
    error: errorDetails(err),
  });
}

function rememberWebhookEvent(webhookEventId) {
  if (!webhookEventId) return;

  handledWebhookEventIds.add(webhookEventId);
  inFlightWebhookEventIds.delete(webhookEventId);
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

function isExplanationRequest(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;

  return [
    /意味.*(教えて|知りたい|説明して)/u,
    /(英語|英文).*(なんて言う|どう言う|教えて|訳して)/u,
    /(この言葉|この単語|この表現|言葉|単語|表現).*(説明して|解説して)/u,
    /例文.*(作って|ください|ちょうだい|教えて)/u,
    /(翻訳して|訳して|和訳して|英訳して)/u,
    /文法.*(教えて|説明して|解説して)/u,
  ].some((pattern) => pattern.test(trimmed));
}

function buildAiPrompt(userMessage) {
  const lineStyleGuide = [
    'LINEのチャットで読みやすい日本語で返してください。',
    'Markdown記法は使わないでください。###、####、**太字**、>引用記号は禁止です。',
  ];

  if (isExplanationRequest(userMessage)) {
    lineStyleGuide.push(
      `辞書・解説モードとして、${LINE_REPLY_MAX_LENGTH}文字以内で返してください。`,
      '次の4項目だけを使ってください。',
      '【意味】',
      '【英語で言うと】',
      '【例文】',
      '【ひとこと】',
      '各項目は1から2文で簡潔にしてください。'
    );
  } else {
    lineStyleGuide.push(
      '普段の会話として自然に返してください。',
      '【意味】【英語で言うと】【例文】【ひとこと】などの見出しは絶対に使わないでください。',
      '返信は1から3文で短くしてください。',
      'ユーザーの気持ちや状況を受け止め、必要なら軽く次の一言を添えてください。'
    );
  }

  return `${lineStyleGuide.join('\n')}\n\nユーザーのメッセージ:\n${userMessage}`;
}

function formatLineReply(text) {
  const fallbackText = 'すみません、応答を生成できませんでした。もう一度試してください。';
  const cleaned = normalizeReplyText(text)
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/```+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const lineText = cleaned || fallbackText;
  return lineText.length > LINE_REPLY_MAX_LENGTH
    ? `${lineText.slice(0, LINE_REPLY_MAX_LENGTH - 4).trimEnd()}\n...`
    : lineText;
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
  if (!GEMINI_API_KEY || !genAI) {
    throw new Error('GEMINI_API_KEY is missing or empty');
  }

  console.log('AI呼び出し開始:', {
    aiProvider: AI_PROVIDER,
    aiModel: AI_MODEL,
    inputTextLength: userMessage.length,
    timeoutMs: Number(AI_TIMEOUT_MS),
  });

  const startedAt = Date.now();
  const response = await genAI.models.generateContent({
    model: AI_MODEL,
    contents: buildAiPrompt(userMessage),
  });

  console.log('AI呼び出し成功:', {
    aiProvider: AI_PROVIDER,
    aiModel: AI_MODEL,
    elapsedMs: Date.now() - startedAt,
    outputTextLength: String(response.text ?? '').length,
  });

  return formatLineReply(response.text);
}

async function handleEvent(event) {
  const eventId = event.webhookEventId ?? 'unknown';
  const isRedelivery = Boolean(event.deliveryContext?.isRedelivery);

  console.log('Webhookイベント受信:', {
    eventId,
    type: event.type,
    messageType: event.message?.type,
    isRedelivery,
    hasReplyToken: Boolean(event.replyToken),
  });

  if (event.webhookEventId && handledWebhookEventIds.has(event.webhookEventId)) {
    console.warn('処理済みWebhookイベントの再処理をスキップ:', { eventId, isRedelivery });
    return { eventId, status: 'skipped_duplicate' };
  }

  if (isRedelivery) {
    console.warn('LINE再送イベントを検出:', { eventId, alreadyHandled: false });
  }

  if (event.webhookEventId && inFlightWebhookEventIds.has(event.webhookEventId)) {
    console.warn('処理中Webhookイベントの再処理をスキップ:', { eventId, isRedelivery });
    return { eventId, status: 'skipped_in_flight' };
  }

  if (event.type !== 'message' || event.message?.type !== 'text') {
    console.log('返信対象外イベントを無視:', {
      eventId,
      eventType: event.type,
      messageType: event.message?.type,
    });
    rememberWebhookEvent(event.webhookEventId);
    return { eventId, status: 'ignored' };
  }

  if (!event.replyToken) {
    console.error('replyToken がないため返信できません:', { eventId });
    rememberWebhookEvent(event.webhookEventId);
    return { eventId, status: 'missing_reply_token' };
  }

  const userText = event.message.text;
  console.log('テキストメッセージ受信:', {
    eventId,
    eventType: event.type,
    messageType: event.message.type,
    userMessageText: userText,
    textLength: userText.length,
  });
  if (event.webhookEventId) inFlightWebhookEventIds.add(event.webhookEventId);

  let replyText;
  try {
    replyText = await withTimeout(askGemini(userText), Number(AI_TIMEOUT_MS), 'AI response');
  } catch (err) {
    logAiError(err, event, userText);
    replyText = 'すみません、エラーが発生しました。もう一度試してください。';
  }

  try {
    console.log('LINE返信開始:', {
      eventId,
      replyTextLength: formatLineReply(replyText).length,
      hasReplyToken: Boolean(event.replyToken),
    });

    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: formatLineReply(replyText) }],
    });

    console.log('LINE返信成功:', { eventId });
    rememberWebhookEvent(event.webhookEventId);
    return { eventId, status: 'replied' };
  } catch (err) {
    logLineError('LINE返信エラー:', err, event, userText);
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
    console.log('LINEイベント概要:', events.map((event) => ({
      eventId: event.webhookEventId ?? 'unknown',
      eventType: event.type,
      messageType: event.message?.type,
      isRedelivery: Boolean(event.deliveryContext?.isRedelivery),
      hasReplyToken: Boolean(event.replyToken),
    })));

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
