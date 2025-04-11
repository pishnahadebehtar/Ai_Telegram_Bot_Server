require("dotenv").config();
const express = require("express");
const { Client, Databases, ID, Query } = require("node-appwrite");
const fetch = require("node-fetch").default;

const app = express();
app.use(express.json()); // Parse incoming JSON requests

// Load environment variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
const DB_ID = "67eaf6a0002147077712";
const USERS_COLLECTION = "67f64d80000eb41830cf";
const SESSIONS_COLLECTION = "67f64e0800239fe47ea6";
const CHATS_COLLECTION = "67f64e850019bd0f6c97";

// Initialize Appwrite client
const client = new Client()
  .setEndpoint(APPWRITE_ENDPOINT)
  .setProject(APPWRITE_PROJECT_ID)
  .setKey(APPWRITE_API_KEY);

const db = new Databases(client);

// Handle Telegram webhook requests
app.post("/api/telegram", async (req, res) => {
  console.log(
    `[${new Date().toISOString()}] Received POST request:`,
    JSON.stringify(req.body)
  );
  try {
    const { message } = req.body;
    if (!message) {
      console.log(`[${new Date().toISOString()}] No message in request`);
      return res.json({ status: "ok" });
    }
    const chatId = message.chat.id.toString();
    const text = (message.text ?? "").trim();
    console.log(
      `[${new Date().toISOString()}] Processing command: ${text} from chat ${chatId}`
    );

    const user = await upsertUser(chatId);
    if (!user) {
      console.log(
        `[${new Date().toISOString()}] User upsert failed, sending error message`
      );
      await tg(chatId, "خطا");
      return res.json({ status: "ok" });
    }
    if (user.usageCount >= 400) {
      console.log(
        `[${new Date().toISOString()}] Usage limit reached for chat ${chatId}`
      );
      await tg(chatId, "سقف مصرف ماهانه پر شده");
      return res.json({ status: "ok" });
    }

    if (/^\/start/i.test(text)) {
      console.log(`[${new Date().toISOString()}] Handling /start command`);
      await tg(chatId, "سلام! پیام بده یا گزینه‌ها", menu());
      return res.json({ status: "ok" });
    }
    if (/^\/help/i.test(text)) {
      console.log(`[${new Date().toISOString()}] Handling /help command`);
      await tg(
        chatId,
        "/start\n/newchat\n/summary100\n/summaryall\n/youtube",
        menu()
      );
      return res.json({ status: "ok" });
    }
    if (/^\/youtube/i.test(text)) {
      console.log(`[${new Date().toISOString()}] Handling /youtube command`);
      await tg(chatId, "کانال: https://t.me/sokhannegar_bot", menu());
      return res.json({ status: "ok" });
    }
    if (/^\/newchat/i.test(text)) {
      console.log(`[${new Date().toISOString()}] Handling /newchat command`);
      await finishSessions(chatId);
      await createSession(chatId, "");
      await tg(chatId, "چت جدید آغاز شد", menu());
      return res.json({ status: "ok" });
    }
    if (/^\/summary(all|100)/i.test(text)) {
      console.log(`[${new Date().toISOString()}] Handling summary command`);
      const lim = text.includes("100") ? 100 : 1000;
      const chats = await chatsUser(chatId, lim);
      const sum = await summarize(chats);
      const sess = await getActive(chatId);
      await db.updateDocument(DB_ID, SESSIONS_COLLECTION, sess.$id, {
        context: sum,
      });
      await tg(chatId, "خلاصه ایجاد شد", menu());
      return res.json({ status: "ok" });
    }

    console.log(`[${new Date().toISOString()}] Handling regular message`);
    const sess = await getActive(chatId);
    await saveChat(sess.$id, chatId, "user", text);
    const history = await chatsSession(sess.$id, 10);

    let prompt = `سابقه:\n${sess.context || "ندارد"}\n\n`;
    history.forEach((c) => {
      prompt += `${c.role === "user" ? "کاربر" : "دستیار"}: ${c.content}\n`;
    });
    prompt += `\nپیام کاربر:\n${text}\nپاسخ به فارسی`;

    const ai = await askAI(prompt);
    await saveChat(sess.$id, chatId, "assistant", ai);
    await db.updateDocument(DB_ID, USERS_COLLECTION, user.$id, {
      usageCount: user.usageCount + 1,
    });
    await tg(chatId, ai, menu());

    res.json({ status: "ok" });
  } catch (e) {
    console.error(
      `[${new Date().toISOString()}] Error in /api/telegram:`,
      e.message,
      e.stack
    );
    res.json({ status: "ok" }); // Telegram expects a response even on error
  }
});

// Inner Functions
async function upsertUser(tid) {
  const month = new Date().toISOString().slice(0, 7);
  try {
    const u = await db.listDocuments(DB_ID, USERS_COLLECTION, [
      Query.equal("telegramId", tid),
    ]);
    if (u.total === 0)
      return await db.createDocument(DB_ID, USERS_COLLECTION, ID.unique(), {
        telegramId: tid,
        month,
        usageCount: 0,
      });
    const doc = u.documents[0];
    if (doc.month !== month)
      return await db.updateDocument(DB_ID, USERS_COLLECTION, doc.$id, {
        month,
        usageCount: 0,
      });
    return doc;
  } catch {
    return null;
  }
}

async function finishSessions(uid) {
  try {
    const s = await db.listDocuments(DB_ID, SESSIONS_COLLECTION, [
      Query.equal("userId", uid),
      Query.equal("active", true),
    ]);
    for (let x of s.documents) {
      await db.updateDocument(DB_ID, SESSIONS_COLLECTION, x.$id, {
        active: false,
      });
    }
  } catch {}
}

async function createSession(uid, context) {
  try {
    return await db.createDocument(DB_ID, SESSIONS_COLLECTION, ID.unique(), {
      userId: uid,
      active: true,
      context,
    });
  } catch {
    return null;
  }
}

async function getActive(uid) {
  const r = await db.listDocuments(DB_ID, SESSIONS_COLLECTION, [
    Query.equal("userId", uid),
    Query.equal("active", true),
  ]);
  if (r.total) return r.documents[0];
  return await createSession(uid, "");
}

async function saveChat(sess, user, role, content) {
  try {
    await db.createDocument(DB_ID, CHATS_COLLECTION, ID.unique(), {
      sessionId: sess,
      userId: user,
      role,
      content,
    });
  } catch {}
}

async function chatsSession(sessid, limit) {
  try {
    const r = await db.listDocuments(DB_ID, CHATS_COLLECTION, [
      Query.equal("sessionId", sessid),
      Query.limit(limit),
      Query.orderDesc("$createdAt"),
    ]);
    return r.documents.reverse();
  } catch {
    return [];
  }
}

async function chatsUser(uid, limit) {
  try {
    const r = await db.listDocuments(DB_ID, CHATS_COLLECTION, [
      Query.equal("userId", uid),
      Query.limit(limit),
      Query.orderDesc("$createdAt"),
    ]);
    return r.documents.reverse();
  } catch {
    return [];
  }
}

async function summarize(chats) {
  if (!chats.length) return "پیامی نیست";
  const concat = chats
    .map((c) => `${c.role === "user" ? "کاربر" : "دستیار"}:${c.content}`)
    .join("\n");
  const prompt = `متن زیر را خلاصه کن:\n${concat}`;
  return await askAI(prompt);
}

async function askAI(prompt) {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "quasar-openai/quasar-7b-chat-alpha",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content ?? "پاسخی نبود";
  } catch {
    return "خطا هوش مصنوعی";
  }
}

async function tg(chatId, text, reply_markup) {
  try {
    console.log(
      `[${new Date().toISOString()}] Sending Telegram message to ${chatId}: ${text}`
    );
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: "Markdown",
          reply_markup: reply_markup,
        }),
      }
    );
    const result = await response.json();
    console.log(
      `[${new Date().toISOString()}] Telegram API response: ${
        response.status
      } - ${JSON.stringify(result)}`
    );
    if (!response.ok) {
      throw new Error(`Telegram API failed: ${JSON.stringify(result)}`);
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Failed to send Telegram message: ${
        error.message
      }`
    );
    throw error;
  }
}

function menu() {
  return {
    keyboard: [
      [{ text: "/newchat" }, { text: "/youtube" }],
      [{ text: "/summary100" }, { text: "/summaryall" }],
      [{ text: "/help" }],
    ],
    resize_keyboard: true,
  };
}

// Test route
app.get("/", (req, res) => {
  res.send("Telegram Bot Server is running!");
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
