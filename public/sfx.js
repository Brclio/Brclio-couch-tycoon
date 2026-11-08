// 音效全部用 WebAudio 现场合成，没有音频文件。语音播报用浏览器自带的 speechSynthesis。

let ac = null;
let master = null;
const prefs = { sound: true, voice: true };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('mf_sfx') || '{}')); } catch {}

export const getPrefs = () => ({ ...prefs });
export function setPref(k, v) {
  prefs[k] = v;
  try { localStorage.setItem('mf_sfx', JSON.stringify(prefs)); } catch {}
  if (k === 'voice' && !v) stopSpeech();
}

// 浏览器要求用户点过页面才能出声
export function unlock() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain();
    master.gain.value = 0.55;
    master.connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume();
}

const ok = () => prefs.sound && ac && ac.state === 'running';

function tone(freq, start, dur, { type = 'sine', vol = 0.3, slide = 0, attack = 0.005 } = {}) {
  const t = ac.currentTime + start;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise(start, dur, { vol = 0.25, freq = 2000, q = 1, type = 'bandpass', sweep = 0 } = {}) {
  const t = ac.currentTime + start;
  const len = Math.ceil(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
  src.buffer = buf;
  f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(60, freq + sweep), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t); src.stop(t + dur);
}

export const sfx = {
  // 骰子在桌上滚
  dice() {
    if (!ok()) return;
    for (let k = 0; k < 9; k++) {
      const at = k * 0.075 + Math.random() * 0.03;
      noise(at, 0.05, { vol: 0.35 - k * 0.025, freq: 1800 + Math.random() * 1500, q: 4 });
      tone(500 + Math.random() * 400, at, 0.04, { type: 'triangle', vol: 0.08 });
    }
  },
  // 棋子落一格
  step(k = 0) {
    if (!ok()) return;
    tone(520 + (k % 2) * 90, 0, 0.07, { type: 'triangle', vol: 0.18, slide: 160 });
  },
  // 钱进口袋：一串硬币
  coinIn() {
    if (!ok()) return;
    [0, 0.07, 0.14].forEach((at, k) => {
      tone(1568 + k * 120, at, 0.12, { type: 'square', vol: 0.07 });
      tone(2093 + k * 160, at + 0.04, 0.22, { type: 'square', vol: 0.06 });
    });
  },
  // 钱交出去：收银机「咔嚓」
  register() {
    if (!ok()) return;
    noise(0, 0.06, { vol: 0.4, freq: 3000, q: 2 });
    noise(0.07, 0.05, { vol: 0.3, freq: 1500, q: 3 });
    tone(2637, 0.12, 0.35, { type: 'sine', vol: 0.22 });
    tone(3520, 0.12, 0.3, { type: 'sine', vol: 0.1 });
  },
  // 钱飞出去的「嗖」
  whoosh() {
    if (!ok()) return;
    noise(0, 0.35, { vol: 0.18, freq: 600, q: 0.8, sweep: 2400 });
  },
  // 翻牌
  flip() {
    if (!ok()) return;
    noise(0, 0.18, { vol: 0.3, freq: 4000, q: 0.7, sweep: -3000 });
    tone(300, 0.02, 0.12, { type: 'triangle', vol: 0.1, slide: 300 });
  },
  // 好消息：上行琶音
  happy() {
    if (!ok()) return;
    [523, 659, 784, 1047].forEach((f, k) => tone(f, k * 0.09, 0.3, { type: 'triangle', vol: 0.22 }));
    tone(1568, 0.38, 0.5, { type: 'sine', vol: 0.12 });
  },
  // 坏消息：「哇哇哇哇~」
  sad() {
    if (!ok()) return;
    [392, 370, 349].forEach((f, k) => tone(f, k * 0.28, 0.26, { type: 'sawtooth', vol: 0.09 }));
    tone(330, 0.84, 0.7, { type: 'sawtooth', vol: 0.09, slide: -60 });
  },
  neutral() {
    if (!ok()) return;
    tone(660, 0, 0.18, { type: 'triangle', vol: 0.18 });
    tone(880, 0.12, 0.25, { type: 'triangle', vol: 0.15 });
  },
  // 监狱铁门
  jail() {
    if (!ok()) return;
    noise(0, 0.5, { vol: 0.45, freq: 260, q: 6 });
    [180, 233, 371, 517].forEach(f => tone(f, 0, 0.8, { type: 'square', vol: 0.05 }));
  },
  // 盖房：敲锤子
  build() {
    if (!ok()) return;
    [0, 0.13].forEach(at => { noise(at, 0.06, { vol: 0.5, freq: 900, q: 5 }); tone(180, at, 0.08, { vol: 0.25 }); });
    tone(1047, 0.28, 0.25, { type: 'triangle', vol: 0.15 });
  },
  // 买地盖章
  stamp() {
    if (!ok()) return;
    tone(110, 0, 0.18, { vol: 0.5, slide: -50 });
    noise(0, 0.08, { vol: 0.3, freq: 500, q: 1 });
    tone(784, 0.15, 0.2, { type: 'triangle', vol: 0.15 });
    tone(1175, 0.24, 0.3, { type: 'triangle', vol: 0.15 });
  },
  // 轮到下一位
  turn() {
    if (!ok()) return;
    tone(988, 0, 0.25, { type: 'sine', vol: 0.15 });
    tone(1319, 0.1, 0.35, { type: 'sine', vol: 0.12 });
  },
  // 弹框出现
  pop() {
    if (!ok()) return;
    tone(440, 0, 0.12, { type: 'sine', vol: 0.18, slide: 440 });
  },
  beep(last = false) {
    if (!ok()) return;
    tone(last ? 1175 : 784, 0, last ? 0.6 : 0.18, { type: 'square', vol: 0.08 });
  },
  win() {
    if (!ok()) return;
    [523, 659, 784, 1047, 784, 1047].forEach((f, k) => tone(f, k * 0.12, 0.3, { type: 'square', vol: 0.07 }));
    tone(1047, 0.75, 0.9, { type: 'triangle', vol: 0.2 });
  },
};

// 语音播报：优先用服务器上的 Gemini 语音（/tts，有缓存），拿不到再用浏览器自带的中文语音
let zhVoice = null;
function pickVoice() {
  const vs = window.speechSynthesis?.getVoices() || [];
  zhVoice = vs.find(v => /zh[-_]CN/i.test(v.lang)) || vs.find(v => /^zh/i.test(v.lang)) || null;
}
if (window.speechSynthesis) {
  pickVoice();
  window.speechSynthesis.onvoiceschanged = pickVoice;
}

const norm = (text) => text.replace(/\$([\d,]+)/g, (_, n) => `${n.replace(/,/g, '')} 元`);
const clips = new Map();   // 一句话 → Promise<Audio | null>
let geminiOk = true;       // 服务器说没配密钥，就不再请求
let playing = null;
let seq = 0;

function load(text) {
  const t = norm(text);
  if (!clips.has(t)) {
    clips.set(t, (async () => {
      if (!geminiOk) return null;
      try {
        const r = await fetch(`/tts?t=${encodeURIComponent(t)}`);
        if (r.status === 503) geminiOk = false;
        if (!r.ok) throw new Error(r.status);
        return new Audio(URL.createObjectURL(await r.blob()));
      } catch {
        clips.delete(t);
        return null;
      }
    })());
  }
  return clips.get(t);
}

// 提前合成，弹框出来时直接播
export function prefetchSpeech(text) {
  if (prefs.voice) load(text);
}

function browserSpeak(t) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(t);
  u.lang = 'zh-CN';
  if (zhVoice) u.voice = zhVoice;
  u.rate = 1.05;
  window.speechSynthesis.speak(u);
}

export function stopSpeech() {
  seq++;
  if (playing) { playing.pause(); playing = null; }
  window.speechSynthesis?.cancel();
}

export async function speak(text) {
  if (!prefs.voice || !text) return;
  stopSpeech();
  const my = seq;
  const audio = await Promise.race([load(text), new Promise(r => setTimeout(() => r('late'), 6000))]);
  if (my !== seq) return;                       // 已经点过去了，别再念
  if (audio === null) return browserSpeak(norm(text));
  if (audio === 'late') return;
  audio.currentTime = 0;
  audio.volume = 1;
  playing = audio;
  audio.play().catch(() => browserSpeak(norm(text)));
}
