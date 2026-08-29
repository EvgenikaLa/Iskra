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

const DTV_DEADLINE = "2026-11-01"; // soft deadline: apply by here per the strategy plan
const PLAN_LINKS =
  "Стратегия: https://claude.ai/code/artifact/ec9942a3-c98f-4bd2-ba39-5d2ad7d5803b\n" +
  "План на 3 месяца: https://claude.ai/code/artifact/8519fe32-d077-4352-b0fe-8f118a6becb9";

function emptyState() {
  return { tasks: [], completedDates: {}, totalCompleted: 0, goal: GOAL, lastAnnouncedMonth: null };
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
    h: msk.getUTCHours(), mi: msk.getUTCMinutes(), wd: msk.getUTCDay(), // 0=Sunday..6=Saturday
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
      lastAnnouncedMonth: typeof s.lastAnnouncedMonth === "string" ? s.lastAnnouncedMonth : null,
    };
  } catch (e) {
    return emptyState();
  }
}

async function saveState(env, state) {
  const prev = await env.TASKS_KV.get(KV_KEY);
  if (prev) await env.TASKS_KV.put(KV_KEY + ":backup", prev); // one-deep safety net against accidental overwrites
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
  if (task.recurrence) task.lastDoneCycle = k; // keeps it done until the next cycle resets it
}

const WEEKDAY_RU = ["воскресеньям", "понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам"];

function recurrenceLabel(rec) {
  if (rec === "daily") return "каждый день";
  const m = /^weekly:([0-6])$/.exec(rec || "");
  if (m) return "по " + WEEKDAY_RU[parseInt(m[1], 10)];
  return "";
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
    'Если задача повторяющаяся (например "каждый день", "ежедневно", "по вторникам", "каждую неделю") — положи в поле "recurrence" ' +
    'значение "daily" для ежедневной или "weekly:N", где N — номер дня недели (0=воскресенье,1=понедельник,...,6=суббота), для еженедельной; ' +
    'если задача разовая — "recurrence": null. ' +
    'В поле "text" положи только суть дела, без служебных слов вроде "добавь задачу", "напомни", "напиши в список", без указания времени и повторения. ' +
    'В поле "goal_related" — true, если дело относится к цели переезда в Таиланд (см. выше), иначе false. ' +
    'В поле "category" положи "activity", если дело про физическую активность/спорт/здоровье тела; "growth", если про саморазвитие/обучение/чтение/новые навыки; иначе null. ' +
    'Ответь СТРОГО одним JSON-объектом без пояснений и без markdown-разметки, формат: ' +
    '{"type":"task|report|other","text":"краткая формулировка задачи или сделанного","time":"HH:MM"|null,"recurrence":"daily|weekly:N"|null,"goal_related":true|false,"category":"activity|growth"|null}. ' +
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
    recurrence: null, remindTime: null, remindedThisCycle: false, lastDoneCycle: null,
    category: null, // "activity" | "growth" | null
    critical: false, criticalAlerted: false,
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
        "Привет! Пиши сюда обычным текстом — новую задачу или отчёт о том, что уже сделано — и я добавлю это в Искру. Команда /plan пришлёт стратегию и план по переезду."
      );
    } else if (text === "/plan" || text === "/strategy") {
      await sendTelegram(env, chatId, PLAN_LINKS);
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
      if (parsed.category === "activity" || parsed.category === "growth") t.category = parsed.category;

      let timeNote = "";
      const validRecurrence = parsed.recurrence === "daily" || /^weekly:[0-6]$/.test(parsed.recurrence || "");
      if (validRecurrence) {
        t.recurrence = parsed.recurrence;
        if (parsed.time && /^([01]?\d|2[0-3]):([0-5]\d)$/.test(parsed.time)) {
          t.remindTime = parsed.time;
          timeNote = " Буду напоминать в " + parsed.time + " (" + recurrenceLabel(t.recurrence) + ").";
        } else {
          timeNote = " Повторяю: " + recurrenceLabel(t.recurrence) + ".";
        }
      } else if (parsed.time) {
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
    const existing = await loadState(env);
    const state = {
      tasks: body.tasks,
      completedDates: body.completedDates && typeof body.completedDates === "object" ? body.completedDates : {},
      totalCompleted: typeof body.totalCompleted === "number" ? body.totalCompleted : 0,
      goal: GOAL, // server-owned, the app can't overwrite it
      lastAnnouncedMonth: existing.lastAnnouncedMonth, // server-owned bookkeeping, not the app's concern
    };
    await saveState(env, state);
    return json({ ok: true }, { status: 200 }, origin);
  }

  return json({ error: "method not allowed" }, { status: 405 }, origin);
}

// ---------- scheduled analysis + push ----------

function daysSinceGoalProgress(state) {
  const doneAts = state.tasks.filter((t) => t.done && t.goalTagged && t.doneAt).map((t) => t.doneAt);
  if (!doneAts.length) return null; // never once moved on the goal
  const last = Math.max(...doneAts);
  return Math.floor((Date.now() - last) / 86400000);
}

const COACH_VOICE =
  "Ты не мягкий помощник, а требовательный тренер в приложении \"Искра\". Твоя роль — не утешать, а давить в хорошем смысле: " +
  "называть вещи как есть, напоминать, что дни до цели уходят безвозвратно, и не позволять поводов вроде \"устала\" звучать как оправдание. " +
  "Без грубости и оскорблений, но без мягкости и без реверансов — тон человека, который верит, что ты можешь больше, и не собирается делать вид, что ноль есть прогресс.";

async function runDailyAnalysis(env) {
  const state = await loadState(env);
  const today = mskDateKey(new Date());
  const doneToday = state.completedDates[today] || 0;
  const streak = computeStreak(state.completedDates);
  const openTasks = state.tasks.filter((t) => !t.done).length;
  const goalStale = daysSinceGoalProgress(state);
  const daysLeft = daysUntil(GOAL.targetDate);

  const prompt =
    COACH_VOICE + " " +
    "Статистика за сегодня: выполнено — " + doneToday + ", цепочка дней подряд — " + streak +
    ", открытых задач — " + openTasks + ", всего выполнено за всё время — " + state.totalCompleted +
    ". До цели \"" + GOAL.title + "\" осталось " + daysLeft + " дней. " +
    (goalStale === null ? "К цели переезда пока не сделано ни одного шага вообще." :
      goalStale >= 2 ? "К цели переезда нет движения уже " + goalStale + " дней." : "К цели переезда есть движение недавно.") +
    " Напиши короткое (2-3 предложения) сообщение на русском по формату: если день был нулевой или шагов к цели нет — прямо это назови " +
    "и потребуй хоть одно маленькое действие завтра, без утешений; если день был продуктивный — признай это коротко и сухо, " +
    "без похвалы через край, и сразу переведи фокус на завтра. Без markdown, без канцелярита, без лишних эмодзи. Ответь только текстом сообщения.";

  let text;
  try {
    text = (await geminiJSON(env, prompt)).trim();
  } catch (e) {
    text =
      doneToday > 0
        ? "Сегодня выполнено задач: " + doneToday + ". Цепочка дней: " + streak + ". Это факт, а не повод расслабляться — завтра снова."
        : "Сегодня — ноль. До Таиланда осталось " + daysLeft + " дней, и они не ждут. Открой Искру и закрой хотя бы одну задачу прямо сейчас.";
  }

  await sendTelegram(env, env.ALLOWED_TG_ID, text);
}

// ---------- morning plan ----------

const RU_MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

// proactive monthly milestone transition: fires once, the first morning of a new calendar month
async function announceMonthlyMilestoneIfDue(env, state) {
  const p = mskParts(new Date());
  const monthKey = p.y + "-" + String(p.mo + 1).padStart(2, "0");
  if (state.lastAnnouncedMonth === monthKey) return false;

  const prevMonthLabel = RU_MONTHS[(p.mo + 11) % 12];
  const curMonthLabel = RU_MONTHS[p.mo];
  const prevDone = state.tasks.filter((t) => t.goalTagged && t.done && t.why && t.why.indexOf(prevMonthLabel + " ·") === 0).length;
  const prevTotal = state.tasks.filter((t) => t.goalTagged && t.why && t.why.indexOf(prevMonthLabel + " ·") === 0).length;
  const curTasks = state.tasks.filter((t) => t.goalTagged && !t.done && t.why && t.why.indexOf(curMonthLabel + " ·") === 0);

  let text = curMonthLabel + " начинается.";
  if (prevTotal > 0) text += " " + prevMonthLabel + " закрыт: " + prevDone + "/" + prevTotal + " по плану переезда.";
  if (curTasks.length) {
    text += " Фокус месяца:\n" + curTasks.slice(0, 6).map((t) => "• " + t.text).join("\n");
  } else {
    text += " По плану на этот месяц отдельных задач не заведено — переезд не ставится на паузу, добавь их сама.";
  }
  await sendTelegram(env, env.ALLOWED_TG_ID, text);

  state.lastAnnouncedMonth = monthKey;
  await saveState(env, state);
  return true;
}

async function morningPlan(env) {
  const state = await loadState(env);

  await announceMonthlyMilestoneIfDue(env, state);

  const open = state.tasks.filter((t) => !t.done);
  const streak = computeStreak(state.completedDates);
  const daysLeft = daysUntil(GOAL.targetDate);
  const goalStale = daysSinceGoalProgress(state);
  const staleLine = goalStale !== null && goalStale >= 2 ? " К цели переезда — тишина " + goalStale + " дней. Сегодня это должно кончиться." : "";

  const dtvLeft = daysUntil(DTV_DEADLINE);
  const dtvOpen = state.tasks.some((t) => t.critical && !t.done);
  let alarmLine = "";
  if (dtvOpen && dtvLeft <= 7 && dtvLeft >= 0) {
    alarmLine = "⚠ До срока подачи DTV (" + DTV_DEADLINE + ") — " + dtvLeft + " дн., заявление ещё не подано. Это точка отказа всей стратегии, тянуть больше нельзя.\n\n";
  } else if (dtvOpen && dtvLeft < 0) {
    alarmLine = "⚠ Срок подачи DTV (" + DTV_DEADLINE + ") уже прошёл, заявление не подано. Разбираться с этим — задача номер один сегодня, раньше остальных.\n\n";
  }

  let text;
  if (!open.length) {
    text = alarmLine + "Список задач пуст. До Таиланда " + daysLeft + " дней — пустой список сейчас работает против тебя, а не за тебя." + staleLine;
  } else {
    const lines = open.slice(0, 10).map((t) => "• " + t.text);
    text = alarmLine + "На сегодня открыто задач: " + open.length + (streak > 0 ? " · цепочка: " + streak + " дн." : " · цепочки нет — начни её сегодня") +
      " · до цели: " + daysLeft + " дн.\n" + lines.join("\n") + staleLine;
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
  const daysLeft = daysUntil(GOAL.targetDate);

  const text = priorStreak > 0
    ? "Через несколько часов цепочка в " + priorStreak + " " + (priorStreak === 1 ? "день" : "дней") + " сгорит — и это будет решение, которое ты приняла сама, ничего не сделав. Ещё есть время закрыть одну задачу."
    : "День почти закончился, и в нём — ноль. До Таиланда " + daysLeft + " дней, они не копятся, если ты бездействуешь. Последний шанс сегодня: закрой хоть что-то, прямо сейчас.";

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
  const stale = state.tasks.filter((t) => !t.done && !t.recurrence && !t.staleNotified && now - t.createdAt > threshold);
  if (!stale.length) return;

  const lines = stale.slice(0, 8).map((t) => "• " + t.text);
  const text = "Эти задачи висят без движения больше трёх дней:\n" + lines.join("\n") + "\nСделай, разбей на шаги или удали.";
  await sendTelegram(env, env.ALLOWED_TG_ID, text);

  stale.forEach((t) => { t.staleNotified = true; });
  await saveState(env, state);
}

// ---------- recurring tasks: cycle reset + due reminders (runs every 15 min) ----------

function isDueToday(recurrence, weekday) {
  if (recurrence === "daily") return true;
  const m = /^weekly:([0-6])$/.exec(recurrence || "");
  return m ? parseInt(m[1], 10) === weekday : false;
}

async function processRecurringTasks(env) {
  const state = await loadState(env);
  const now = Date.now();
  const p = mskParts(new Date());
  const todayKey = mskDateKey(new Date());
  let changed = false;

  for (const t of state.tasks) {
    if (!t.recurrence) continue;
    const due = isDueToday(t.recurrence, p.wd);

    // new cycle started (today isn't the cycle we last completed) -> reset
    if (due && t.lastDoneCycle !== todayKey && t.done) {
      t.done = false;
      t.doneAt = null;
      t.remindedThisCycle = false;
      changed = true;
    }
    // cycle rolled over without a reminder having fired yet this cycle -> re-arm
    if (t.remindedThisCycle && t.lastDoneCycle !== todayKey && !t.done) {
      t.remindedThisCycle = false;
      changed = true;
    }

    if (due && !t.done && t.remindTime && !t.remindedThisCycle) {
      // compare against today's MSK instant directly (remindAtFromTime rolls to tomorrow once passed, which we don't want here)
      const todayInstant = Date.UTC(p.y, p.mo, p.da, parseInt(t.remindTime.slice(0, 2), 10) - 3, parseInt(t.remindTime.slice(3), 10), 0, 0);
      if (todayInstant <= now) {
        await sendTelegram(env, env.ALLOWED_TG_ID, "Напоминание (" + recurrenceLabel(t.recurrence) + "): " + t.text);
        t.remindedThisCycle = true;
        changed = true;
      }
    }
  }

  if (changed) await saveState(env, state);
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
    COACH_VOICE + ' Цель пользователя — "' + GOAL.title + '" (' + GOAL.description + '). ' +
    "До цели осталось " + daysLeft + " дней — это конечное число, оно только уменьшается. " +
    "За эту неделю выполнено шагов к цели: " + goalDoneWeek + ", всего за всё время: " + goalDoneTotal + ". " +
    "Сейчас в списке открытых задач, связанных с целью: " + (goalOpen.length ? goalOpen.join("; ") : "нет ни одной") + ". " +
    "Напиши сообщение на русском (4-6 предложений): " +
    (goalDoneWeek === 0
      ? "неделя прошла БЕЗ единого шага к цели — начни именно с этого факта прямо и без смягчений, спроси, что реально мешало, "
      : "коротко и сухо отметь прогресс за неделю, без похвалы через край, ") +
    "напомни про дни до цели как про невозобновляемый ресурс, и обязательно потребуй ОДИН " +
    "конкретный небольшой следующий шаг к переезду в Таиланд как удалённый сотрудник (виза, финансы, работодатель, жильё, " +
    "перелёты, страховка, язык, логистика — выбери что уместно и ещё не сделано) — не предложи, а именно потребуй, с логикой " +
    "\"если не сейчас, то когда\". Без markdown, без канцелярита, без заискивающего тона. Ответь только текстом сообщения.";

  let text;
  try {
    text = (await geminiJSON(env, prompt)).trim();
  } catch (e) {
    text = goalDoneWeek === 0
      ? "Неделя прошла без единого шага к Таиланду. До цели осталось " + daysLeft + " дней, и они не восполняются. Выбери шаг прямо сейчас и закрой его сегодня."
      : "До Таиланда — " + daysLeft + " дней. Шагов к цели за неделю: " + goalDoneWeek + ". Этого недостаточно, чтобы расслабляться — выбери следующий шаг и закрой его сегодня же.";
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
        recurring: processRecurringTasks,
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
        ctx.waitUntil(processRecurringTasks(env));
        break;
      case "0 16 * * SUN": // Sunday 19:00 MSK
        ctx.waitUntil(weeklyGoalCheckin(env));
        break;
    }
  },
};
