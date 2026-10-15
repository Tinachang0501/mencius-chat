/**
 * 孟子聊天室｜課堂代理 Cloudflare Worker
 *
 * 用途：學生只需輸入「課堂通關碼」即可使用 AI，老師的 Gemini API Key 永遠不會出現在網頁上。
 *
 * 部署步驟（Cloudflare 後台 → Workers & Pages → Create Worker）：
 *   1. 貼上本檔內容並部署。
 *   2. 到 Settings → Variables and Secrets 新增：
 *        GEMINI_API_KEY   （Secret）老師的 Gemini API Key
 *        CLASS_PASSCODE   （Secret）課堂通關碼，例如 6 位數字
 *        ALLOWED_ORIGIN   （選填）允許的網站網址，例如 https://xxx.github.io ；留空代表不限制
 *   3. 把 Worker 網址貼到 app.js 的 CONFIG.PROXY_URL。
 *   4. 上課投影 QR Code：你的網址/index.html?code=通關碼
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const FALLBACK = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash", "gemini-2.5-flash-lite"];
let cachedModels = null;
let cachedAt = 0;

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(env, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(env) }
  });
}

async function discoverModels(key) {
  if (cachedModels && Date.now() - cachedAt < 6 * 3600 * 1000) return cachedModels;
  try {
    const res = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
    const data = await res.json();
    const score = (n) => {
      const v = parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
      return v - (/preview|exp/.test(n) ? 0.05 : 0) - (/lite/.test(n) ? 0.02 : 0);
    };
    const list = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /gemini/.test(n) && /flash/.test(n) && !/(image|tts|audio|live|embed|vision|robotics|computer)/.test(n))
      .sort((a, b) => score(b) - score(a));
    cachedModels = list.length ? list : FALLBACK;
  } catch {
    cachedModels = FALLBACK;
  }
  cachedAt = Date.now();
  return cachedModels;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    if (request.method !== "POST") return json(env, 405, { error: "只接受 POST" });

    let body;
    try { body = await request.json(); } catch { return json(env, 400, { error: "格式錯誤" }); }

    if (!env.CLASS_PASSCODE || String(body.passcode || "") !== String(env.CLASS_PASSCODE)) {
      return json(env, 401, { error: "通關碼錯誤" });
    }
    if (body.ping) return json(env, 200, { ok: true });

    const contents = Array.isArray(body.contents) ? body.contents.slice(-16) : [];
    if (!contents.length) return json(env, 400, { error: "沒有對話內容" });

    const payload = {
      systemInstruction: { parts: [{ text: String(body.systemInstruction || "").slice(0, 6000) }] },
      contents,
      generationConfig: { temperature: 0.9, maxOutputTokens: 1024 }
    };

    const models = await discoverModels(env.GEMINI_API_KEY);
    let lastErr = "";
    for (const model of models) {
      const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json();
        const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
        if (text) return json(env, 200, { text, model });
        lastErr = "回覆內容為空";
        continue;
      }
      lastErr = `${model} HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) break;
    }
    return json(env, 502, { error: `AI 暫時無法回覆（${lastErr}）` });
  }
};
