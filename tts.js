// 语音播报：服务器调 Gemini TTS，转成 mp3 存在 cache/tts/，同一句话只合成一次。
// 密钥放在 大富翁/.env 的 GEMINI_API_KEY（和视频流水线 common/视频模板/build/.env.txt 用的是同一个）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { execSync } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(ROOT, 'cache', 'tts');
fs.mkdirSync(CACHE, { recursive: true });

const env = {};
try {
  for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const i = l.indexOf('=');
    if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
} catch {}
const KEY = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY;
const VOICE = process.env.GEMINI_VOICE || env.GEMINI_VOICE || 'Charon';
const MODEL = 'gemini-2.5-flash-preview-tts';
const TEMPO = 1.15;
const STYLE = '用热情、轻快的语气，一字不差地朗读：';

export const ttsEnabled = !!KEY;

// Node 的 fetch 默认不走代理。连 Google 要走本机代理：先看 HTTPS_PROXY，没有就读 macOS 系统代理设置
function proxyFromSystem() {
  try {
    const out = execSync('scutil --proxy', { encoding: 'utf8' });
    const get = (k) => out.match(new RegExp(`${k} : (\\S+)`))?.[1];
    if (get('HTTPSEnable') === '1') return `http://${get('HTTPSProxy')}:${get('HTTPSPort')}`;
  } catch {}
  return null;
}
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || proxyFromSystem();
if (proxy && http.setGlobalProxyFromEnv) {
  http.setGlobalProxyFromEnv({ HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,::1' });
}
const pending = new Map();

const fileFor = (text) => path.join(CACHE, crypto.createHash('sha1').update(VOICE + '|' + text).digest('hex').slice(0, 16) + '.mp3');

async function synth(text, out) {
  // 偶尔模型会回文字不回音频（400），重试一次
  try { return await synthOnce(text, out); } catch (e) { if (!/^Gemini (400|500|503)/.test(e.message)) throw e; }
  return synthOnce(text, out);
}

async function synthOnce(text, out) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: STYLE + text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const data = j.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!data) throw new Error('Gemini 没有返回音频');
  const pcm = Buffer.from(data, 'base64');
  // 24kHz 16bit 单声道 PCM → 稍微加快 → mp3
  const tmp = out + '.tmp.mp3';
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
      '-af', `atempo=${TEMPO}`, '-b:a', '64k', tmp]);
    ff.on('error', reject);
    ff.on('close', code => code ? reject(new Error('ffmpeg 失败')) : resolve());
    ff.stdin.end(pcm);
  });
  fs.renameSync(tmp, out);
}

// 返回 mp3 文件路径；同一句话并发请求只合成一次
export function getSpeech(text) {
  const out = fileFor(text);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (!pending.has(out)) {
    pending.set(out, synth(text, out).finally(() => pending.delete(out)));
  }
  return pending.get(out).then(() => out);
}

// 开服时把 24 句卡牌播报先合成好（和 play.js 的 lineFor、sfx.js 的 norm 保持同样的文字）
export async function warmCards(cards) {
  if (!KEY) return;
  const lines = [];
  for (const c of cards) for (const deck of ['机会', '命运']) lines.push(`${deck}：${c.text}`.replace(/\$([\d,]+)/g, (_, n) => `${n.replace(/,/g, '')} 元`));
  lines.push('语音播报已打开');
  let made = 0;
  for (const l of lines) {
    if (fs.existsSync(fileFor(l))) continue;
    try { await getSpeech(l); made++; } catch (e) { console.error('tts 预热失败', e.message); break; }
  }
  if (made) console.log(`tts 预热：新合成 ${made} 句`);
}
