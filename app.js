/* =========================================================
 * AI 古人聊天室：孟子 — app.js
 * 互動核心邏輯：離線劇本播放、友情考核、AI 對話（Gemini / Groq / 課堂代理）
 * ========================================================= */

/* ---------- 老師設定區 ----------
 * PROXY_URL：部署 worker/worker.js 到 Cloudflare 後，把網址貼在這裡，
 *            學生就能用「課堂通關碼」或 QR Code（index.html?code=通關碼）免 Key 使用 AI。
 *            留空時，只能用「自備 API Key」開啟 AI 對話。
 */
const CONFIG = {
  PROXY_URL: "https://talkto.taboogirl.workers.dev",
  MAX_HISTORY: 16
};

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const els = {
  messages: $("messages"),
  chips: $("chips"),
  quizBtn: $("quizBtn"),
  composer: $("composer"),
  input: $("input"),
  sendBtn: $("sendBtn"),
  aiToggle: $("aiToggle"),
  statusDot: $("statusDot"),
  statusText: $("statusText"),
  modal: $("modal"),
  codeInput: $("codeInput"),
  keyInput: $("keyInput"),
  providerSelect: $("providerSelect"),
  proxyHint: $("proxyHint"),
  modalError: $("modalError"),
  modalOk: $("modalOk"),
  modalCancel: $("modalCancel")
};

/* ---------- 狀態 ---------- */
const state = {
  busy: false,
  lastSender: null,
  ai: null,            // { type: "proxy"|"gemini"|"groq", code?, key? }
  history: [],         // [{ role: "user"|"model", text }]
  topicOrder: {},      // 每個主題的隨機輪替順序
  quiz: null,
  geminiModels: null,
  groqModels: null
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });

/* =========================================================
 * 訊息渲染
 * ========================================================= */
function scrollToBottom() {
  requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
}

function makeRow(sender) {
  const row = document.createElement("div");
  row.className = `row ${sender}`;
  if (sender === "him") {
    if (state.lastSender === "him") row.classList.add("cont");
    const img = document.createElement("img");
    img.className = "mini";
    img.src = "assets/avatar.jpg";
    img.alt = "";
    row.appendChild(img);
  }
  state.lastSender = sender;
  return row;
}

function addText(sender, text) {
  const row = makeRow(sender);
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = now();
  if (sender === "me") row.append(time, bubble);
  else row.append(bubble, time);
  els.messages.appendChild(row);
  scrollToBottom();
  return row;
}

function addSticker(code) {
  const st = STICKERS[code];
  if (!st) return;
  const row = makeRow("him");
  const img = document.createElement("img");
  img.className = "sticker";
  img.src = st.src;
  img.alt = st.alt;
  img.addEventListener("load", scrollToBottom);
  row.appendChild(img);
  els.messages.appendChild(row);
  scrollToBottom();
}

function addNote(text) {
  const div = document.createElement("div");
  div.className = "system-note";
  div.textContent = text;
  els.messages.appendChild(div);
  state.lastSender = null;
  scrollToBottom();
}

function showTyping() {
  const prevSender = state.lastSender;
  const row = makeRow("him");
  row.classList.add("typing");
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = "<i></i><i></i><i></i>";
  row.appendChild(bubble);
  els.messages.appendChild(row);
  scrollToBottom();
  return () => {
    // 移除打字列後，恢復「上一位發話者」以便頭像正確顯示
    row.remove();
    state.lastSender = prevSender;
  };
}

/* 依序播放一組訊息（含打字動畫） */
async function playMessages(list) {
  for (const msg of list) {
    const len = msg.t ? msg.t.length : 10;
    const stop = showTyping();
    await sleep(Math.min(1800, 500 + len * 25));
    stop();
    if (msg.s) addSticker(msg.s);
    else addText("him", msg.t);
    await sleep(250);
  }
}

function setBusy(b) {
  state.busy = b;
  els.chips.querySelectorAll("button").forEach((btn) => (btn.disabled = b));
  els.sendBtn.disabled = b;
}

/* =========================================================
 * 離線主題劇本（隨機輪替、不連續重複）
 * ========================================================= */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextScript(topicKey) {
  const scripts = TOPICS[topicKey].scripts;
  let order = state.topicOrder[topicKey];
  if (!order || order.length === 0) {
    order = shuffle(scripts.map((_, i) => i));
    // 避免新一輪的第一則與上一輪最後一則相同
    if (order[0] === state.topicOrder[topicKey + "_last"] && order.length > 1) order.push(order.shift());
    state.topicOrder[topicKey] = order;
  }
  const idx = order.shift();
  state.topicOrder[topicKey + "_last"] = idx;
  return scripts[idx];
}

async function playTopic(topicKey) {
  if (state.busy) return;
  setBusy(true);
  addText("me", TOPICS[topicKey].label.replace(/^\S+\s/, "") + "～");
  await playMessages(nextScript(topicKey));
  setBusy(false);
}

/* =========================================================
 * 友情考核
 * ========================================================= */
async function startQuiz() {
  if (state.busy) return;
  setBusy(true);
  addText("me", "我要挑戰友情考核！");
  state.quiz = { list: shuffle(QUIZ), i: 0, score: 0 };
  await playMessages([
    { t: `好！軻出 ${QUIZ.length} 道題，看看小友是否真懂我。` },
    { s: "debate" }
  ]);
  askQuestion();
}

async function askQuestion() {
  const qz = state.quiz;
  const item = qz.list[qz.i];
  await playMessages([{ t: `第 ${qz.i + 1} 題：${item.q}` }]);

  const box = document.createElement("div");
  box.className = "options";
  item.options.forEach((opt, idx) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${"ABCD"[idx]}. ${opt}`;
    b.addEventListener("click", () => answerQuestion(idx, box));
    box.appendChild(b);
  });
  els.messages.appendChild(box);
  state.lastSender = null;
  scrollToBottom();
}

async function answerQuestion(choice, box) {
  const qz = state.quiz;
  const item = qz.list[qz.i];
  const buttons = box.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  buttons[item.answer].classList.add("correct");
  const ok = choice === item.answer;
  if (!ok) buttons[choice].classList.add("wrong");
  if (ok) qz.score++;

  addText("me", item.options[choice]);
  await playMessages([{ t: ok ? `✅ ${item.right}` : `❌ ${item.wrong}` }]);

  qz.i++;
  if (qz.i < qz.list.length) return askQuestion();

  const total = qz.list.length;
  const s = qz.score;
  let ending;
  if (s === total) ending = [{ s: "smile" }, { t: `全對！${s}/${total}！孺子可教也！小友堪稱孟門高徒，軻收你為入室弟子！` }];
  else if (s >= total - 2) ending = [{ s: "smile" }, { t: `${s}/${total}，相當不錯！再讀幾遍《孟子》，必能更上一層樓。` }];
  else ending = [{ s: "sigh" }, { t: `${s}/${total}……小友，「學問之道無他，求其放心而已矣」。把心收回來，再來挑戰一次吧！` }];
  await playMessages(ending);
  state.quiz = null;
  setBusy(false);
}

/* =========================================================
 * 離線自由輸入：關鍵字比對
 * ========================================================= */
function offlineReply(text) {
  const hit = KEYWORD_REPLIES.find((item) => item.k.some((k) => text.includes(k)));
  return hit ? hit.r : DEFAULT_OFFLINE_REPLY;
}

/* =========================================================
 * AI：Gemini（動態模型探索）
 * ========================================================= */
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_FALLBACK = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash", "gemini-2.5-flash-lite"];

async function discoverGeminiModels(key) {
  try {
    const res = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error("KEY");
    const data = await res.json();
    const score = (name) => {
      const v = parseFloat((name.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
      return v - (/preview|exp/.test(name) ? 0.05 : 0) - (/lite/.test(name) ? 0.02 : 0);
    };
    const list = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /gemini/.test(n) && /flash/.test(n) && !/(image|tts|audio|live|embed|vision|robotics|computer)/.test(n))
      .sort((a, b) => score(b) - score(a));
    return list.length ? list : GEMINI_FALLBACK;
  } catch (e) {
    if (e.message === "KEY") throw e;
    return GEMINI_FALLBACK;
  }
}

function toGeminiContents(history) {
  return history.map((h) => ({ role: h.role, parts: [{ text: h.text }] }));
}

async function callGemini(key, history) {
  if (!state.geminiModels) state.geminiModels = await discoverGeminiModels(key);
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: toGeminiContents(history),
    generationConfig: { temperature: 0.9, maxOutputTokens: 1024 }
  };
  let lastErr = "";
  for (const model of state.geminiModels.slice()) {
    const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
      if (text) {
        // 把成功的模型排到最前面
        state.geminiModels = [model, ...state.geminiModels.filter((m) => m !== model)];
        return text;
      }
      lastErr = "回覆內容為空";
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error("API Key 無效或沒有權限");
    lastErr = `${model}：HTTP ${res.status}`;
    // 404（模型已下架）、429（額度）、5xx（忙碌）→ 換下一個模型
  }
  throw new Error(`所有模型都暫時無法使用（${lastErr}）`);
}

/* =========================================================
 * AI：Groq（OpenAI 相容格式）
 * ========================================================= */
const GROQ_BASE = "https://api.groq.com/openai/v1";
const GROQ_PREFERRED = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "qwen/qwen3-32b", "llama-3.1-8b-instant"];

async function discoverGroqModels(key) {
  const res = await fetch(`${GROQ_BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (res.status === 401 || res.status === 403) throw new Error("KEY");
  if (!res.ok) return GROQ_PREFERRED;
  const ids = ((await res.json()).data || []).map((m) => m.id)
    .filter((id) => !/(whisper|guard|tts|embed|playai|distil)/i.test(id));
  const preferred = GROQ_PREFERRED.filter((id) => ids.includes(id));
  return [...preferred, ...ids.filter((id) => !preferred.includes(id))];
}

async function callGroq(key, history) {
  if (!state.groqModels) state.groqModels = await discoverGroqModels(key);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((h) => ({ role: h.role === "model" ? "assistant" : "user", content: h.text }))
  ];
  let lastErr = "";
  for (const model of state.groqModels.slice(0, 5)) {
    const res = await fetch(`${GROQ_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature: 0.9, max_tokens: 800 })
    });
    if (res.ok) {
      const data = await res.json();
      let text = (data.choices?.[0]?.message?.content || "").trim();
      text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (text) return text;
      lastErr = "回覆內容為空";
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error("API Key 無效或沒有權限");
    lastErr = `${model}：HTTP ${res.status}`;
  }
  throw new Error(`所有模型都暫時無法使用（${lastErr}）`);
}

/* =========================================================
 * AI：課堂代理（Cloudflare Worker，通關碼驗證）
 * ========================================================= */
async function callProxy(code, history, ping = false) {
  const res = await fetch(CONFIG.PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ping ? { passcode: code, ping: true } : {
      passcode: code,
      systemInstruction: SYSTEM_PROMPT,
      contents: toGeminiContents(history)
    })
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("通關碼錯誤");
  if (!res.ok) throw new Error(data.error || `代理伺服器錯誤 HTTP ${res.status}`);
  return ping ? true : (data.text || "").trim();
}

async function askAI(history) {
  const ai = state.ai;
  if (ai.type === "proxy") return callProxy(ai.code, history);
  if (ai.type === "gemini") return callGemini(ai.key, history);
  return callGroq(ai.key, history);
}

/* =========================================================
 * 送出訊息
 * ========================================================= */
async function handleSend(text) {
  text = text.trim();
  if (!text || state.busy) return;
  els.input.value = "";
  addText("me", text);
  setBusy(true);

  if (!state.ai) {
    await playMessages([{ t: offlineReply(text) }]);
    setBusy(false);
    return;
  }

  state.history.push({ role: "user", text });
  state.history = state.history.slice(-CONFIG.MAX_HISTORY);
  const stop = showTyping();
  try {
    const reply = await askAI(state.history);
    stop();
    state.history.push({ role: "model", text: reply });
    // 依段落拆成多個氣泡，更像手機聊天
    const parts = reply.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    addText("him", parts.shift() || reply);
    if (parts.length) await playMessages(parts.map((t) => ({ t })));
  } catch (err) {
    stop();
    state.history.pop();
    addNote(`⚠️ AI 暫時連不上：${err.message}。已改用離線回覆。`);
    await playMessages([{ t: offlineReply(text) }]);
  }
  setBusy(false);
  els.input.focus();
}

/* =========================================================
 * AI 模式切換與解鎖視窗
 * ========================================================= */
function setAIMode(ai) {
  state.ai = ai;
  state.history = [];
  state.geminiModels = null;
  state.groqModels = null;
  const on = !!ai;
  els.aiToggle.setAttribute("aria-pressed", String(on));
  els.aiToggle.textContent = on ? "🤖 AI 對話中" : "🤖 AI 對話";
  els.statusDot.classList.toggle("on", on);
  els.statusText.textContent = on ? "戰國・鄒國｜AI 線上" : "戰國・鄒國｜離線劇本模式";
  document.querySelectorAll(".chip.ai-only").forEach((c) => c.remove());
  if (on) {
    const extra = [
      ["⚔️ 辯論擂台", "孟夫子，我想跟您辯論！請先給我一個題目，或聽我說我的主張。"],
      ["🎯 名句抽考", "孟夫子，請抽考我一句《孟子》名句！"],
      ["💪 浩然之氣補給站", "孟夫子，我最近有點煩惱，想聽聽您的建議。"]
    ];
    extra.forEach(([label, prompt]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip ai-only";
      b.textContent = label;
      b.addEventListener("click", () => handleSend(prompt));
      els.chips.prepend(b);
    });
  }
}

function openModal() {
  els.modalError.textContent = "";
  els.codeInput.value = localStorage.getItem("mencius_code") || "";
  els.proxyHint.textContent = CONFIG.PROXY_URL
    ? "通關碼由老師的代理伺服器驗證，不會暴露任何金鑰。"
    : "⚠️ 老師尚未設定課堂代理伺服器（app.js 的 PROXY_URL），目前請改用「自備 API Key」。";
  els.modal.hidden = false;
}

function closeModal() { els.modal.hidden = true; }

function activeTab() {
  return document.querySelector(".tab.active").dataset.tab;
}

async function unlock() {
  els.modalError.textContent = "";
  els.modalOk.disabled = true;
  try {
    if (activeTab() === "code") {
      const code = els.codeInput.value.trim();
      if (!code) throw new Error("請輸入通關碼");
      if (!CONFIG.PROXY_URL) throw new Error("老師尚未設定代理伺服器，請改用自備 API Key");
      await callProxy(code, [], true);
      localStorage.setItem("mencius_code", code);
      setAIMode({ type: "proxy", code });
    } else {
      const key = els.keyInput.value.trim();
      const provider = els.providerSelect.value;
      if (!key) throw new Error("請貼上 API Key");
      if (provider === "gemini") await discoverGeminiModels(key);
      else await discoverGroqModels(key);
      sessionStorage.setItem("mencius_key", JSON.stringify({ provider, key }));
      setAIMode({ type: provider, key });
    }
    closeModal();
    addNote("🔓 AI 自由對話已開啟，可以直接跟孟子辯論了！");
    await playMessages([{ t: "哦？小友想與軻暢談？好！有什麼疑問儘管問，有什麼不服儘管辯！" }, { s: "debate" }]);
  } catch (err) {
    els.modalError.textContent = err.message === "KEY" ? "API Key 無效，請再確認一次" : err.message;
  } finally {
    els.modalOk.disabled = false;
  }
}

/* =========================================================
 * 初始化
 * ========================================================= */
function bindEvents() {
  els.chips.querySelectorAll(".chip[data-topic]").forEach((chip) =>
    chip.addEventListener("click", () => playTopic(chip.dataset.topic))
  );
  els.quizBtn.addEventListener("click", startQuiz);
  els.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    handleSend(els.input.value);
  });
  els.aiToggle.addEventListener("click", () => {
    if (state.ai) {
      setAIMode(null);
      sessionStorage.removeItem("mencius_key");
      addNote("已切回離線劇本模式");
    } else openModal();
  });
  els.modalCancel.addEventListener("click", closeModal);
  els.modalOk.addEventListener("click", unlock);
  els.modal.addEventListener("click", (e) => { if (e.target === els.modal) closeModal(); });
  [els.codeInput, els.keyInput].forEach((inp) =>
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); })
  );
  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
      els.modalError.textContent = "";
    })
  );
  // 虛擬鍵盤彈出時保持最新訊息可見
  if (window.visualViewport) window.visualViewport.addEventListener("resize", scrollToBottom);
  els.input.addEventListener("focus", () => setTimeout(scrollToBottom, 300));
}

async function init() {
  bindEvents();

  const pill = document.createElement("div");
  pill.className = "date-pill";
  pill.innerHTML = "<span>今天</span>";
  els.messages.appendChild(pill);

  // URL 帶參免密登入：index.html?code=通關碼
  const urlCode = new URLSearchParams(location.search).get("code");
  if (urlCode) localStorage.setItem("mencius_code", urlCode);

  setBusy(true);
  await playMessages([
    { t: "小友有禮！吾乃鄒人孟軻。" },
    { s: "smile" },
    { t: "點選下方主題聽我說故事，或按「🏆 友情考核」看看你有多懂我！" }
  ]);
  setBusy(false);

  // 恢復 AI 狀態：QR Code 通關碼 → 代理；同分頁已填過的 Key
  const saved = sessionStorage.getItem("mencius_key");
  if (urlCode && CONFIG.PROXY_URL) {
    try {
      await callProxy(urlCode, [], true);
      setAIMode({ type: "proxy", code: urlCode });
      addNote("🔓 已透過課堂 QR Code 自動開啟 AI 對話");
    } catch (err) {
      addNote(`通關碼驗證失敗：${err.message}`);
    }
  } else if (saved) {
    try {
      const { provider, key } = JSON.parse(saved);
      setAIMode({ type: provider, key });
      addNote("🔓 AI 對話已恢復");
    } catch { sessionStorage.removeItem("mencius_key"); }
  }
}

init();
