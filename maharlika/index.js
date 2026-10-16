require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`Maharlika is online as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply(`Pong! ${Math.round(client.ws.ping)}ms`);
  }
});

client.login(process.env.DISCORD_TOKEN);
