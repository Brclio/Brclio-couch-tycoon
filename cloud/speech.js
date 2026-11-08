// Browsers can play PCM WAV directly; Workers do not need a local ffmpeg binary.
function wav(pcm) {
  const bytes = new Uint8Array(44 + pcm.length),
    view = new DataView(bytes.buffer);
  const tag = (at, text) => bytes.set(new TextEncoder().encode(text), at);
  tag(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  // Speed up narration as in the original server.
  const sampleRate = Math.round(24000 * 1.15);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, pcm.length, true);
  bytes.set(pcm, 44);
  return bytes;
}

export async function speech(req, env, ctx) {
  if (req.method !== 'GET') return new Response(null, { status: 405 });
  if (!env.GEMINI_API_KEY) return Response.json({ error: '使用浏览器语音' }, { status: 503 });
  const text = (new URL(req.url).searchParams.get('t') || '').trim();
  if (!text || text.length > 120) return new Response(null, { status: 400 });
  const cache = caches.default,
    hit = await cache.match(req);
  if (hit) return hit;
  if (
    env.SPEECH_LIMIT &&
    !(await env.SPEECH_LIMIT.limit({ key: req.headers.get('CF-Connecting-IP') || 'local' })).success
  )
    return new Response(null, { status: 429 });
  const model = env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) +
      ':generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: '用热情、轻快的语气，一字不差地朗读：' + text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.GEMINI_VOICE || 'Charon' } } },
        },
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const data = response.ok && (await response.json()).candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!data) return new Response(null, { status: 502 });
  const pcm = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const result = new Response(wav(pcm), {
    headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'public,max-age=31536000' },
  });
  ctx.waitUntil(cache.put(req, result.clone()));
  return result;
}
