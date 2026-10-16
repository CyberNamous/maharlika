// Run once (and again whenever you add or change commands).
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check if Maharlika is alive'),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    // Guild commands appear instantly (good for a personal server).
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered.');
  } catch (err) {
    console.error(err);
  }
})();
