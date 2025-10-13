
// ===== KEEP ALIVE FOR UPTIME ROBOT =====
const http = require("http");

function keepAlive() {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Bot is alive!");
  });

  server.listen(3000, () => {
    console.log("✅ Keep-alive server running on port 3000");
  });
}

keepAlive();

const { Client, GatewayIntentBits, SlashCommandBuilder, Routes, EmbedBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require("discord.js");
const { REST } = require("@discordjs/rest");
const fs = require("fs-extra");
const config = fs.readJsonSync("./config.json");


const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const rest = new REST({ version: "10" }).setToken(config.token);

const finesFile = "./fines.json";

// Ensure fines.json exists
if (!fs.existsSync(finesFile)) {
  fs.writeJsonSync(finesFile, []);
}

const commands = [
  new SlashCommandBuilder()
    .setName("fine")
    .setDescription("Create a traffic violation record")
    .addUserOption(opt => opt.setName("user").setDescription("Who are you going to fine?").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("What's the reason for the fine?").setRequired(true))
    .addStringOption(opt => opt.setName("city").setDescription("Fined in which map?").setRequired(true))
    .addStringOption(opt => opt.setName("vehicle").setDescription("What's the plate of the car?").setRequired(true))
    .addIntegerOption(opt => opt.setName("amount").setDescription("Fine amount").setRequired(true))
].map(cmd => cmd.toJSON());

async function registerCommands() {
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body: commands });
    console.log("✅ Slash commands registered!");
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
  }
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "fine") return;

  try {
    // Tell Discord we are working on it
    await interaction.deferReply({ ephemeral: true });

    // --- Everything that takes time goes here ---
    const officer = interaction.user;
    const finedUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const city = interaction.options.getString("city");
    const plate = interaction.options.getString("vehicle");
    const amount = interaction.options.getInteger("amount");

    // check officer role
    const member = await interaction.guild.members.fetch(officer.id);
    if (!member.roles.cache.has(config.copRoleId)) {
      return await interaction.editReply({ content: "🚫 You are not authorized to use this command." });
    }

    // generate fine number, date/time
    const fineNumber = Math.floor(1000000000 + Math.random() * 9000000000);
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toTimeString().slice(0,5);

    // create channel
    const moroorChannel = await interaction.guild.channels.create({
      name: finedUser.id,
      type: 0,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: config.staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel] },
        { id: officer.id, allow: [PermissionsBitField.Flags.ViewChannel] },
        { id: finedUser.id, allow: [PermissionsBitField.Flags.ViewChannel] },
      ],
    });

    // create embed & button
    const embed = new EmbedBuilder()
      .setColor("Grey")
      .setDescription(`Violation recorded:\n${reason}\nFine Number: __${fineNumber}__\nID: ${finedUser.id}\nDate: __${dateStr}__\nTime: __${timeStr}__\nCity: ${city}\nOn vehicle: ${plate}\nAmount: ${amount}`)
      .setFooter({ text: `Pay with !pay ${officer.tag} ${amount}` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("close_fine").setLabel("Close Case").setStyle(ButtonStyle.Danger)
    );

    await moroorChannel.send({ content: `<@${finedUser.id}>`, embeds: [embed], components: [row] });

    // Save to JSON
    let fines = [];
    if (await fs.pathExists(finesFile)) {
      fines = await fs.readJson(finesFile);
    }
    fines.push({
      fineNumber,
      officer: officer.tag,
      officerId: officer.id,
      finedUser: finedUser.tag,
      finedUserId: finedUser.id,
      reason,
      city,
      plate,
      amount,
      date: dateStr,
      time: timeStr,
      status: "open"
    });
    await fs.writeJson(finesFile, fines, { spaces: 2 });

    console.log(`✅ Fine #${fineNumber} issued to ${finedUser.tag} by ${officer.tag}`);

    // Finally, reply to the interaction
    await interaction.editReply({ content: `✅ Fine issued successfully! Case logged in <#${moroorChannel.id}>` });

  } catch (err) {
    console.error("❌ Error in /fine command:", err);
    try { await interaction.editReply({ content: "❌ Something went wrong while issuing the fine." }); } catch {}
  }
});

client.login(config.token);
console.log('version 1056');
