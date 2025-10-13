const keepAlive = require('./keep_alive.js');
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

  const officer = interaction.user;
  const finedUser = interaction.options.getUser("user");
  const reason = interaction.options.getString("reason");
  const city = interaction.options.getString("city");
  const plate = interaction.options.getString("vehicle");
  const amount = interaction.options.getInteger("amount");

  const member = await interaction.guild.members.fetch(officer.id);
  if (!member.roles.cache.has(config.copRoleId)) {
    return interaction.reply({ content: "🚫 You are not authorized to use this command.", ephemeral: true });
  }

  // Fine number and timestamps
  const fineNumber = Math.floor(1000000000 + Math.random() * 9000000000);
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0]; // 2025-10-05
  const timeStr = now.toTimeString().slice(0,5);   // 13:21
  const dateUnderline = `__${dateStr}__`;
  const timeUnderline = `__${timeStr}__`;

  // -------------------------
  // Create a new channel named after the fined user's ID.
  // If channels for this ID already exist, append -2, -3, etc.
  // -------------------------
  const baseName = finedUser.id;
  const existing = interaction.guild.channels.cache.filter(ch => ch.name && (ch.name === baseName || ch.name.startsWith(`${baseName}-`)));

  // determine next available suffix (base, base-2, base-3, ...)
  let channelName = baseName;
  if (existing.size > 0) {
    let max = 1;
    existing.forEach(ch => {
      const m = ch.name.match(new RegExp(`^${baseName}-(\\d+)$`));
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= max) max = n + 1;
      } else if (ch.name === baseName) {
        if (max < 2) max = 2;
      }
    });
    channelName = `${baseName}-${max}`;
  }

  const moroorChannel = await interaction.guild.channels.create({
    name: channelName,
    type: 0,
    permissionOverwrites: [
      { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: config.staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel] },
      { id: officer.id, allow: [PermissionsBitField.Flags.ViewChannel] },
      { id: finedUser.id, allow: [PermissionsBitField.Flags.ViewChannel] },
    ],
  });

  // -------------------------
  // EMBED: left exactly as you originally wrote it
  // -------------------------
  const embed = new EmbedBuilder()
    .setColor("Grey")
    .setDescription(
      `Violation recorded:\n` +
      `${reason}\n` +
      `Fine Number:\n__${fineNumber}__\n` +
      `ID:\n${finedUser.id}\n` +
      `Date:\n${dateUnderline}\n` +
      `Time:\n${timeUnderline}\n` +
      `City:\n${city}\n` +
      `On vehicle:\n${plate}\n` +
      `Amount: ${amount}`
    )
    .setFooter({ text: `You can pay this fine by typing !pay ${officer.tag} ${amount}` })
    .setTimestamp();

  // Close button (staff only)
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("close_fine")
      .setLabel("Close Case")
      .setStyle(ButtonStyle.Danger)
  );

  const msg = await moroorChannel.send({ content: `<@${finedUser.id}>`, embeds: [embed], components: [row] });
  await interaction.reply({ content: `✅ Fine issued successfully! Case logged in <#${moroorChannel.id}>`, ephemeral: true });

  // -------------------------
  // Button collector (no immediate timeout) — staff only check inside handler
  // -------------------------
  const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button });

  collector.on("collect", async i => {
    // Make sure we have a GuildMember and check staff role
    if (!i.member || !i.member.roles || !i.member.roles.cache.has(config.staffRoleId)) {
      return i.reply({ content: "🚫 You cannot close this case.", ephemeral: true });
    }

    try {
      // mark as closed in fines.json (if the fine exists)
      let fines = [];
      if (await fs.pathExists(finesFile)) {
        fines = await fs.readJson(finesFile);
      }
      const idx = fines.findIndex(f => f.fineNumber === fineNumber);
      if (idx !== -1) {
        fines[idx].status = "closed";
        fines[idx].closedBy = i.user.tag;
        fines[idx].closedAt = new Date().toISOString();
        await fs.writeJson(finesFile, fines, { spaces: 2 });
      }

      await i.reply({ content: "✅ Case closed and channel will be deleted.", ephemeral: true });

      // small delay so the ephemeral reply is delivered before channel delete
      setTimeout(() => moroorChannel.delete().catch(() => {}), 3000);
      collector.stop();
    } catch (err) {
      console.error("Error closing case:", err);
      try { await i.reply({ content: "❌ Error while closing case.", ephemeral: true }); } catch {}
    }
  });

  // Log to staff channel
  const staffLogChannel = interaction.guild.channels.cache.get(config.logChannelId);
  if (staffLogChannel) {
    await staffLogChannel.send({
      content: `📝 **Fine Logged**
**Officer:** ${officer.tag} (${officer.id})
**Fined User:** ${finedUser.tag} (${finedUser.id})
**Reason:** ${reason}
**City:** ${city}
**Plate:** ${plate}
**Amount:** ${amount}
**Fine Number:** ${fineNumber}`
    });
  }

  // Save to JSON safely
  try {
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
    console.log(`✅ Fine #${fineNumber} logged to fines.json`);
  } catch (err) {
    console.error("❌ Failed to save fine to JSON:", err);
  }
});

client.login(config.token);



