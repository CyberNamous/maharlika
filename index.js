const http = require('http');
const { Client, GatewayIntentBits, ActivityType, EmbedBuilder, Events, MessageFlags } = require('discord.js');

const SITE = (process.env.SITE_URL || 'https://pinoylegends.cybernamous.workers.dev').replace(/\/$/, '');
const INVITE = process.env.DISCORD_INVITE || 'Not set yet';
const ALERT_CHANNEL = process.env.ALERT_CHANNEL_ID;       // staff channel: down/up alerts
const ANNOUNCE_CHANNEL = process.env.ANNOUNCE_CHANNEL_ID; // public channel: new posts/heroes
const STATUS_CHANNEL = process.env.STATUS_CHANNEL_ID;       // read-only channel with the live card
const CHECK_EVERY = 2 * 60 * 1000;                        // check the site every 2 minutes
const startedAt = Date.now();

// Tiny web endpoint so Render (and the pinger) have something to hit
http.createServer((req, res) => { res.writeHead(200); res.end('ok'); })
  .listen(process.env.PORT || 3000);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,   // privileged: lets the bot tell members from bots
    GatewayIntentBits.GuildPresences, // privileged: online / idle / dnd counts only
  ],
});

const commands = [
  { name: 'ping', description: 'Check if Maharlika is alive' },
  { name: 'status', description: 'Check if the Pinoy Legends website is online' },
  { name: 'uptime', description: 'How long Maharlika has been running' },
  { name: 'links', description: 'Official Pinoy Legends links' },
  { name: 'about', description: 'About Maharlika and Pinoy Legends' },
];

// ---------- site monitoring ----------
let siteUp = null;        // null until first check
let lastVersion = null;   // content version from /api/public
let seenPosts = null;     // Set of post ids
let seenHeroes = null;    // Set of hero ids
let downSince = null;
let maintPhase = null;     // off | scheduled | notice | active (from /api/maintenance)
let lastScheduled = null;  // start time of the last maintenance we announced
let siteMs = null;        // last response time in ms
let recoveredAt = 0;      // when the site last came back

async function sendTo(channelId, payload) {
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    if (ch && ch.isTextBased()) await ch.send(payload);
  } catch (e) { console.error('send failed', e.message); }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

async function checkSite() {
  let up = false, data = null;
  try {
    const url = SITE + '/api/public' + (lastVersion ? `?version=${encodeURIComponent(lastVersion)}` : '');
    const t0 = Date.now();
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    siteMs = Date.now() - t0;
    up = r.ok;
    if (r.ok) data = await r.json();
  } catch { up = false; }

  // maintenance state + announcements
  let phaseChanged = false;
  try {
    const r2 = await fetch(SITE + '/api/maintenance', { signal: AbortSignal.timeout(8000) });
    if (r2.ok) {
      const mt = await r2.json();
      const prev = maintPhase;
      phaseChanged = prev !== mt.phase;
      maintPhase = mt.phase;
      const ts = (iso) => Math.floor(Date.parse(iso) / 1000);
      if (prev !== null) {
        if (mt.phase === 'active' && prev !== 'active') {
          await sendTo(ANNOUNCE_CHANNEL, { embeds: [new EmbedBuilder().setColor(0xf5b82e)
            .setTitle('🛠️ Maintenance has started')
            .setDescription('The website is temporarily closed.' + (mt.end ? ` Expected back <t:${ts(mt.end)}:R>.` : ''))
            .setTimestamp()] });
        } else if (prev === 'active' && mt.phase !== 'active') {
          await sendTo(ANNOUNCE_CHANNEL, { embeds: [new EmbedBuilder().setColor(0x2ecc71)
            .setTitle("✅ We're back!").setDescription('Maintenance is over and the website is open again.').setTimestamp()] });
        }
      }
      const upcoming = mt.phase === 'scheduled' || mt.phase === 'notice' ? mt.start : null;
      if (upcoming !== lastScheduled) {
        if (prev !== null && upcoming) {
          await sendTo(ANNOUNCE_CHANNEL, { embeds: [new EmbedBuilder().setColor(0xf5b82e)
            .setTitle('🛠️ Scheduled maintenance')
            .setDescription(`Starts <t:${ts(upcoming)}:F> (<t:${ts(upcoming)}:R>)` + (mt.end ? `, expected to end <t:${ts(mt.end)}:F>.` : '.'))
            .setTimestamp()] });
        }
        lastScheduled = upcoming;
      }
    }
  } catch { /* keep the last known state */ }

  // up/down transitions
  if (siteUp !== null && up !== siteUp) {
    if (!up) {
      downSince = Date.now();
      await sendTo(ALERT_CHANNEL, { embeds: [new EmbedBuilder().setColor(0xe74c3c)
        .setTitle('🔴 Website is down').setDescription(SITE).setTimestamp()] });
    } else {
      const mins = downSince ? Math.max(1, Math.round((Date.now() - downSince) / 60000)) : '?';
      await sendTo(ALERT_CHANNEL, { embeds: [new EmbedBuilder().setColor(0x2ecc71)
        .setTitle('🟢 Website is back online').setDescription(`Down for about ${mins} min.`).setTimestamp()] });
      downSince = null;
    }
  }
  const changed = siteUp !== up || phaseChanged;
  if (up && siteUp === false) recoveredAt = Date.now();
  siteUp = up;
  if (changed) refresh();

  // content changes
  if (!up || !data) return;
  if (data.unchanged) return;
  const first = seenPosts === null;
  const posts = data.posts || [];
  const heroes = data.heroes || [];
  if (!first) {
    for (const p of posts.filter(p => !seenPosts.has(p.id)).reverse()) {
      const embed = new EmbedBuilder().setColor(0xf5b82e)
        .setTitle('📢 ' + clip(p.title, 200))
        .setDescription(clip(p.body || '', 400))
        .setURL(SITE + '/news')
        .setFooter({ text: p.kind === 'developer' ? 'Developer update' : 'Official announcement' })
        .setTimestamp(new Date(p.created_at));
      if (p.image_key) embed.setImage(SITE + '/media/' + p.image_key);
      await sendTo(ANNOUNCE_CHANNEL, { embeds: [embed] });
    }
    for (const h of heroes.filter(h => !seenHeroes.has(h.id))) {
      const embed = new EmbedBuilder().setColor(0x7dd3fc)
        .setTitle('⚔️ New hero revealed: ' + clip(h.name, 100))
        .setDescription(`**${h.role}**\n${clip(h.description || '', 300)}`)
        .setURL(SITE + '/heroes');
      if (h.image_key) embed.setImage(SITE + '/media/' + h.image_key);
      await sendTo(ANNOUNCE_CHANNEL, { embeds: [embed] });
    }
  }
  seenPosts = new Set(posts.map(p => p.id));
  seenHeroes = new Set(heroes.map(h => h.id));
  lastVersion = data.version || lastVersion;
}

// ---------- presence (Philippine time) ----------
let n = 0;

function manilaMinutes() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  return Number(p.find(x => x.type === 'hour').value) * 60 + Number(p.find(x => x.type === 'minute').value);
}

// Daily schedule (Manila time):
//   9:01 PM - 6:59 AM  sleeping (idle)
//   11:00 AM - 1:00 PM lunch break (do not disturb)
//   3:00 PM - 4:00 PM  merienda (online)
//   everything else    awake (online)
function period() {
  const t = manilaMinutes();
  if (t > 21 * 60 || t < 7 * 60) return 'sleep';
  if (t >= 11 * 60 && t < 13 * 60) return 'lunch';
  if (t >= 15 * 60 && t < 16 * 60) return 'merienda';
  return 'awake';
}

const C = (text) => ({ type: ActivityType.Custom, name: 'custom', state: text });
const A = (type, name) => ({ type, name });

const pools = {
  awake: [
    A(ActivityType.Watching, 'Website: Online'),
    A(ActivityType.Watching, 'Over Pinoy Legends'),
    A(ActivityType.Listening, 'for Testing News'),
    A(ActivityType.Competing, 'for the Battlefield'),
    A(ActivityType.Playing, 'Tumbang Preso'),
    A(ActivityType.Watching, 'the Lanes'),
    A(ActivityType.Watching, 'Heroes Rise'),
    A(ActivityType.Playing, 'Patintero with the Lag'),
    A(ActivityType.Playing, 'Hide and Seek with Bugs'),
    C('Counting minions… 1, 2, 3, wait'),
    C('Debugging the battlefield 🛠️'),
    C('Ready to serve, kabayan! 🇵🇭'),
  ],
  lunch: [
    C('Eating lunch 🍚 Back at 1:00 PM'),
    C('Lunch break! Please do not disturb'),
    A(ActivityType.Watching, 'the Adobo Cool Down'),
    A(ActivityType.Playing, 'Kain Muna'),
    C('Sinigang first, bugs later 🍲'),
  ],
  merienda: [
    C('Merienda time! 🍢 Kwek-kwek break'),
    C('Sipping kape ☕ Wait lang'),
    A(ActivityType.Playing, 'Pandesal Simulator'),
  ],
  sleep: [
    C('Zzz… resting until 7:00 AM'),
    C('Dreaming of the Battlefield 💤'),
  ],
};

let currentLine = 'Getting ready…';
let lastPick = null;

function describe(a) {
  if (a.type === ActivityType.Custom) return a.state;
  const verb = {
    [ActivityType.Playing]: 'Playing',
    [ActivityType.Watching]: 'Watching',
    [ActivityType.Listening]: 'Listening to',
    [ActivityType.Competing]: 'Competing',
  }[a.type] || '';
  return `${verb} ${a.name}`.trim();
}

function updatePresence() {
  if (!client.user) return;

  if (maintPhase === 'active') {
    const c = C('Under maintenance 🛠️');
    currentLine = describe(c);
    return client.user.setPresence({ status: 'dnd', activities: [c] });
  }
  if (siteUp === false) {
    const down = A(ActivityType.Watching, 'Website is down');
    currentLine = describe(down);
    return client.user.setPresence({ status: 'dnd', activities: [down] });
  }
  const p = period();
  const pool = pools[p];
  let pick;
  do { pick = pool[Math.floor(Math.random() * pool.length)]; } while (pool.length > 1 && pick === lastPick);
  lastPick = pick;
  currentLine = describe(pick);
  client.user.setPresence({
    status: p === 'sleep' ? 'idle' : p === 'lunch' ? 'dnd' : 'online',
    activities: [pick],
  });
}

// ---------- mood ----------
function mood() {
  const t = manilaMinutes();
  if (maintPhase === 'active') return { key: 'maintenance', emoji: '🛠️', text: 'Under maintenance, back soon', color: 0xf5b82e };
  if (siteUp === false) return { key: 'worried', emoji: '😰', text: 'Worried, the website is not responding', color: 0xe74c3c };
  if (recoveredAt && Date.now() - recoveredAt < 10 * 60000) return { key: 'relieved', emoji: '😮‍💨', text: 'Relieved, the website is back', color: 0x2ecc71 };
  if (t > 21 * 60 || t < 7 * 60) return { key: 'sleeping', emoji: '😴', text: 'Sleeping, please do not wake me', color: 0x6b7280 };
  if (t < 11 * 60) return { key: 'energetic', emoji: '☀️', text: 'Energetic and ready for the day', color: 0x2ecc71 };
  if (t < 12 * 60) return { key: 'hungry', emoji: '🍚', text: 'Hungry, lunch break has started', color: 0xf5b82e };
  if (t < 13 * 60) return { key: 'full', emoji: '😋', text: 'Full and happy after lunch', color: 0xf5b82e };
  if (t < 15 * 60) return { key: 'sleepy', emoji: '🥱', text: 'A little sleepy after lunch', color: 0x2ecc71 };
  if (t < 16 * 60) return { key: 'merienda', emoji: '🍢', text: 'Happy, it is merienda time', color: 0xf5b82e };
  return { key: 'focused', emoji: '⚔️', text: 'Focused on the battlefield', color: 0x2ecc71 };
}

// ---------- member stats (counts only, never names) ----------
const getGuild = () => (process.env.GUILD_ID && client.guilds.cache.get(process.env.GUILD_ID)) || client.guilds.cache.first();
const manilaDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
let peakDay = null, peakActive = 0;

async function memberStats() {
  const g = getGuild();
  if (!g) return null;
  if (g.members.cache.size < g.memberCount) await g.members.fetch().catch(e => console.error('member fetch failed:', e.message));
  let total = 0, online = 0, idle = 0, dnd = 0;
  for (const m of g.members.cache.values()) {
    if (m.user.bot) continue;            // members only, no bots
    total++;
    const st = m.presence?.status;       // counted, then discarded
    if (st === 'online') online++;
    else if (st === 'idle') idle++;
    else if (st === 'dnd') dnd++;
  }
  const active = online + idle + dnd;
  const today = manilaDate();
  if (peakDay !== today) { peakDay = today; peakActive = 0; }
  if (active > peakActive) peakActive = active;
  return { total, online, idle, dnd, active, peak: peakActive };
}

// ---------- live card (one message, edited in place) ----------
let cardId = null;

async function updateCard() {
  if (!STATUS_CHANNEL || !client.user) return;
  try {
    const ch = await client.channels.fetch(STATUS_CHANNEL);
    if (!ch || !ch.isTextBased()) return;
    const m = mood();
    const st = await memberStats();
    const embed = new EmbedBuilder()
      .setTitle('Maharlika · Live Status')
      .setColor(m.color)
      .addFields(
        { name: 'Website connection', value: maintPhase === 'active' ? '🛠️ Under maintenance' : siteUp === false ? '🔴 Not responding' : siteUp ? `🟢 Connected · ${siteMs} ms` : '⏳ Checking…' },
        { name: 'Mood', value: `${m.emoji} ${m.text}\n*${currentLine}*` },
        {
          name: 'Members',
          value: st
            ? `👥 ${st.total.toLocaleString('en-US')} total\n🟢 ${st.online} online · 🌙 ${st.idle} idle · ⛔ ${st.dnd} DND\n📈 Peak active today: ${st.peak}`
            : '–',
        },
      )
      .setFooter({ text: 'Updates every few minutes' })
      .setTimestamp();

    let msg = null;
    if (cardId) msg = await ch.messages.fetch(cardId).catch(() => null);
    if (!msg) {
      const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
      msg = (recent && recent.find(x => x.author.id === client.user.id && x.embeds[0]?.title?.startsWith('Maharlika'))) || null;
    }
    if (msg) { cardId = msg.id; await msg.edit({ embeds: [embed] }); }
    else { const sent = await ch.send({ embeds: [embed] }); cardId = sent.id; }
  } catch (e) { console.error('card failed:', e.message); }
}

// ---------- scheduler: random 2-5 minutes, instant on mood/site changes ----------
let lastMood = null;

async function refresh() {
  updatePresence();
  await updateCard();
}

function startScheduler() {
  const next = () => setTimeout(async () => { await refresh(); next(); }, (2 + Math.random() * 3) * 60000);
  next();
  setInterval(() => {
    const k = mood().key;
    if (k !== lastMood) { lastMood = k; refresh(); }
  }, 30000);
}

function fmtUptime(ms) {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ${m % 60}m`;
}

client.once(Events.ClientReady, async () => {
  const guild = process.env.GUILD_ID && client.guilds.cache.get(process.env.GUILD_ID);
  await (guild ? guild.commands.set(commands) : client.application.commands.set(commands));
  const g0 = getGuild();
  if (g0) await g0.members.fetch().catch(e => console.error('member fetch failed:', e.message));
  await checkSite();
  setInterval(checkSite, CHECK_EVERY);
  lastMood = mood().key;
  await refresh();
  startScheduler();
  console.log(`Online as ${client.user.tag}`);
});

// ---------- replies when someone pings the bot ----------
const lastReply = new Map();
const replyLines = {
  sleep: [
    "Zzz… I'm asleep, don't wake me up! Try again after 7:00 AM. 😴",
    'Shhh… Maharlika is sleeping. Come back at 7:00 AM! 💤',
    'Huh? Who dares wake me at this hour?! Let me sleep until 7:00 AM… 😪',
  ],
  lunch: [
    'Teka lang, kumakain ako! 🍚 Back at 1:00 PM.',
    "Lunch break! Don't disturb me while I eat my adobo. 🍲",
    'Hoy, tanghalian ko ito! Balik ako ng 1:00 PM. 😤',
  ],
  merienda: [
    'Merienda muna! 🍢 Ask me again in a bit.',
    'Sipping kape ☕ Try `/status` or `/links` meanwhile.',
  ],
  awake: [
    "I'm here! Try `/status`, `/links` or `/about`. 👋",
    'Kumusta! Use `/links` for the official links. 🇵🇭',
    'Present! Need something? Try `/about`. 🫡',
  ],
};

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || !msg.guild) return;
  if (!msg.mentions.users.has(client.user.id)) return; // direct pings only, not @everyone
  const last = lastReply.get(msg.author.id) || 0;
  if (Date.now() - last < 60000) return;               // 1 reply per user per minute
  lastReply.set(msg.author.id, Date.now());
  const pool = replyLines[period()];
  try {
    await msg.channel.send(`${msg.author} ${pool[Math.floor(Math.random() * pool.length)]}`);
  } catch (e) { console.error(e.message); }
});

// ---------- anti-spam for slash commands ----------
const CMD_COOLDOWN = 5000;   // same command: once every 5 seconds per user
const BURST_WINDOW = 30000;  // any command: max 6 uses per 30 seconds per user
const BURST_MAX = 6;
const lastCmd = new Map();   // "userId:command" -> timestamp
const burst = new Map();     // userId -> [timestamps]

function rateLimit(userId, cmd) {
  const now = Date.now();
  const key = userId + ':' + cmd;
  const last = lastCmd.get(key) || 0;
  if (now - last < CMD_COOLDOWN) return Math.ceil((CMD_COOLDOWN - (now - last)) / 1000);
  const arr = (burst.get(userId) || []).filter(t => now - t < BURST_WINDOW);
  if (arr.length >= BURST_MAX) return Math.ceil((BURST_WINDOW - (now - arr[0])) / 1000);
  arr.push(now);
  burst.set(userId, arr);
  lastCmd.set(key, now);
  return 0;
}

// keep the maps small
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of lastCmd) if (now - t > 60000) lastCmd.delete(k);
  for (const [k, arr] of burst) if (!arr.some(t => now - t < BURST_WINDOW)) burst.delete(k);
  for (const [k, t] of lastReply) if (now - t > 120000) lastReply.delete(k);
}, 10 * 60 * 1000);

// ---------- slash commands ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    const wait = rateLimit(i.user.id, i.commandName);
    if (wait > 0) {
      return await i.reply({ content: `Easy there, kabayan! Try again in ${wait}s. ⏳`, flags: MessageFlags.Ephemeral });
    }
    if (i.commandName === 'ping') {
      return await i.reply(`Maharlika is here. ${client.ws.ping} ms`);
    }
    if (i.commandName === 'uptime') {
      return await i.reply(`Maharlika has been running for **${fmtUptime(Date.now() - startedAt)}**.`);
    }
    if (i.commandName === 'status') {
      await i.deferReply();
      const start = Date.now();
      let ok = false, code = 'no response';
      try {
        const r = await fetch(SITE + '/', { signal: AbortSignal.timeout(8000) });
        ok = r.ok; code = r.status;
      } catch {}
      let maint = false;
      try {
        const r2 = await fetch(SITE + '/api/maintenance', { signal: AbortSignal.timeout(8000) });
        if (r2.ok) maint = (await r2.json()).phase === 'active';
      } catch {}
      const embed = new EmbedBuilder()
        .setTitle('Pinoy Legends Website')
        .setColor(maint ? 0xf5b82e : ok ? 0x2ecc71 : 0xe74c3c)
        .setDescription(maint ? '🛠️ Under maintenance' : ok ? '🟢 Online' : '🔴 Not responding')
        .addFields(
          { name: 'Response', value: `${Date.now() - start} ms`, inline: true },
          { name: 'HTTP status', value: String(code), inline: true },
        )
        .setFooter({ text: 'Maharlika' })
        .setTimestamp();
      return await i.editReply({ embeds: [embed] });
    }
    if (i.commandName === 'links') {
      const embed = new EmbedBuilder()
        .setTitle('Official Links')
        .setColor(0xf5b82e)
        .addFields({ name: 'Website', value: SITE }, { name: 'Discord', value: INVITE })
        .setFooter({ text: 'Maharlika' });
      return await i.reply({ embeds: [embed] });
    }
    if (i.commandName === 'about') {
      return await i.reply('I am **Maharlika**, the official bot of **Pinoy Legends**, an independent, Filipino-made 5v5 mobile MOBA currently in development. Follow the website and this server for updates.');
    }
  } catch (err) {
    console.error(err);
  }
});

client.login(process.env.DISCORD_TOKEN);
