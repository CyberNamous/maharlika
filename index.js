const http = require('http');
const { Client, GatewayIntentBits, ActivityType, EmbedBuilder, Events } = require('discord.js');

const SITE = (process.env.SITE_URL || 'https://pinoylegends.cybernamous.workers.dev').replace(/\/$/, '');
const INVITE = process.env.DISCORD_INVITE || 'Not set yet';
const ALERT_CHANNEL = process.env.ALERT_CHANNEL_ID;       // staff channel: down/up alerts
const ANNOUNCE_CHANNEL = process.env.ANNOUNCE_CHANNEL_ID; // public channel: new posts/heroes
const CHECK_EVERY = 2 * 60 * 1000;                        // check the site every 2 minutes
const startedAt = Date.now();

// Tiny web endpoint so Render (and the pinger) have something to hit
http.createServer((req, res) => { res.writeHead(200); res.end('ok'); })
  .listen(process.env.PORT || 3000);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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

// ---------- presence ----------
let n = 0;
function updatePresence() {
  if (!client.user) return;
  const lines = [
    { name: siteUp === false ? 'Website is down' : 'Website: Online', type: ActivityType.Watching },
    { name: 'over Pinoy Legends', type: ActivityType.Watching },
    { name: 'for testing news', type: ActivityType.Listening },
    { name: 'for the battlefield', type: ActivityType.Competing },
  ];
  client.user.setPresence({
    status: siteUp === false ? 'dnd' : 'online',
    activities: [lines[n++ % lines.length]],
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

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
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
