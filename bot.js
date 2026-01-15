// =======================
// Gamescan Discord Bot — bot.js
// - No AI (free)
// - Auto plan-role sync (Free/Gamer/Pro/Master)
// - Role sync immediately when account is linked (HTTP hook)
// - Raid + spam protection
// - Ticket spam handling ("we can't help with your spamming")
// - Ticket names: ticket-(number)
// - Results channel: only pure Gamescan /result/<token> links
// - Any non-Gamescan links blocked everywhere
// - Support-style replies only inside ticket channels
// =======================

require("dotenv").config();

const {
  DISCORD_TOKEN,
  GUILD_ID,
  STATUS_CHANNEL_ID,
  STATUS_API_KEY,
  PORT,

  // Plan role IDs
  FREE_ROLE_ID,
  GAMER_ROLE_ID,
  PRO_ROLE_ID,
  MASTER_ROLE_ID,

  // Optional: generic "Linked" role
  LINKED_ROLE_ID,

  // Channels
  RULES_CHANNEL_ID,
  TICKET_CHANNEL_ID,
  TICKET_CATEGORY_ID,
  SUPPORT_ROLE_ID,
  COMMANDS_CHANNEL_ID,
  RESULTS_CHANNEL_ID,
  ABOUT_CHANNEL_ID,
  LINK_GAMESCAN_CHANNEL_ID,

  // WordPress connection
  WP_API_BASE,
  WP_BOT_KEY,

  MOD_LOG_CHANNEL_ID
} = process.env;

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const express = require("express");

// ------------------------------
// Basic safety checks
// ------------------------------
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}
if (!STATUS_CHANNEL_ID) {
  console.error("❌ STATUS_CHANNEL_ID missing");
  process.exit(1);
}

// ------------------------------
// Discord client
// ------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// ------------------------------
// Utility
// ------------------------------
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Detect if a message is an actual question (for ticket FAQ logic)
function isActualQuestion(content) {
  const lower = (content || "").toLowerCase().trim();
  if (!lower) return false;

  // Very short / obvious non-questions
  if (lower.length < 6) return false;
  if (
    [
      "hi",
      "hey",
      "hello",
      "yo",
      "sup",
      "hiya",
      "thanks",
      "thank you",
      "ty",
      "thx"
    ].includes(lower)
  ) {
    return false;
  }

  const QUESTION_TRIGGERS = [
    "?",
    "why",
    "how",
    "what",
    "where",
    "when",
    "does",
    "do i",
    "can i",
    "cant",
    "cannot",
    "won't",
    "is it",
    "are you",
    "only get",
    "only upload",
    "doesnt work",
    "doesn't work",
    "not working",
    "how do i",
    "how to",
    "where do i",
    "is there a way",
    "can you",
    "could you",
    "any way to"
  ];

  return QUESTION_TRIGGERS.some((q) => lower.includes(q));
}

// ------------------------------
// Status state
// ------------------------------
let statusMessageId = null;
let aiClipStatus = "live"; // "live" | "down"
let liveCoachingStatus = "coming_soon"; // "live" | "down" | "coming_soon"
let queueSize = randomInt(1, 5);

// ------------------------------
// Strike system
// ------------------------------
const STRIKE_LIMIT = 3;
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const STRIKE_DECAY_AFTER_MS = 30 * 60 * 1000; // 30 minutes
const userStrikes = new Map();

function decayStrikes() {
  const now = Date.now();
  for (const [userId, data] of userStrikes.entries()) {
    if (!data || typeof data.count !== "number" || typeof data.lastAt !== "number") {
      userStrikes.delete(userId);
      continue;
    }
    if (now - data.lastAt >= STRIKE_DECAY_AFTER_MS) {
      userStrikes.delete(userId);
    }
  }
}

// ------------------------------
// Ticket memory per channel
// ------------------------------
const ticketMemory = new Map();
const MAX_HISTORY_PER_TICKET = 30;

function rememberTicketMessage(message) {
  const channelId = message.channel.id;
  const existing = ticketMemory.get(channelId) || {
    history: [],
    lastFaqIndex: null
  };

  existing.history.push({
    authorId: message.author.id,
    content: message.content.slice(0, 500),
    ts: Date.now()
  });

  if (existing.history.length > MAX_HISTORY_PER_TICKET) {
    existing.history.splice(0, existing.history.length - MAX_HISTORY_PER_TICKET);
  }

  ticketMemory.set(channelId, existing);
}

function setTicketLastFaq(channelId, index) {
  const existing = ticketMemory.get(channelId) || {
    history: [],
    lastFaqIndex: null
  };
  existing.lastFaqIndex = index;
  ticketMemory.set(channelId, existing);
}

function getTicketSummary(channelId) {
  const mem = ticketMemory.get(channelId);
  if (!mem || !mem.history.length) return "No history stored yet.";

  const lines = mem.history.slice(-10).map((h) => {
    const when = new Date(h.ts).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit"
    });
    return `• [${when}] <@${h.authorId}>: ${h.content}`;
  });

  return lines.join("\n");
}

// Track when we’ve already soft re-asked / escalated in a ticket
const ticketReaskSent = new Set();
const ticketEscalated = new Set();

// ------------------------------
// Friendly conversation system
// ------------------------------
const recentReplies = new Map();
const REPLY_COOLDOWN_MS = 20_000; // 20 sec

function canReplyToUser(userId) {
  const last = recentReplies.get(userId) || 0;
  if (Date.now() - last < REPLY_COOLDOWN_MS) return false;
  recentReplies.set(userId, Date.now());
  return true;
}

const CONVERSATION_PATTERNS = [
  {
    keywords: ["hi", "hello", "hey", "yo", "hiya", "sup"],
    replies: [
      "Hey! 👋 How can I help you today?",
      "Hi there! What can I help you with?",
      "Hello! 😊 Need help with anything?",
      "Hey! Welcome — what’s up?"
    ]
  },
  {
    keywords: ["thanks", "thank you", "ty", "thx", "appreciate it"],
    replies: [
      "You’re welcome! 🙌",
      "No problem at all!",
      "Glad I could help 😊",
      "Anytime! Let me know if you need anything else."
    ]
  },
  {
    keywords: [
      "confused",
      "dont get it",
      "don't get it",
      "idk",
      "i dont know",
      "what does that mean"
    ],
    replies: [
      "No worries — want me to explain it a bit simpler?",
      "That’s okay! Tell me which part is confusing.",
      "Got it 👍 Let’s break it down step by step."
    ]
  },
  {
    keywords: ["annoying", "frustrated", "this sucks", "hate this", "broken"],
    replies: [
      "Yeah, that’s frustrating 😕 Let’s get it sorted.",
      "I get why that’s annoying — I’ll try to help.",
      "Sorry about that, let’s see what’s going wrong."
    ]
  },
  {
    keywords: ["are you there", "anyone here", "hello?", "bot?"],
    replies: [
      "Yep, I’m here 👋",
      "I’m here! What’s going on?",
      "Hey! I’m listening 🙂"
    ]
  }
];

function getConversationReply(messageContent) {
  const lower = (messageContent || "").toLowerCase().trim();
  if (!lower) return null;

  for (const group of CONVERSATION_PATTERNS) {
    for (const keyword of group.keywords) {
      if (lower === keyword || lower.startsWith(keyword + " ")) {
        const replies = group.replies;
        return replies[randomInt(0, replies.length - 1)];
      }
    }
  }
  return null;
}

// ------------------------------
// Status helpers
// ------------------------------
function statusBadge(status) {
  switch (status) {
    case "live":
      return "🟢 Live";
    case "down":
      return "🔴 Down for maintenance";
    case "coming_soon":
      return "🟠 Coming soon";
    default:
      return "⚪ Unknown";
  }
}

function embedColorForStatus() {
  if (aiClipStatus === "down" || liveCoachingStatus === "down") {
    return 0xff4444;
  }
  if (aiClipStatus === "live" && liveCoachingStatus === "live") {
    return 0x00ffaa;
  }
  return 0xffa500;
}

function buildStatusEmbed() {
  return new EmbedBuilder()
    .setTitle("🎮 Gamescan Status")
    .setColor(embedColorForStatus())
    .setDescription(
      [
        "**AI Clip Analysis**",
        statusBadge(aiClipStatus),
        `🎥 **${queueSize}** clips in queue`,
        "",
        "**---------------- Live Coaching ----------------**",
        statusBadge(liveCoachingStatus),
        "",
        "**Support & Bot**",
        "🟢 Support status: Live"
      ].join("\n")
    )
    .setFooter({
      text: "Gamescan.gg • Status auto-updated from backend"
    })
    .setTimestamp(new Date());
}

async function ensureStatusMessage() {
  try {
    const channel = await client.channels.fetch(STATUS_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.error("❌ STATUS_CHANNEL_ID is not a text channel");
      return null;
    }

    if (statusMessageId) {
      try {
        const msg = await channel.messages.fetch(statusMessageId);
        if (msg) return msg;
      } catch {
        // ignore
      }
    }

    const recent = await channel.messages.fetch({ limit: 20 });
    const existing = recent.find(
      (m) => m.author.id === client.user.id && m.embeds.length > 0
    );

    let statusMessage;
    if (existing) {
      statusMessage = await existing.edit({ embeds: [buildStatusEmbed()] });
      statusMessageId = statusMessage.id;
      console.log("✅ Reused status message:", statusMessage.id);
    } else {
      statusMessage = await channel.send({ embeds: [buildStatusEmbed()] });
      statusMessageId = statusMessage.id;
      console.log("✅ Created status message:", statusMessage.id);
      try {
        await statusMessage.pin();
      } catch (err) {
        console.warn("⚠️ Failed to pin status message:", err.message);
      }
    }

    return statusMessage;
  } catch (err) {
    console.error("❌ ensureStatusMessage error:", err);
    return null;
  }
}

async function updateStatusMessage() {
  try {
    const channel = await client.channels.fetch(STATUS_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    if (!statusMessageId) await ensureStatusMessage();
    if (!statusMessageId) return;

    let msg;
    try {
      msg = await channel.messages.fetch(statusMessageId);
    } catch {
      msg = null;
    }

    if (!msg) {
      console.warn("⚠️ Status message missing, recreating");
      await ensureStatusMessage();
      return;
    }

    await msg.edit({ embeds: [buildStatusEmbed()] });
  } catch (err) {
    console.error("❌ updateStatusMessage error:", err.message);
  }
}

// ------------------------------
// Rules embed
// ------------------------------
async function ensureRulesMessage() {
  if (!RULES_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(RULES_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    const recent = await channel.messages.fetch({ limit: 20 });
    const existing = recent.find(
      (m) =>
        m.author.id === client.user.id &&
        m.embeds.length > 0 &&
        m.embeds[0].title &&
        m.embeds[0].title.includes("Gamescan Rules")
    );
    if (existing) return;

    const embed = new EmbedBuilder()
      .setTitle("📜 Gamescan Rules")
      .setColor(0x00ffaa)
      .setDescription(
        [
          "Welcome to the **Gamescan** Discord server!",
          "",
          "We want this to be a clean, friendly place for everyone. By being here, you agree to follow these rules:"
        ].join("\n")
      )
      .addFields(
        {
          name: "1️⃣ Be respectful",
          value:
            "No harassment, hate, discrimination, or targeted bullying. Treat everyone like a teammate."
        },
        {
          name: "2️⃣ Keep it clean",
          value: "No NSFW, gore, or illegal content anywhere in the server."
        },
        {
          name: "3️⃣ No self-promo or links",
          value:
            "No Discord invites, socials, referral codes, or external links unless approved by staff."
        },
        {
          name: "4️⃣ Stay on topic",
          value:
            "Use the correct channels for your messages and keep spam to a minimum."
        },
        {
          name: "5️⃣ No impersonation",
          value:
            "Do not impersonate staff, Gamescan, creators, or other users."
        },
        {
          name: "6️⃣ Follow Discord ToS",
          value:
            "You must follow Discord's Terms of Service and Community Guidelines at all times."
        }
      )
      .setFooter({
        text: "Gamescan.gg • Auto-moderation & strike system are enabled"
      });

    await channel.send({ embeds: [embed] });
    console.log("✅ Rules embed ensured");
  } catch (err) {
    console.error("⚠️ ensureRulesMessage error:", err);
  }
}

// ------------------------------
// Info embeds (Results / Commands / About / Link Gamescan)
// ------------------------------
function buildResultsInfoEmbed() {
  return new EmbedBuilder()
    .setTitle("📊 Gamescan Results — Share Your Links")
    .setColor(0x00ffaa)
    .setDescription(
      [
        "Use this channel to post **Gamescan result links only** (like `https://gamescan.gg/result/your-token`).",
        "",
        "✅ Allowed:",
        "• A single Gamescan result link per message, and nothing else",
        "",
        "❌ Not allowed:",
        "• Any other links",
        "• Extra text or spam",
        "",
        "You can get a result link from the Gamescan website after analysing a clip."
      ].join("\n")
    )
    .setFooter({ text: "Gamescan.gg • Analyse on the site, then paste your result link here." });
}

function buildCommandsInfoEmbed() {
  return new EmbedBuilder()
    .setTitle("⚙️ Gamescan Bot — Commands")
    .setColor(0x00ffaa)
    .setDescription(
      [
        "This channel is for **slash commands only**.",
        "",
        "Type `/` in the chat box and pick one of the commands:",
        ""
      ].join("\n")
    )
    .addFields(
      {
        name: "/credits",
        value: "Show your Gamescan credit balance (monthly / extra / total)."
      },
      {
        name: "/plan",
        value: "Show your active Gamescan plan (Free / Gamer / Pro / Master)."
      },
      {
        name: "/usage",
        value: "Show your recent usage: credits used, analyses, coaching minutes."
      },
      {
        name: "/status",
        value: "Show the current system status for Gamescan."
      },
      {
        name: "/help",
        value: "Show this list of commands."
      }
    )
    .setFooter({ text: "Gamescan.gg • Link your account on the website for best results." });
}

function buildAboutGamescanEmbed() {
  return new EmbedBuilder()
    .setTitle("ℹ️ About Gamescan")
    .setColor(0x00ffaa)
    .setDescription(
      [
        "**Gamescan** is a gameplay analysis platform built for competitive players.",
        "",
        "You upload short clips and Gamescan breaks down your:",
        "• Positioning and map awareness",
        "• Crosshair placement and aim consistency",
        "• Decision making and timing",
        "",
        "The goal is to make it easy to understand **what actually went wrong** in a fight and how to fix it, without needing a full-time coach.",
        "",
        "Gamescan offers:",
        "• A clean web dashboard",
        "• Shareable result pages",
        "• Player-friendly credit and plan system",
        "",
        "All analysis runs through the Gamescan website — this Discord server is for updates, support, and community."
      ].join("\n")
    )
    .setFooter({ text: "Gamescan.gg • Built to help you improve faster." });
}

function buildLinkGamescanEmbed() {
  return new EmbedBuilder()
    .setTitle("🔗 Link Your Gamescan Account")
    .setColor(0x00ffaa)
    .setDescription(
      [
        "To link your Gamescan account with Discord:",
        "",
        "1. Go to **https://gamescan.gg/discord-link**",
        "2. Sign in to Gamescan (if you aren’t already)",
        "3. Click **Connect Discord** and approve the Discord popup",
        "",
        "Once linked, the bot can:",
        "• Read your plan and credit info",
        "• Show it in `/credits`, `/plan`, and `/usage`",
        "• Sync your plan to Discord roles (if set up)",
        "",
        "You can disconnect at any time from the same page."
      ].join("\n")
    )
    .setFooter({ text: "Gamescan.gg • Account linking is optional but recommended." });
}

async function ensureEmbedInChannel(channelId, buildEmbedFn, titleFragment) {
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;

    const recent = await channel.messages.fetch({ limit: 20 });
    const existing = recent.find(
      (m) =>
        m.author.id === client.user.id &&
        m.embeds.length > 0 &&
        m.embeds[0].title &&
        m.embeds[0].title.includes(titleFragment)
    );
    if (existing) return;

    await channel.send({ embeds: [buildEmbedFn()] });
    console.log(`✅ Info embed ensured for channel ${channelId}`);
  } catch (err) {
    console.error("⚠️ ensureEmbedInChannel error:", err.message);
  }
}

async function ensureInfoEmbeds() {
  await ensureEmbedInChannel(RESULTS_CHANNEL_ID, buildResultsInfoEmbed, "Results");
  await ensureEmbedInChannel(COMMANDS_CHANNEL_ID, buildCommandsInfoEmbed, "Commands");
  await ensureEmbedInChannel(ABOUT_CHANNEL_ID, buildAboutGamescanEmbed, "About");
  await ensureEmbedInChannel(LINK_GAMESCAN_CHANNEL_ID, buildLinkGamescanEmbed, "Link Your Gamescan");
}

// ------------------------------
// Ticket panel
// ------------------------------
function buildTicketPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("🎫 Gamescan Support Tickets")
    .setColor(0x00ffaa)
    .setDescription(
      [
        "Need help with Gamescan? Open a ticket and our team (or the bot) will guide you.",
        "",
        "• Select the **ticket type** from the menu below",
        "• A private channel will be created just for you",
        "• Answer the questions and the bot will try to help automatically",
        "",
        "If we can't auto-answer, staff will jump in shortly. 💬"
      ].join("\n")
    )
    .setFooter({ text: "Gamescan.gg • Support & Helpdesk" });
}

function buildTicketSelectMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("gamescan_ticket_type")
      .setPlaceholder("Select a ticket type…")
      .addOptions(
        {
          label: "General Support",
          value: "general_support",
          description: "Questions about accounts, website, or general help",
          emoji: "❓"
        },
        {
          label: "Billing / Payments",
          value: "billing",
          description: "Issues with subscriptions, payments, or refunds",
          emoji: "💳"
        },
        {
          label: "Bug / Technical Issue",
          value: "bug",
          description: "Something broken? Report a bug here",
          emoji: "🐛"
        },
        {
          label: "Feedback / Suggestions",
          value: "feedback",
          description: "Share ideas to improve Gamescan",
          emoji: "💡"
        }
      )
  );
}

async function ensureTicketPanel() {
  if (!TICKET_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(TICKET_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    const recent = await channel.messages.fetch({ limit: 20 });
    const existing = recent.find(
      (m) =>
        m.author.id === client.user.id &&
        m.embeds.length > 0 &&
        m.embeds[0].title &&
        m.embeds[0].title.includes("Gamescan Support Tickets")
    );

    if (existing) {
      await existing.edit({
        embeds: [buildTicketPanelEmbed()],
        components: [buildTicketSelectMenu()]
      });
      console.log("✅ Ticket panel refreshed");
      return;
    }

    await channel.send({
      embeds: [buildTicketPanelEmbed()],
      components: [buildTicketSelectMenu()]
    });
    console.log("✅ Ticket panel created");
  } catch (err) {
    console.error("⚠️ ensureTicketPanel error:", err);
  }
}

function getTicketIntroText(type, userMention) {
  switch (type) {
    case "billing":
      return [
        `💳 Hey ${userMention}, welcome to **Billing & Payments** support.`,
        "",
        "Please describe your billing issue:",
        "• What plan are you on? (Free/Gamer/Pro/Master)",
        "• What went wrong? (double charge, failed payment, refund question, etc.)",
        "",
        "Once you send your message, I'll try to answer automatically based on what you say."
      ].join("\n");
    case "bug":
      return [
        `🐛 Hey ${userMention}, thanks for helping improve **Gamescan**.`,
        "",
        "Please describe the bug:",
        "• What were you trying to do?",
        "• What exactly happened? (error messages, weird behaviour, etc.)",
        "• Can you reproduce it? If yes, how?",
        "",
        "After you send your message, I'll try to match it to known issues."
      ].join("\n");
    case "feedback":
      return [
        `💡 Hey ${userMention}, welcome to **Feedback & Suggestions**.`,
        "",
        "Tell us your idea:",
        "• What do you want Gamescan to do better?",
        "• Is this for the analyzer, profiles, or something else?",
        "",
        "I'll auto-tag your feedback and staff will review it!"
      ].join("\n");
    case "general_support":
    default:
      return [
        `❓ Hey ${userMention}, welcome to **Gamescan Support**.`,
        "",
        "Please type your question or explain your problem in one message:",
        "• What page or feature is this about?",
        "• What are you trying to do?",
        "",
        "I’ll try to auto-answer using your message. If I can't, staff will help you shortly."
      ].join("\n");
  }
}

function buildCloseTicketRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("gamescan_close_ticket")
      .setLabel("Close Ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger)
  );
}

// ------------------------------
// Ticket helpers
// ------------------------------
function isTicketChannel(channel) {
  if (!channel || !channel.guild) return false;
  if (TICKET_CATEGORY_ID && channel.parentId === TICKET_CATEGORY_ID) return true;
  if (channel.name && channel.name.startsWith("ticket-")) return true;
  if (channel.name && channel.name.startsWith("closed-")) return true;
  return false;
}

function getTicketTypeFromChannel(channel) {
  if (!channel) return "general_support";
  const topic = channel.topic || "";
  const match = topic.match(/Type:([a-zA-Z0-9_]+)/);
  if (match && match[1]) return match[1];
  return "general_support";
}

function getTicketOwnerIdFromChannel(channel) {
  if (!channel) return null;
  const topic = channel.topic || "";
  const match = topic.match(/Owner:(\d{15,25})/);
  if (match && match[1]) return match[1];
  return null;
}

// ------------------------------
// Auto-answer brain (FAQ entries)
// ------------------------------
const TICKET_ANSWERS = [
  {
    types: ["any"],
    keywords: [
      "what are credits",
      "what is a credit",
      "credit system",
      "how do credits work",
      "how credits work",
      "explain credits",
      "what do credits do",
      "what do i use credits for",
      "what are gamescan credits"
    ],
    answer:
      "💳 **What are credits?**\nCredits are the currency used on Gamescan for clip analysis and Live Coaching. Each scan or coaching session costs a certain number of credits depending on your plan."
  },
  {
    types: ["any"],
    keywords: [
      "how many credits do i get",
      "how many credits per month",
      "credits per month",
      "monthly credits",
      "how many scans do i get",
      "how many scans a month",
      "credit allowance",
      "credit limit per month"
    ],
    answer:
      "📆 **Monthly credits**\nYour monthly credits depend on your plan:\n• **Free** – 10 credits/month\n• **Gamer** – 15 credits/month\n• **Pro** – 20 credits/month\n• **Master** – 30 credits/month\n\nYou can also buy extra credit packs if you run out."
  },
  {
    types: ["billing"],
    keywords: [
      "charged twice",
      "charged 2 times",
      "double charged",
      "took my money twice",
      "duplicate payment",
      "paid twice",
      "two payments for same thing"
    ],
    answer:
      "💳 **Duplicate charge**\nSometimes banks show a pending + final charge while payment is processing. If the extra charge doesn’t disappear within 24 hours, contact your bank or open a **Billing** ticket so we can check."
  },
  {
    types: ["billing"],
    keywords: [
      "refund",
      "money back",
      "want my money back",
      "request refund",
      "can i get a refund",
      "refund policy"
    ],
    answer:
      "💰 **Refunds**\nWe mostly refund in cases of technical issues or accidental duplicate payments. Tell us what happened and include your email and approximate purchase time so staff can review."
  },
  {
    types: ["billing"],
    keywords: [
      "cancel subscription",
      "cancel my subscription",
      "stop subscription",
      "dont want to be charged",
      "turn off auto renew",
      "cancel my plan"
    ],
    answer:
      "🧾 **Cancel subscription**\nCancel auto-renew on your **Gamescan Subscriptions** page. You keep access until the current billing period ends."
  },
  {
    types: ["any"],
    keywords: [
      "extra credits",
      "buy credits",
      "credit pack",
      "top up credits",
      "purchase credits",
      "get more credits"
    ],
    answer:
      "➕ **Extra credits**\nBuy extra credit packs on the **Credit Store** page. Extra credits are used after your monthly allowance."
  },
  {
    types: ["general_support"],
    keywords: [
      "upload 30 seconds",
      "only upload 30",
      "only upload 30 seconds",
      "why can i only upload 30 seconds",
      "clip too short",
      "only 30 seconds",
      "30 second limit",
      "cant upload longer clips",
      "cant upload full game"
    ],
    answer:
      "⏱ **Clip length**\nGamescan is currently tuned for short clips (about 30–45 seconds) so analysis stays fast and cheap. Longer clip support is planned for the future."
  },
  {
    types: ["general_support"],
    keywords: [
      "cant log in",
      "cant login",
      "log in not working",
      "login not working",
      "cant sign in"
    ],
    answer:
      "🔐 **Login issues**\nUse the same login method you originally used (Discord/Google/email). Try incognito or another browser and make sure adblockers aren’t blocking the page."
  },
  {
    types: ["general_support"],
    keywords: [
      "link discord",
      "connect discord",
      "discord linking",
      "how do i link my discord",
      "connect my discord account"
    ],
    answer:
      "🔗 **Linking Discord**\nGo to **https://gamescan.gg/discord-link**, sign in, and click **Connect Discord**. Approve the popup and your Discord ID will be linked."
  },
  {
    types: ["general_support"],
    keywords: [
      "unlink discord",
      "disconnect discord",
      "remove discord link",
      "how do i unlink discord"
    ],
    answer:
      "🔗 **Unlinking Discord**\nGo back to the **Discord Link** page on Gamescan and press **Disconnect**."
  },
  {
    types: ["bug", "general_support"],
    keywords: [
      "video wont upload",
      "video won't upload",
      "cant upload",
      "upload failed",
      "stuck uploading",
      "upload error"
    ],
    answer:
      "📤 **Upload problems**\nCheck file type (MP4 works best), size, and connection. Try a smaller clip or another browser. If it keeps failing, share any error message in this ticket."
  },
  {
    types: ["bug", "general_support"],
    keywords: [
      "stuck on analyzing",
      "analysis stuck",
      "never finishes",
      "loading forever",
      "analysis taking forever"
    ],
    answer:
      "⌛ **Analysis stuck**\nIf analysis takes more than a few minutes, cancel and retry. If it repeats, open a **Bug** ticket with the game + time it happened."
  },
  {
    types: ["any"],
    keywords: [
      "how accurate is it",
      "is the ai accurate",
      "ai wrong",
      "analysis wrong",
      "score feels wrong"
    ],
    answer:
      "🧠 **AI accuracy**\nGamescan can misread some situations. Use it as a tool to guide improvement, not a perfect judge."
  },
  {
    types: ["any"],
    keywords: [
      "what games are supported",
      "supported games",
      "which games work",
      "list of games"
    ],
    answer:
      "🎮 **Supported games**\nThe supported game list is shown on the **Analyze** page. We’ll add more titles over time."
  },
  {
    types: ["bug"],
    keywords: [
      "wrong game detected",
      "detected wrong game",
      "game detection wrong",
      "picked the wrong game"
    ],
    answer:
      "🎯 **Wrong game detection**\nIf the game is detected wrong, the HUD or visuals might be unusual. Try another clip with the HUD clearly visible or choose the game manually where possible."
  },
  {
    types: ["any"],
    keywords: [
      "why is my score so low",
      "score too low",
      "low rating",
      "my score is low"
    ],
    answer:
      "📊 **Low scores**\nScores look at positioning, crosshair placement, reaction time, decisions, and consistency. A low score just highlights where the AI thinks you can improve."
  },
  {
    types: ["any"],
    keywords: [
      "what is skill tier",
      "skill tier",
      "skill level",
      "why am i bronze",
      "what does diamond mean"
    ],
    answer:
      "🏆 **Skill tiers**\nTiers (like Silver/Gold/Platinum/Diamond/Obsidian) are based on your clip patterns, not your in-game rank. They’re just a rough progress indicator."
  },
  {
    types: ["general_support"],
    keywords: [
      "public profile",
      "share profile",
      "profile link",
      "make my profile public"
    ],
    answer:
      "🌐 **Public profile**\nIf you enable public profile, you get a shareable URL on your Profile page (like `/profile/yourname`)."
  },
  {
    types: ["general_support"],
    keywords: [
      "cannot see my results",
      "cant see my results",
      "results disappeared",
      "lost my results"
    ],
    answer:
      "📁 **Missing results**\nCheck you are logged into the same account you used when you ran the analysis. Results live in your **History / Results** area."
  },
  {
    types: ["any"],
    keywords: [
      "what is live coaching",
      "live coaching explanation",
      "how does live coaching work"
    ],
    answer:
      "🎧 **Live Coaching**\nLive Coaching lets an AI (and later human coaches) watch your gameplay live/near-live and send tips while you play."
  },
  {
    types: ["any"],
    keywords: [
      "how much does live coaching cost",
      "live coaching credits",
      "credits per coaching"
    ],
    answer:
      "💡 **Live Coaching cost**\nIt uses credits based on duration or tips. Exact cost is shown on the **Live Coaching** page before you start."
  },
  {
    types: ["any"],
    keywords: [
      "live coaching coming soon",
      "cant start live coaching",
      "live coaching not available"
    ],
    answer:
      "🟠 **Live Coaching status**\nIf it says **Coming soon** or **Down**, we’re still preparing or maintaining the feature. Check the **Status** channel for updates."
  },
  {
    types: ["feedback"],
    keywords: [
      "i have an idea",
      "feature request",
      "can you add",
      "suggestion",
      "feedback",
      "here is an idea"
    ],
    answer:
      "💡 **Thanks for the idea!**\nExplain what you want added, what problem it solves, and which players it helps. We review feedback often."
  },
  {
    types: ["bug"],
    keywords: [
      "site not loading",
      "website not loading",
      "website down",
      "cant reach site",
      "gamescan down"
    ],
    answer:
      "🌐 **Website issues**\nCheck the **Status** channel for maintenance. Also try refreshing, different browser, or incognito. If only you are affected, share your region + screenshot."
  },
  {
    types: ["bug"],
    keywords: [
      "button not working",
      "buttons not working",
      "nothing happens when i click",
      "cant click button"
    ],
    answer:
      "🖱 **Buttons not working**\nAdblockers/script blockers can break site buttons. Try disabling them for Gamescan or using a private window with extensions off."
  },
  {
    types: ["general_support"],
    keywords: [
      "bot not responding",
      "bot isnt responding",
      "slash commands not working",
      "commands not working",
      "bot offline",
      "gamescan bot not working"
    ],
    answer:
      "🤖 **Bot issues**\nCheck the **Status** channel. Also make sure you’re using commands in allowed channels and that the bot can see and send messages there."
  },
  {
    types: ["general_support"],
    keywords: [
      "how to open a ticket",
      "open ticket",
      "create ticket",
      "submit ticket",
      "support ticket"
    ],
    answer:
      "🎫 **Opening tickets**\nUse the **Ticket** channel and pick a ticket type from the dropdown. The bot creates a private channel for you to explain your issue."
  }
];

function findTicketAutoAnswerWithIndex(content, ticketType) {
  const lower = (content || "").toLowerCase();
  if (!lower.trim()) return { answer: null, index: null };

  const type = ticketType || "general_support";
  let best = null;
  let bestScore = 0;
  let bestIndex = null;

  TICKET_ANSWERS.forEach((entry, idx) => {
    const entryTypes = entry.types && entry.types.length ? entry.types : ["any"];
    if (!entryTypes.includes("any") && !entryTypes.includes(type)) return;

    let score = 0;
    for (const kw of entry.keywords || []) {
      if (!kw) continue;
      if (lower.includes(kw.toLowerCase())) score++;
    }

    if (score > 0 && score >= bestScore) {
      best = entry;
      bestScore = score;
      bestIndex = idx;
    }
  });

  return { answer: best ? best.answer : null, index: bestIndex };
}

// ----- Ticket message handler (no AI, FAQ only) -----
async function handleTicketMessage(message) {
  if (message.author.bot) return;
  const channel = message.channel;

  rememberTicketMessage(message);
  const content = message.content || "";
  const channelId = channel.id;

  // Only try FAQ + soft re-ask if this looks like a REAL question
  if (!isActualQuestion(content)) {
    return; // just store in memory
  }

  const ticketType = getTicketTypeFromChannel(channel);
  const { answer, index } = findTicketAutoAnswerWithIndex(content, ticketType);

  if (answer) {
    setTicketLastFaq(channel.id, index);

    const embed = new EmbedBuilder()
      .setTitle("🤖 Auto-Reply")
      .setColor(0x00ffaa)
      .setDescription(answer)
      .setFooter({ text: "If this doesn’t fully solve it, just reply below." });

    await channel.send({ embeds: [embed] });
    return;
  }

  const mem = ticketMemory.get(channel.id);
  if (mem && mem.lastFaqIndex != null && content.split(/\s+/).length <= 5) {
    const prev = TICKET_ANSWERS[mem.lastFaqIndex];
    if (prev && prev.answer) {
      const followEmbed = new EmbedBuilder()
        .setTitle("🔁 Extra clarification")
        .setColor(0x00ffaa)
        .setDescription(
          prev.answer +
            "\n\nIf this still doesn’t match what you’re asking, let us know a bit more detail."
        );
      await channel.send({ embeds: [followEmbed] });
      return;
    }
  }

  if (!ticketReaskSent.has(channelId)) {
    const reaskEmbed = new EmbedBuilder()
      .setTitle("🤔 I need a bit more detail")
      .setColor(0x00ffaa)
      .setDescription(
        "I couldn't find an instant answer for that yet.\n\n" +
          "Can you clarify a little more **what this is about**? For example:\n" +
          "• Is it about **credits / billing**?\n" +
          "• Is it about **uploading / analysing a clip**?\n" +
          "• Is it about **Live Coaching**?\n" +
          "• Is it about **the website or Discord bot**?\n\n" +
          "Try to mention the feature and what exactly is going wrong in one message."
      );
    await channel.send({ embeds: [reaskEmbed] });
    ticketReaskSent.add(channelId);
    return;
  }

  if (!ticketEscalated.has(channelId)) {
    const embed = new EmbedBuilder()
      .setTitle("👀 Handing this to staff")
      .setColor(0xffa500)
      .setDescription(
        "I still couldn't find an instant answer for that. A staff member will help you shortly — please stay in this ticket.\n\n" +
          "You can keep adding details, but try not to spam messages."
      );
    await channel.send({ embeds: [embed] });
    ticketEscalated.add(channelId);
  }
}

// ------------------------------
// Moderation config
// ------------------------------

// Generic banned words (no real slurs here – add heavier stuff privately)
const BANNED_WORDS = [
  "idiot",
  "loser",
  "dumbass",
  "stupid",
  "trash",
  "noob",
  "badword1",
  "badword2",
  "badword3"
];

const PROMO_PATTERNS = [
  /discord\.gg/i,
  /discord\.com\/invite/i,
  /join my server/i,
  /join our server/i,
  /subscribe to/i,
  /follow my/i,
  /use my code/i
];

// Any URL-ish thing
const ANY_LINK_REGEX = /(https?:\/\/|www\.)\S+/gi;

// Allowed: only Gamescan domain
const GAMESCAN_LINK_REGEX =
  /((https?:\/\/)?(www\.)?gamescan\.gg[^\s]*)/i;

// Results channel: only pure Gamescan result links
const GAMESCAN_RESULT_LINK_REGEX =
  /((https?:\/\/)?(www\.)?gamescan\.gg\/result\/[A-Za-z0-9_-]+(?:\?[^\s]*)?)/i;

const GAMESCAN_NEGATIVE_REGEX =
  /\bgamescan\b.*\b(scam|trash|terrible|awful|bad|fraud|ripoff|fake)/i;

const TOXIC_PATTERNS = [
  /\bkys\b/i,
  /\bkill yourself\b/i,
  /\bgo die\b/i,
  /\bi hate you\b/i,
  /\bworthless\b/i,
  /\bno one likes you\b/i
];

function isCapsSpam(content) {
  const letters = content.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 8) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= 0.7;
}

const REPEAT_CHAR_REGEX = /([A-Za-z!?\.])\1{9,}/;

// ------------------------------
// Spam / raid tracking
// ------------------------------
const spamTracker = new Map(); // key: channelId:userId -> [timestamps]
const SPAM_WINDOW_MS = 10_000;
const SPAM_THRESHOLD = 5;

// Raid = many joins in short time
const RAID_JOIN_WINDOW_MS = 30_000;
const RAID_JOIN_THRESHOLD = 8;
const RAID_MODE_DURATION_MS = 10 * 60 * 1000;
const raidJoinLog = [];
let raidModeUntil = 0;

function isRaidModeActive() {
  return Date.now() < raidModeUntil;
}

function trackSpamAndCheck(message) {
  const now = Date.now();
  const key = `${message.channel.id}:${message.author.id}`;
  let arr = spamTracker.get(key) || [];
  arr.push(now);
  arr = arr.filter((t) => now - t < SPAM_WINDOW_MS);
  spamTracker.set(key, arr);
  return arr.length >= SPAM_THRESHOLD;
}

async function handleModerationDelete(message, reason) {
  try {
    await message.delete();
  } catch {
    // ignore
  }

  let noticeText = `⚠️ ${message.author}, your message was removed: **${reason}**`;

  const lowerReason = reason.toLowerCase();
  if (lowerReason.includes("spam")) {
    if (isTicketChannel(message.channel)) {
      noticeText =
        `🚫 ${message.author}, we can't help with random spamming in support tickets.\n` +
        "Please send **one clear message** explaining your problem instead of lots of short messages.";
    } else {
      noticeText = `🚫 ${message.author}, please stop spamming.`;
    }
  }

  try {
    const warn = await message.channel.send({ content: noticeText });
    setTimeout(() => warn.delete().catch(() => {}), 10_000);
  } catch {}

  if (!MOD_LOG_CHANNEL_ID) return;

  try {
    const logChannel = await client.channels.fetch(MOD_LOG_CHANNEL_ID);
    if (logChannel && logChannel.isTextBased()) {
      await logChannel.send({
        content:
          `🧹 **Message removed** in <#${message.channel.id}> by ${message.author.tag}\n` +
          `**Reason:** ${reason}\n` +
          `**Content:** ${message.content}`
      });
    }
  } catch (err) {
    console.warn("⚠️ Failed to write mod-log:", err.message);
  }
}

async function registerViolation(message, baseReason) {
  const userId = message.author.id;
  const entry = userStrikes.get(userId) || { count: 0, lastAt: 0 };
  const strikes = entry.count + 1;

  userStrikes.set(userId, { count: strikes, lastAt: Date.now() });
  const reasonWithStrike = `${baseReason} (Strike ${strikes}/${STRIKE_LIMIT})`;

  await handleModerationDelete(message, reasonWithStrike);

  if (strikes < STRIKE_LIMIT) return;

  const me = message.guild.members.me;
  const canTimeout =
    me &&
    me.permissions.has(PermissionsBitField.Flags.ModerateMembers) &&
    message.member;

  if (!canTimeout) {
    console.warn("⚠️ Reached strike limit but cannot timeout");
    return;
  }

  try {
    await message.member.timeout(
      TIMEOUT_MS,
      `Gamescan auto-mod: ${baseReason} — reached ${STRIKE_LIMIT} strikes`
    );
    userStrikes.set(userId, { count: 0, lastAt: Date.now() });

    const minutes = Math.round(TIMEOUT_MS / 60000);
    const note = await message.channel.send({
      content: `⛔ ${message.author} has been timed out for **${minutes} minutes** (3 strikes).`
    });
    setTimeout(() => note.delete().catch(() => {}), 15_000);
  } catch (err) {
    console.error("❌ Timeout failed:", err);
  }
}

async function handleStrikesCommand(message) {
  const content = message.content.trim();
  const parts = content.split(/\s+/);

  let targetUser = null;

  if (parts.length === 1) {
    targetUser = message.author;
  } else if (message.mentions.users.size > 0) {
    targetUser = message.mentions.users.first();
  } else {
    const rawId = parts[1].replace(/[<@!>]/g, "");
    try {
      targetUser = await message.client.users.fetch(rawId);
    } catch {
      targetUser = null;
    }
  }

  if (!targetUser) {
    const reply = await message.channel.send("❓ I couldn't find that user.");
    setTimeout(() => reply.delete().catch(() => {}), 8000);
    return;
  }

  if (
    targetUser.id !== message.author.id &&
    !(
      message.member &&
      message.member.permissions.has(
        PermissionsBitField.Flags.ManageMessages
      )
    )
  ) {
    const reply = await message.channel.send(
      "🔒 You can only check your **own** strikes."
    );
    setTimeout(() => reply.delete().catch(() => {}), 8000);
    return;
  }

  const entry = userStrikes.get(targetUser.id);
  const count = entry ? entry.count : 0;

  const reply = await message.channel.send(
    `📊 Strikes for ${targetUser}: **${count}/${STRIKE_LIMIT}**`
  );
  setTimeout(() => reply.delete().catch(() => {}), 10_000);
}

// ------------------------------
// Role sync state
// ------------------------------
const trackedDiscordIds = new Set();
const PLAN_ROLE_IDS = {
  Free: FREE_ROLE_ID || null,
  Gamer: GAMER_ROLE_ID || null,
  Pro: PRO_ROLE_ID || null,
  Master: MASTER_ROLE_ID || null
};

// ------------------------------
// WordPress helpers
// ------------------------------
function normalizeBase(url) {
  if (!url) return null;
  return url.replace(/\/+$/, "");
}

async function fetchUserSummaryFromWP(discordId) {
  const base = normalizeBase(WP_API_BASE);
  if (!base || !WP_BOT_KEY) {
    console.warn("⚠️ WP_API_BASE or WP_BOT_KEY not set; skipping WP lookup");
    return null;
  }

  try {
    const res = await fetch(`${base}/wp-json/gamescan-discord/v1/user-summary`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bot-key": WP_BOT_KEY
      },
      body: JSON.stringify({ discord_id: discordId })
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      console.error("❌ Failed to parse WP JSON:", text);
      return null;
    }

    if (!res.ok) {
      console.warn("⚠️ WP summary error:", res.status, json);
      return json || null;
    }

    if (json && json.ok !== false) {
      trackedDiscordIds.add(String(discordId));
    }

    return json;
  } catch (err) {
    console.error("❌ WP request error:", err);
    return null;
  }
}

// ------------------------------
// Plan role sync
// ------------------------------
async function syncMemberPlanRole(member, summary) {
  if (!member || !member.guild) return;
  if (!summary || summary.ok === false) return;

  const planName = summary?.plan?.name || "Free";
  const targetRoleId = PLAN_ROLE_IDS[planName] || null;

  const planRoleIds = Object.values(PLAN_ROLE_IDS).filter(Boolean);

  for (const rid of planRoleIds) {
    if (!rid) continue;
    const role = member.guild.roles.cache.get(rid);
    if (!role) continue;
    if (targetRoleId === rid) {
      if (!member.roles.cache.has(rid)) {
        try {
          await member.roles.add(role, "Gamescan plan sync (matched plan)");
        } catch (err) {
          console.warn("⚠️ Failed to add plan role:", err.message);
        }
      }
    } else {
      if (member.roles.cache.has(rid)) {
        try {
          await member.roles.remove(role, "Gamescan plan sync (cleanup)");
        } catch (err) {
          console.warn("⚠️ Failed to remove plan role:", err.message);
        }
      }
    }
  }
}

async function syncAllTrackedRoleMappings() {
  if (!GUILD_ID) return;
  if (!trackedDiscordIds.size) return;

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch(); // ensure cache

    for (const discordId of trackedDiscordIds) {
      const member = guild.members.cache.get(discordId);
      if (!member) continue;
      try {
        const summary = await fetchUserSummaryFromWP(discordId);
        if (summary && summary.ok !== false) {
          await syncMemberPlanRole(member, summary);
        }
      } catch (err) {
        console.warn(`⚠️ Role sync failed for ${discordId}:`, err.message);
      }
    }
  } catch (err) {
    console.error("❌ syncAllTrackedRoleMappings error:", err);
  }
}

// ------------------------------
// Slash embed builders
// ------------------------------
function buildCreditsEmbed(user, summary) {
  let monthly = 0;
  let extra = 0;
  let total = 0;

  if (summary && summary.credits) {
    monthly = summary.credits.monthly ?? 0;
    extra = summary.credits.extra ?? 0;
    total = summary.credits.total ?? monthly + extra;
  }

  return new EmbedBuilder()
    .setTitle("💳 Gamescan Credits")
    .setColor(0x00ffaa)
    .setDescription(
      "Here’s your current Gamescan credit balance linked to this Discord account."
    )
    .addFields(
      {
        name: "Monthly credits",
        value: `${monthly}`,
        inline: true
      },
      {
        name: "Extra credits",
        value: `${extra}`,
        inline: true
      },
      {
        name: "Total available",
        value: `${total}`,
        inline: true
      }
    )
    .setFooter({ text: "Gamescan.gg • Use /usage for more detail" })
    .setTimestamp();
}

function buildPlanEmbed(user, summary) {
  const planName = summary?.plan?.name || "Free";
  const monthlyCap = summary?.plan?.monthly_credit_cap ?? 10;

  let features = [
    "AI Clip Analysis",
    "Shareable results page",
    "Discord support"
  ];

  if (planName === "Pro" || planName === "Master") {
    features.push("Priority queue", "Early access to new features");
  }
  if (planName === "Master") {
    features.push("Best Live Coaching access (when available)");
  }

  return new EmbedBuilder()
    .setTitle("📦 Gamescan Plan")
    .setColor(0x00ffaa)
    .addFields(
      {
        name: "Current plan",
        value: `**${planName}**`,
        inline: true
      },
      {
        name: "Monthly credit allowance",
        value: `${monthlyCap}`,
        inline: true
      },
      {
        name: "Features",
        value: "• " + features.join("\n• ")
      }
    )
    .setFooter({ text: "Manage your plan on the Gamescan Subscriptions page" })
    .setTimestamp();
}

function buildUsageEmbed(user, summary) {
  const cu = summary?.usage?.credits_used_month ?? 0;
  const ac = summary?.usage?.analyses_completed ?? 0;
  const lm = summary?.usage?.live_minutes_used ?? 0;

  return new EmbedBuilder()
    .setTitle("📊 Gamescan Usage")
    .setColor(0x00ffaa)
    .addFields(
      {
        name: "Credits used this month",
        value: `${cu}`,
        inline: true
      },
      {
        name: "Analyses completed",
        value: `${ac}`,
        inline: true
      },
      {
        name: "Live coaching minutes",
        value: `${lm}`,
        inline: true
      }
    )
    .setFooter({
      text: "Gamescan.gg • Usage resets at the start of each billing month"
    })
    .setTimestamp();
}

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setTitle("📖 Gamescan Bot — Commands")
    .setColor(0x00ffaa)
    .setDescription("Here are the available user commands:")
    .addFields(
      {
        name: "/credits",
        value:
          "Shows your current Gamescan credit balance (monthly, extra, total)."
      },
      {
        name: "/plan",
        value: "Shows your active plan (Free / Gamer / Pro / Master)."
      },
      {
        name: "/usage",
        value: "Shows recent usage: credits used, analyses, coaching minutes."
      },
      {
        name: "/status",
        value: "Shows the current Gamescan system status."
      },
      {
        name: "/help",
        value: "Shows this help message."
      }
    )
    .setFooter({ text: "Gamescan.gg • Use tickets for more detailed support" });
}

function buildSlashStatusEmbed() {
  return buildStatusEmbed().setTitle("🎮 Gamescan System Status");
}

// ------------------------------
// Slash command registration
// ------------------------------
async function registerSlashCommands() {
  const commands = [
    { name: "credits", description: "Show your Gamescan credit balance" },
    { name: "plan", description: "Show your active Gamescan plan" },
    { name: "usage", description: "Show your recent Gamescan usage" },
    { name: "help", description: "List Gamescan bot commands" },
    { name: "status", description: "Show Gamescan system status" }
  ];

  try {
    if (GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.commands.set(commands);
      console.log("✅ Registered slash commands (guild)");
    } else if (client.application) {
      await client.application.commands.set(commands);
      console.log("✅ Registered slash commands (global)");
    } else {
      console.warn("⚠️ client.application not ready for commands");
    }
  } catch (err) {
    console.error("❌ registerSlashCommands error:", err);
  }
}

// ------------------------------
// Discord events
// ------------------------------
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  await ensureStatusMessage();
  await ensureRulesMessage();
  await ensureTicketPanel();
  await ensureInfoEmbeds();
  await registerSlashCommands();

  // Fake queue jiggle for status
  setInterval(async () => {
    const delta = randomInt(-1, 1);
    queueSize += delta;
    if (queueSize < 1) queueSize = 1;
    if (queueSize > 5) queueSize = 5;
    await updateStatusMessage();
  }, 60_000);

  // Strike decay
  setInterval(decayStrikes, 5 * 60 * 1000);

  // Plan role sync every 30 minutes
  setInterval(() => {
    syncAllTrackedRoleMappings().catch((err) =>
      console.error("❌ Periodic role sync error:", err)
    );
  }, 30 * 60 * 1000);
});

client.on("guildMemberAdd", async (member) => {
  try {
    if (GUILD_ID && member.guild.id !== GUILD_ID) return;

    // --- RAID tracking (join spam) ---
    const now = Date.now();
    raidJoinLog.push(now);
    while (raidJoinLog.length && now - raidJoinLog[0] > RAID_JOIN_WINDOW_MS) {
      raidJoinLog.shift();
    }
    if (raidJoinLog.length >= RAID_JOIN_THRESHOLD && !isRaidModeActive()) {
      raidModeUntil = now + RAID_MODE_DURATION_MS;
      console.warn("⚠️ Raid mode activated for 10 minutes (join spike)");

      if (MOD_LOG_CHANNEL_ID) {
        try {
          const logChannel = await member.client.channels.fetch(
            MOD_LOG_CHANNEL_ID
          );
          if (logChannel && logChannel.isTextBased()) {
            await logChannel.send(
              "🚨 **Raid protection enabled:** many accounts joined in a short time. Extra spam checks are active."
            );
          }
        } catch (err) {
          console.warn("⚠️ Failed to send raid log message:", err.message);
        }
      }
    }

    // base Free role
    let freeRole = null;
    if (FREE_ROLE_ID) {
      freeRole = member.guild.roles.cache.get(FREE_ROLE_ID);
    }
    if (!freeRole) {
      freeRole = member.guild.roles.cache.find(
        (r) => r.name.toLowerCase() === "free"
      );
    }

    if (freeRole) {
      try {
        await member.roles.add(freeRole, "Auto-assign Free role on join");
      } catch (err) {
        console.warn("⚠️ Failed to give Free role:", err.message);
      }
    }

    // Try to sync plan roles if their Discord is linked in WP
    try {
      const summary = await fetchUserSummaryFromWP(member.id);
      if (summary && summary.ok !== false) {
        trackedDiscordIds.add(String(member.id));
        await syncMemberPlanRole(member, summary);
      }
    } catch (err) {
      console.warn("⚠️ Role sync on join failed:", err.message);
    }

    // Welcome DM
    try {
      await member.send(
        "👋 Welcome to the **Gamescan** Discord!\n\n" +
          "You’ve been given the **Free** role. Use this server for updates, support tickets, and bot commands.\n\n" +
          "Please read the rules and enjoy your stay! 🎮"
      );
    } catch (err) {
      console.warn("⚠️ Could not DM new member:", err.message);
    }
  } catch (err) {
    console.error("❌ guildMemberAdd error:", err);
  }
});

// ------------------------------
// Ticket creation (Ticket-(number) style)
// ------------------------------
async function handleTicketSelect(interaction) {
  if (interaction.customId !== "gamescan_ticket_type") return;
  const value = interaction.values && interaction.values[0];
  if (!value) {
    await interaction.reply({
      content: "⚠️ Something went wrong with that selection.",
      ephemeral: true
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "⚠️ This can only be used inside a server.",
      ephemeral: true
    });
    return;
  }

  try {
    const user = interaction.user;

    // Simple numeric ticket ID based on timestamp (last 5 digits)
    const ticketNumber = Date.now().toString().slice(-5);
    const channelName = `ticket-${ticketNumber}`;

    const everyoneRole = guild.roles.everyone;
    const supportRole =
      (SUPPORT_ROLE_ID && guild.roles.cache.get(SUPPORT_ROLE_ID)) || null;
    const botMember = guild.members.me;

    const permissionOverwrites = [
      {
        id: everyoneRole.id,
        deny: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory
        ]
      },
      {
        id: botMember.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.ManageMessages
        ]
      }
    ];

    if (supportRole) {
      permissionOverwrites.push({
        id: supportRole.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory
        ]
      });
    }

    const topicOwner = `Owner:${user.id}`;
    const topicType = `Type:${value}`;

    const channelOptions = {
      name: channelName,
      type: ChannelType.GuildText,
      permissionOverwrites,
      reason: `Ticket created by ${user.tag} (${value})`,
      topic: `Gamescan ticket | ${topicOwner} | ${topicType}`
    };

    if (TICKET_CATEGORY_ID) {
      channelOptions.parent = TICKET_CATEGORY_ID;
    }

    const ticketChannel = await guild.channels.create(channelOptions);
    const introText = getTicketIntroText(value, `<@${user.id}>`);

    const introEmbed = new EmbedBuilder()
      .setTitle("🎫 New Gamescan Ticket")
      .setColor(0x00ffaa)
      .setDescription(introText)
      .addFields(
        { name: "Ticket type", value: value.replace("_", " "), inline: true },
        { name: "Owner", value: `<@${user.id}>`, inline: true },
        { name: "Ticket ID", value: `#${ticketNumber}`, inline: true }
      )
      .setFooter({ text: "Gamescan.gg • Auto-support + human backup" });

    await ticketChannel.send({ embeds: [introEmbed] });
    await ticketChannel.send({
      content:
        "When you're done, you can close this ticket using the button below.",
      components: [buildCloseTicketRow()]
    });

    await interaction.reply({
      content: `🎫 Your ticket has been created: ${ticketChannel} (ID: #${ticketNumber})`,
      ephemeral: true
    });
  } catch (err) {
    console.error("❌ Failed to create ticket:", err);
    try {
      await interaction.reply({
        content:
          "⚠️ I couldn't create your ticket. Please contact a staff member.",
        ephemeral: true
      });
    } catch {
      // ignore
    }
  }
}

async function handleCloseTicketButton(interaction) {
  const channel = interaction.channel;
  if (!isTicketChannel(channel)) {
    await interaction.reply({
      content: "⚠️ This button only works in ticket channels.",
      ephemeral: true
    });
    return;
  }

  const ownerId = getTicketOwnerIdFromChannel(channel);
  const member = interaction.member;
  const isOwner = ownerId && interaction.user.id === ownerId;
  const isStaff =
    member &&
    member.permissions.has(PermissionsBitField.Flags.ManageMessages);

  if (!isOwner && !isStaff) {
    await interaction.reply({
      content: "🔒 Only the ticket owner or staff can close this ticket.",
      ephemeral: true
    });
    return;
  }

  try {
    if (ownerId) {
      await channel.permissionOverwrites.edit(ownerId, {
        ViewChannel: false,
        SendMessages: false
      });
    }

    if (channel.name.startsWith("ticket-")) {
      const newName = channel.name.replace(/^ticket-/, "closed-");
      await channel.setName(newName);
    }

    await channel.send(
      `🔒 Ticket closed by <@${interaction.user.id}>. Staff can still view this channel for logs.`
    );

    await interaction.reply({
      content: "✅ Ticket closed.",
      ephemeral: true
    });
  } catch (err) {
    console.error("❌ close ticket error:", err);
    await interaction.reply({
      content: "⚠️ Something went wrong while closing this ticket.",
      ephemeral: true
    });
  }
}

// ------------------------------
// Discord message handler
// ------------------------------
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (GUILD_ID && message.guild.id !== GUILD_ID) return;

    const content = message.content || "";
    const lower = content.toLowerCase();

    const isResultsChannel =
      RESULTS_CHANNEL_ID && message.channel.id === RESULTS_CHANNEL_ID;

    // Commands channel: delete everything that's not slash commands
    if (COMMANDS_CHANNEL_ID && message.channel.id === COMMANDS_CHANNEL_ID) {
      try {
        await message.delete();
      } catch {
        // ignore
      }
      try {
        await message.author.send(
          "⚙️ The **commands** channel is for `/` commands only.\n" +
            "Use the slash menu (`/`) and pick a command like `/help`, `/credits`, or `/status`."
        );
      } catch (err) {
        console.warn(
          "⚠️ Could not DM user about commands-only channel:",
          err.message
        );
      }
      return;
    }

    // Staff-only ticket summary
    if (
      lower.startsWith("!summary") &&
      isTicketChannel(message.channel) &&
      message.member &&
      message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)
    ) {
      const summary = getTicketSummary(message.channel.id);
      const embed = new EmbedBuilder()
        .setTitle("📝 Ticket Summary (recent)")
        .setColor(0x00ffaa)
        .setDescription(summary);
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // Strikes command
    if (lower.startsWith("!strikes")) {
      await handleStrikesCommand(message);
      return;
    }

    const member = message.member;
    const isStaff =
      member &&
      member.permissions.has(PermissionsBitField.Flags.ManageMessages);

    // Parse links in message (for link rules)
    const linksInMessage = content.match(ANY_LINK_REGEX) || [];
    const hasLinks = linksInMessage.length > 0;
    const hasNonGamescanLink = linksInMessage.some(
      (link) => !GAMESCAN_LINK_REGEX.test(link)
    );

    // Special rules for RESULTS channel:
    // Only accept a single Gamescan /result/<token> link and nothing else.
    if (isResultsChannel) {
      const trimmed = content.trim();
      const resultMatch = trimmed.match(GAMESCAN_RESULT_LINK_REGEX);

      const onlyResultLink =
        resultMatch &&
        hasLinks &&
        linksInMessage.length === 1 &&
        linksInMessage[0] === resultMatch[0] &&
        trimmed === resultMatch[0];

      if (!onlyResultLink) {
        await handleModerationDelete(
          message,
          "Results channel is only for pure Gamescan result links like https://gamescan.gg/result/your-token"
        );
        return;
      }

      // Valid result link – accept it and don't do anything else.
      return;
    }

    // --- RAID MODE extra protection ---
    if (isRaidModeActive() && !isStaff) {
      if (hasNonGamescanLink || isCapsSpam(content) || REPEAT_CHAR_REGEX.test(content)) {
        await registerViolation(message, "Raid / spam protection active");
        return;
      }
    }

    // Staff bypass normal moderation but still get ticket logic
    if (isStaff) {
      if (isTicketChannel(message.channel)) {
        const convoReply = getConversationReply(content);
        if (convoReply && canReplyToUser(message.author.id)) {
          await message.channel.send({ content: convoReply });
        }
        await handleTicketMessage(message);
      }
      return;
    }

    // --- Spam detection (per channel + user) ---
    if (trackSpamAndCheck(message)) {
      if (isTicketChannel(message.channel)) {
        await registerViolation(message, "Ticket spam / flooding");
      } else {
        await registerViolation(message, "Spam / flooding messages");
      }
      return;
    }

    // Normal moderation

    // 1) Any non-Gamescan links anywhere
    if (hasNonGamescanLink) {
      await registerViolation(message, "Only Gamescan links are allowed here");
      return;
    }

    // 2) Banned words
    if (BANNED_WORDS.some((w) => w && lower.includes(w.toLowerCase()))) {
      await registerViolation(message, "Banned word detected");
      return;
    }

    // 3) Promo / self-advertising patterns
    if (PROMO_PATTERNS.some((re) => re.test(content))) {
      await registerViolation(
        message,
        "Promo / self-advertising is not allowed"
      );
      return;
    }

    // 4) Mass pings
    if (content.includes("@everyone") || content.includes("@here")) {
      await registerViolation(
        message,
        "Mass ping (@everyone/@here) is not allowed"
      );
      return;
    }

    // 5) Toxic messages
    if (TOXIC_PATTERNS.some((re) => re.test(content))) {
      await registerViolation(message, "Toxic / harassing message");
      return;
    }

    // 6) ALL CAPS spam
    if (isCapsSpam(content)) {
      await registerViolation(message, "Please avoid ALL CAPS spam");
      return;
    }

    // 7) repeated character spam
    if (REPEAT_CHAR_REGEX.test(content)) {
      await registerViolation(message, "Repeated character spam");
      return;
    }

    // 8) Negative / slanderous about Gamescan
    if (GAMESCAN_NEGATIVE_REGEX.test(content)) {
      await registerViolation(
        message,
        "Negative / slanderous message about Gamescan"
      );
      return;
    }

    // Friendly conversation + ticket auto-answer ONLY in ticket channels
    if (isTicketChannel(message.channel)) {
      const convoReply = getConversationReply(content);
      if (convoReply && canReplyToUser(message.author.id)) {
        await message.channel.send({ content: convoReply });
      }
      await message.channel.sendTyping();
      await handleTicketMessage(message);
      return;
    }

    // In all other channels: no support replies, just moderation above.
  } catch (err) {
    console.error("❌ messageCreate error:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isStringSelectMenu()) {
      await handleTicketSelect(interaction);
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === "gamescan_close_ticket") {
        await handleCloseTicketButton(interaction);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName, user } = interaction;

    if (
      ["credits", "plan", "usage", "help", "status"].includes(
        commandName
      )
    ) {
      await interaction.deferReply({ ephemeral: true });
    }

    if (commandName === "credits") {
      const summary = await fetchUserSummaryFromWP(user.id);
      if (interaction.member && summary && summary.ok !== false) {
        await syncMemberPlanRole(interaction.member, summary);
      }
      const embed = buildCreditsEmbed(user, summary);
      await interaction.editReply({ embeds: [embed] });
    } else if (commandName === "plan") {
      const summary = await fetchUserSummaryFromWP(user.id);
      if (interaction.member && summary && summary.ok !== false) {
        await syncMemberPlanRole(interaction.member, summary);
      }
      const embed = buildPlanEmbed(user, summary);
      await interaction.editReply({ embeds: [embed] });
    } else if (commandName === "usage") {
      const summary = await fetchUserSummaryFromWP(user.id);
      if (interaction.member && summary && summary.ok !== false) {
        await syncMemberPlanRole(interaction.member, summary);
      }
      const embed = buildUsageEmbed(user, summary);
      await interaction.editReply({ embeds: [embed] });
    } else if (commandName === "help") {
      await interaction.editReply({ embeds: [buildHelpEmbed()] });
    } else if (commandName === "status") {
      await interaction.editReply({ embeds: [buildSlashStatusEmbed()] });
    }
  } catch (err) {
    console.error("❌ interactionCreate error:", err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "⚠️ Something went wrong handling that.",
          ephemeral: true
        });
      } else if (interaction.deferred) {
        await interaction.editReply({
          content: "⚠️ Something went wrong handling that command."
        });
      }
    } catch {}
  }
});

// ------------------------------
// HTTP server for Render
// ------------------------------
const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("✅ Gamescan Discord bot is running.");
});

// Status hook (used by your WP admin panel)
app.post("/gamescan/status", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (STATUS_API_KEY && apiKey !== STATUS_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { aiClip, liveCoaching, queue } = req.body || {};

    if (aiClip === "live" || aiClip === "down") aiClipStatus = aiClip;
    if (
      liveCoaching === "live" ||
      liveCoaching === "down" ||
      liveCoaching === "coming_soon"
    ) {
      liveCoachingStatus = liveCoaching;
    }
    if (typeof queue === "number" && !Number.isNaN(queue)) {
      const q = Math.round(queue);
      queueSize = Math.min(5, Math.max(1, q));
    }

    await updateStatusMessage();

    res.json({
      ok: true,
      aiClipStatus,
      liveCoachingStatus,
      queueSize
    });
  } catch (err) {
    console.error("❌ /gamescan/status error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Hook from WordPress when a Discord account is linked
// WordPress should POST here after linking, with:
// headers: { "x-api-key": WP_BOT_KEY }
// body: { "discord_id": "123456789012345678" }
app.post("/gamescan/linked", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (WP_BOT_KEY && apiKey !== WP_BOT_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { discord_id } = req.body || {};
    if (!discord_id) {
      return res.status(400).json({ error: "discord_id is required" });
    }
    if (!GUILD_ID) {
      return res.status(400).json({ error: "GUILD_ID not configured" });
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discord_id).catch(() => null);
    if (!member) {
      return res.status(404).json({ error: "Member not found in guild" });
    }

    const summary = await fetchUserSummaryFromWP(discord_id);
    if (!summary || summary.ok === false) {
      return res
        .status(404)
        .json({ error: "No valid Gamescan account summary for this Discord ID" });
    }

    trackedDiscordIds.add(String(discord_id));
    await syncMemberPlanRole(member, summary);

    // Optional "Linked" role
    let linkedRoleAdded = false;
    if (LINKED_ROLE_ID) {
      const linkedRole = guild.roles.cache.get(LINKED_ROLE_ID);
      if (linkedRole && !member.roles.cache.has(LINKED_ROLE_ID)) {
        try {
          await member.roles.add(
            linkedRole,
            "Gamescan account linked (Linked role)"
          );
          linkedRoleAdded = true;
        } catch (err) {
          console.warn("⚠️ Failed to add Linked role:", err.message);
        }
      }
    }

    // Optionally send them a DM
    try {
      await member.send(
        "✅ Your **Gamescan** account has been linked to Discord.\n" +
          "Your plan role has been synced in the server."
      );
    } catch (err) {
      console.warn("⚠️ Could not DM member after link:", err.message);
    }

    res.json({
      ok: true,
      plan: summary.plan?.name || "Free",
      linkedRoleAdded
    });
  } catch (err) {
    console.error("❌ /gamescan/linked error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const port = Number(PORT) || 3000;
app.listen(port, () => {
  console.log(`🌐 HTTP server listening on port ${port}`);
});

// ------------------------------
// Login
// ------------------------------
client.login(DISCORD_TOKEN).catch((err) => {
  console.error("❌ Failed to login:", err);
  process.exit(1);
});
