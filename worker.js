// Iskra backend — Cloudflare Worker
// Routes:
//   POST /webhook      Telegram bot webhook
//   GET  /api/state     read the task list (auth: X-Telegram-Init-Data header)
//   PUT  /api/state     write the task list (auth: X-Telegram-Init-Data header)
// Scheduled: daily Gemini-written progress note, pushed via Telegram.
//
// Required bindings (set in the Cloudflare dashboard, no code changes needed):
//   KV namespace  -> TASKS_KV
//   Secret        -> BOT_TOKEN            (the Telegram bot token)
//   Secret        -> GEMINI_API_KEY       (Google AI Studio key)
//   Secret        -> WEBHOOK_SECRET       (any random string you invent)
//   Var           -> ALLOWED_TG_ID        (your numeric Telegram id, e.g. 453006062)
//   Var           -> ALLOWED_ORIGIN       (e.g. https://evgenikala.github.io)

const KV_KEY = "state";

const GOAL = {
  title: "Новый год в Таиланде",
  description: "Долгосрочный отпуск удалённого сотрудника: встретить Новый год в Таиланде и выстроить инфраструктуру для релокации.",
  targetDate: "2026-12-31",
};

function emptyState() {
  return { tasks: [], completedDates: {}, totalCompleted: 0, goal: GOAL };
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data",
  };
}

function json(data, init, origin) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(origin ? corsHeaders(origin) : {}),
      ...(init && init.headers ? init.headers : {}),
    },
  });
}

// ---------- Telegram WebApp initData validation ----------

async function hmacSha256(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, msgBytes));
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function validateInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(k + "=" + v);
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const enc = new TextEncoder();
  const secretKey = await hmacSha256(enc.encode("WebAppData"), enc.encode(botToken));
  const computed = toHex(await hmacSha256(secretKey, enc.encode(dataCheckString)));
  if (computed !== hash) return null;

  const authDate = parseInt(params.get("auth_date") || "0", 10);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  const userJson = params.get("user");
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch (e) {
    return null;
  }
}

// ---------- date helpers (Moscow, UTC+3, fixed offset) ----------

function mskParts(d) {
  const msk = new Date(d.getTime() + 3 * 3600 * 1000);
  return {
    y: msk.getUTCFullYear(), mo: msk.getUTCMonth(), da: msk.getUTCDate(),
    h: msk.getUTCHours(), mi: msk.getUTCMinutes(),
  };
}

function mskDateKey(d) {
  const p = mskParts(d);
  return p.y + "-" + String(p.mo + 1).padStart(2, "0") + "-" + String(p.da).padStart(2, "0");
}

function mskNowLabel() {
  const p = mskParts(new Date());
  return String(p.h).padStart(2, "0") + ":" + String(p.mi).padStart(2, "0");
}

// "HH:MM" in Moscow time -> absolute ms timestamp (today, or tomorrow if already passed)
function remindAtFromTime(hhmm) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  const hour = parseInt(m[1], 10), min = parseInt(m[2], 10);
  const now = new Date();
  const p = mskParts(now);
  // build the target instant as a UTC timestamp equal to "MSK date/time minus 3h"
  let target = Date.UTC(p.y, p.mo, p.da, hour - 3, min, 0, 0);
  if (target <= now.getTime()) target += 86400000; // already passed today -> tomorrow
  return target;
}

function computeStreak(completedDates) {
  let cursor = new Date();
  if (!completedDates[mskDateKey(cursor)]) cursor = new Date(cursor.getTime() - 86400000);
  let streak = 0;
  while (completedDates[mskDateKey(cursor)] > 0) {
    streak++;
    cursor = new Date(cursor.getTime() - 86400000);
  }
  return streak;
}

// ---------- KV state helpers ----------

async function loadState(env) {
  const raw = await env.TASKS_KV.get(KV_KEY);
  if (!raw) return emptyState();
  try {
    const s = JSON.parse(raw);
    return {
      tasks: Array.isArray(s.tasks) ? s.tasks : [],
      completedDates: s.completedDates && typeof s.completedDates === "object" ? s.completedDates : {},
      totalCompleted: typeof s.totalCompleted === "number" ? s.totalCompleted : 0,
      goal: GOAL,
    };
  } catch (e) {
    return emptyState();
  }
}

async function saveState(env, state) {
  await env.TASKS_KV.put(KV_KEY, JSON.stringify(state));
}

function uid() {
  return "t" + Date.now() + "-" + Math.floor(Math.random() * 100000);
}

function markTaskDone(state, task) {
  task.done = true;
  task.doneAt = Date.now();
  const k = mskDateKey(new Date());
  state.completedDates[k] = (state.completedDates[k] || 0) + 1;
  state.totalCompleted += 1;
}

// ---------- Gemini ----------

async function geminiJSON(env, prompt) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=" +
    env.GEMINI_API_KEY;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });
  if (!res.ok) throw new Error("gemini http " + res.status);
  const data = await res.json();
  const text =
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;
  if (!text) throw new Error("gemini: empty response");
  return text;
}

async function classifyMessage(env, message) {
  const prompt =
    'Ты помощник в приложении для задач "Искра". Сейчас в Москве ' + mskNowLabel() + '. ' +
    "Пользователь написал сообщение боту в Telegram. " +
    'У пользователя есть долгосрочная цель: "' + GOAL.title + '" — ' + GOAL.description +
    " (к " + GOAL.targetDate + "). Сюда относится всё, что двигает переезд: виза/легальные вопросы, " +
    "финансы и накопления, договорённости с работодателем об удалённой работе из другой страны, " +
    "жильё, перелёты, страховка, язык, вещи и логистика переезда. " +
    "Определи тип сообщения: " +
    '"task" — новая задача, которую нужно добавить в список; ' +
    '"report" — отчёт о том, что что-то уже сделано/выполнено; ' +
    '"other" — что угодно ещё (вопрос, реплика не по теме). ' +
    'Если пользователь явно просит напомнить в конкретное время (например "в 15:00", "в 3 часа дня", "через час") ' +
    'и это задача (не отчёт) — вычисли время как московское время в формате HH:MM (24ч) и положи в поле "time", иначе "time": null. ' +
    'В поле "text" положи только суть дела, без служебных слов вроде "добавь задачу", "напомни", "напиши в список" и без указания времени. ' +
    'В поле "goal_related" — true, если дело относится к цели переезда в Таиланд (см. выше), иначе false. ' +
    'Ответь СТРОГО одним JSON-объектом без пояснений и без markdown-разметки, формат: ' +
    '{"type":"task|report|other","text":"краткая формулировка задачи или сделанного","time":"HH:MM"|null,"goal_related":true|false}. ' +
    'Сообщение: "' + message.replace(/"/g, "'") + '"';

  const raw = await geminiJSON(env, prompt);
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed.type || !parsed.text) throw new Error("bad shape");
  return parsed;
}

function newTask(text) {
  return {
    id: uid(), text: text, done: false, doneAt: null, why: "",
    quick: false, steps: [], elapsed: 0, timerRunning: false, createdAt: Date.now(),
    remindAt: null, reminded: false, staleNotified: false, goalTagged: false,
  };
}

async function sendTelegram(env, chatId, text) {
  await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// ---------- webhook handling ----------

async function handleWebhook(request, env) {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });

  const update = await request.json();
  const msg = update.message;
  if (!msg || !msg.text) return new Response("ok");

  const fromId = msg.from && msg.from.id;
  if (String(fromId) !== String(env.ALLOWED_TG_ID)) {
    // silently ignore anyone else
    return new Response("ok");
  }

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  if (!text) return new Response("ok");

  if (text.startsWith("/")) {
    if (text === "/start") {
      await sendTelegram(
        env, chatId,
        "Привет! Пиши сюда обычным текстом — новую задачу или отчёт о том, что уже сделано — и я добавлю это в Искру."
      );
    }
    return new Response("ok");
  }

  const state = await loadState(env);
  let reply;

  try {
    const parsed = await classifyMessage(env, text);

    if (parsed.type === "report") {
      const needle = parsed.text.toLowerCase();
      const match = state.tasks.find(
        (t) => !t.done && (t.text.toLowerCase().includes(needle) || needle.includes(t.text.toLowerCase()))
      );
      if (match) {
        markTaskDone(state, match);
        if (parsed.goal_related) match.goalTagged = true;
        reply = "Отметила выполненной: «" + match.text + "»." + (match.goalTagged ? " Ещё один шаг к Таиланду." : "");
      } else {
        const t = newTask(parsed.text);
        t.goalTagged = !!parsed.goal_related;
        state.tasks.push(t);
        markTaskDone(state, t);
        reply = "Не нашла такую в списке, но записала как выполненную: «" + parsed.text + "»." + (t.goalTagged ? " Ещё один шаг к Таиланду." : "");
      }
    } else {
      const t = newTask(parsed.text);
      t.goalTagged = !!parsed.goal_related;
      let timeNote = "";
      if (parsed.time) {
        const remindAt = remindAtFromTime(parsed.time);
        if (remindAt) {
          t.remindAt = remindAt;
          timeNote = " Напомню в " + parsed.time + ".";
        }
      }
      state.tasks.push(t);
      reply = "Добавила задачу: «" + parsed.text + "»." + (t.goalTagged ? " Отметила как шаг к Таиланду." : "") + timeNote;
    }
  } catch (e) {
    const t = newTask(text);
    state.tasks.push(t);
    reply = "Записала как задачу: «" + text + "».";
  }

  await saveState(env, state);
  await sendTelegram(env, chatId, reply);
  return new Response("ok");
}

// ---------- API handling ----------

async function handleApiState(request, env) {
  const origin = env.ALLOWED_ORIGIN;
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }

  const initData = request.headers.get("X-Telegram-Init-Data");
  const user = await validateInitData(initData, env.BOT_TOKEN);
  if (!user || String(user.id) !== String(env.ALLOWED_TG_ID)) {
    return json({ error: "unauthorized" }, { status: 401 }, origin);
  }

  if (request.method === "GET") {
    const state = await loadState(env);
    return json(state, { status: 200 }, origin);
  }

  if (request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad json" }, { status: 400 }, origin);
    }
    if (!body || !Array.isArray(body.tasks)) {
      return json({ error: "bad shape" }, { status: 400 }, origin);
    }
    const state = {
      tasks: body.tasks,
      completedDates: body.completedDates && typeof body.completedDates === "object" ? body.completedDates : {},
      totalCompleted: typeof body.totalCompleted === "number" ? body.totalCompleted : 0,
      goal: GOAL, // server-owned, the app can't overwrite it
    };
    await saveState(env, state);
    return json({ ok: true }, { status: 200 }, origin);
  }

  return json({ error: "method not allowed" }, { status: 405 }, origin);
}

// ---------- scheduled analysis + push ----------

async function runDailyAnalysis(env) {
  const state = await loadState(env);
  const today = mskDateKey(new Date());
  const doneToday = state.completedDates[today] || 0;
  const streak = computeStreak(state.completedDates);
  const openTasks = state.tasks.filter((t) => !t.done).length;

  const prompt =
    "Ты дружелюбный, тёплый, но не приторный помощник в приложении для задач \"Искра\". " +
    "Вот статистика пользователя за сегодня: выполнено сегодня — " + doneToday +
    ", цепочка дней подряд — " + streak +
    ", открытых задач в списке — " + openTasks + ", всего выполнено за всё время — " + state.totalCompleted + ". " +
    "Напиши короткое (2-3 предложения) сообщение на русском: коротко отметь прогресс и мягко замотивируй на завтра. " +
    "Без markdown, без emoji через силу (1 эмодзи максимум, если уместно), без канцелярита. Ответь только текстом сообщения.";

  let text;
  try {
    text = (await geminiJSON(env, prompt)).trim();
  } catch (e) {
    text =
      doneToday > 0
        ? "Сегодня выполнено задач: " + doneToday + ". Цепочка дней: " + streak + ". Продолжай в том же духе."
        : "Сегодня пока пусто. Открой Искру и добавь хотя бы одну маленькую задачу — это лучше, чем ничего.";
  }

  await sendTelegram(env, env.ALLOWED_TG_ID, text);
}

// ---------- morning plan ----------

async function morningPlan(env) {
  const state = await loadState(env);
  const open = state.tasks.filter((t) => !t.done);
  const streak = computeStreak(state.completedDates);

  let text;
  if (!open.length) {
    text = "Доброе утро. Список задач пуст" + (streak > 0 ? " — цепочка дней (" + streak + ") ждёт хотя бы одну маленькую задачу сегодня." : ". Самое время закинуть пару дел.");
  } else {
    const lines = open.slice(0, 10).map((t) => "• " + t.text);
    text = "Доброе утро. На сегодня открыто задач: " + open.length + (streak > 0 ? " · цепочка: " + streak + " дн." : "") + "\n" + lines.join("\n");
    if (open.length > 10) text += "\n…и ещё " + (open.length - 10) + ".";
  }
  await sendTelegram(env, env.ALLOWED_TG_ID, text);
}

// ---------- streak-saver ----------

async function streakSaver(env) {
  const state = await loadState(env);
  const today = mskDateKey(new Date());
  const doneToday = state.completedDates[today] || 0;
  if (doneToday > 0) return; // already safe today

  const yesterday = new Date(Date.now() - 86400000);
  const priorStreak = state.completedDates[mskDateKey(yesterday)] > 0 ? computeStreak(state.completedDates) : 0;

  const text = priorStreak > 0
    ? "Сегодня ещё пусто, а цепочка дней — " + priorStreak + ". Заверши что-то маленькое, чтобы не потерять её."
    : "Сегодня пока ничего не отмечено. Маленький шаг сейчас — и цепочка дней начнётся заново.";

  await sendTelegram(env, env.ALLOWED_TG_ID, text);
}

// ---------- timed reminders + stale tasks (runs every 15 min) ----------

async function checkTimedReminders(env) {
  const state = await loadState(env);
  const now = Date.now();
  let changed = false;

  for (const t of state.tasks) {
    if (!t.done && t.remindAt && !t.reminded && t.remindAt <= now) {
      await sendTelegram(env, env.ALLOWED_TG_ID, "Напоминание: " + t.text);
      t.reminded = true;
      changed = true;
    }
  }
  if (changed) await saveState(env, state);
}

async function checkStaleTasks(env) {
  const state = await loadState(env);
  const now = Date.now();
  const threshold = 3 * 86400000; // 3 days
  const stale = state.tasks.filter((t) => !t.done && !t.staleNotified && now - t.createdAt > threshold);
  if (!stale.length) return;

  const lines = stale.slice(0, 8).map((t) => "• " + t.text);
  const text = "Эти задачи висят без движения больше трёх дней:\n" + lines.join("\n") + "\nСделай, разбей на шаги или удали.";
  await sendTelegram(env, env.ALLOWED_TG_ID, text);

  stale.forEach((t) => { t.staleNotified = true; });
  await saveState(env, state);
}

// ---------- goal: Thailand relocation ----------

function daysUntil(dateStr) {
  const target = new Date(dateStr + "T00:00:00+03:00").getTime();
  return Math.ceil((target - Date.now()) / 86400000);
}

async function weeklyGoalCheckin(env) {
  const state = await loadState(env);
  const daysLeft = daysUntil(GOAL.targetDate);
  const goalDoneTotal = state.tasks.filter((t) => t.done && t.goalTagged).length;
  const weekAgo = Date.now() - 7 * 86400000;
  const goalDoneWeek = state.tasks.filter((t) => t.done && t.goalTagged && t.doneAt && t.doneAt > weekAgo).length;
  const goalOpen = state.tasks.filter((t) => !t.done && t.goalTagged).map((t) => t.text);

  const prompt =
    'Ты — проводник пользователя к его цели "' + GOAL.title + '" (' + GOAL.description + '). ' +
    "До цели осталось " + daysLeft + " дней. " +
    "За эту неделю выполнено шагов к цели: " + goalDoneWeek + ", всего за всё время: " + goalDoneTotal + ". " +
    "Сейчас в списке открытых задач, связанных с целью: " + (goalOpen.length ? goalOpen.join("; ") : "нет ни одной") + ". " +
    "Напиши короткое (3-5 предложений) сообщение на русском в роли внимательного проводника, не начальника: " +
    "коротко отметь прогресс (или его отсутствие) за неделю, напомни про дни до цели, и обязательно предложи ОДИН " +
    "конкретный небольшой следующий шаг к переезду в Таиланд как удалённый сотрудник (виза, финансы, работодатель, жильё, " +
    "перелёты, страховка, язык, логистика — выбери что уместно и ещё не сделано). " +
    "Без markdown, без канцелярита, максимум 1 эмодзи. Ответь только текстом сообщения.";

  let text;
  try {
    text = (await geminiJSON(env, prompt)).trim();
  } catch (e) {
    text =
      "До Таиланда — " + daysLeft + " дней. Шагов к цели за неделю: " + goalDoneWeek +
      ". Выбери сегодня один маленький шаг к переезду и отметь его в Искре.";
  }

  await sendTelegram(env, env.ALLOWED_TG_ID, text);
}

// ---------- entry points ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }
    if (url.pathname === "/api/state") {
      return handleApiState(request, env);
    }
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    if (url.pathname === "/admin/run") {
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const jobs = {
        morning: morningPlan, evening: runDailyAnalysis, streak: streakSaver,
        reminders: checkTimedReminders, stale: checkStaleTasks, goal: weeklyGoalCheckin,
      };
      const job = jobs[url.searchParams.get("job")];
      if (!job) return new Response("unknown job", { status: 400 });
      await job(env);
      return new Response("ran: " + url.searchParams.get("job"));
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    switch (event.cron) {
      case "0 6 * * *": // 09:00 MSK
        ctx.waitUntil(morningPlan(env));
        break;
      case "0 15 * * *": // 18:00 MSK
        ctx.waitUntil(runDailyAnalysis(env));
        break;
      case "0 18 * * *": // 21:00 MSK
        ctx.waitUntil(streakSaver(env));
        break;
      case "*/15 * * * *":
        ctx.waitUntil(checkTimedReminders(env));
        ctx.waitUntil(checkStaleTasks(env));
        break;
      case "0 16 * * SUN": // Sunday 19:00 MSK
        ctx.waitUntil(weeklyGoalCheckin(env));
        break;
    }
  },
};
