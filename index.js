const http = require('http');
const { Client, GatewayIntentBits, ActivityType, EmbedBuilder, Events, MessageFlags } = require('discord.js');

const SITE = (process.env.SITE_URL || 'https://pinoylegends.cybernamous.workers.dev').replace(/\/$/, '');
const INVITE = process.env.DISCORD_INVITE || 'Not set yet';
const ALERT_CHANNEL = process.env.ALERT_CHANNEL_ID;       // staff channel: down/up alerts
const ANNOUNCE_CHANNEL = process.env.ANNOUNCE_CHANNEL_ID; // public channel: new posts/heroes
const CHECK_EVERY = 2 * 60 * 1000;                        // check the site every 2 minutes
const startedAt = Date.now();

// Tiny web endpoint so Render (and the pinger) have something to hit
http.createServer((req, res) => { res.writeHead(200); res.end('ok'); })
  .listen(process.env.PORT || 3000);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

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
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    up = r.ok;
    if (r.ok) data = await r.json();
  } catch { up = false; }

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
  siteUp = up;
  updatePresence();

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

function updatePresence() {
  if (!client.user) return;

  if (siteUp === false) {
    return client.user.setPresence({
      status: 'dnd',
      activities: [A(ActivityType.Watching, 'Website is down')],
    });
  }
  const p = period();
  const pool = pools[p];
  client.user.setPresence({
    status: p === 'sleep' ? 'idle' : p === 'lunch' ? 'dnd' : 'online',
    activities: [pool[n++ % pool.length]],
  });
}

function fmtUptime(ms) {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ${m % 60}m`;
}

client.once(Events.ClientReady, async () => {
  const guild = process.env.GUILD_ID && client.guilds.cache.get(process.env.GUILD_ID);
  await (guild ? guild.commands.set(commands) : client.application.commands.set(commands));
  await checkSite();
  setInterval(checkSite, CHECK_EVERY);
  setInterval(updatePresence, 30000);
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
      const embed = new EmbedBuilder()
        .setTitle('Pinoy Legends Website')
        .setColor(ok ? 0x2ecc71 : 0xe74c3c)
        .setDescription(ok ? '🟢 Online' : '🔴 Not responding')
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
