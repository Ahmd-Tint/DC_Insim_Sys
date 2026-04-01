if (global.botStarted) {
  console.log("Bot instance already running, exiting duplicate instance.");
  process.exit();
}
global.botStarted = true;

const http = require("http");
const { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  SlashCommandBuilder, 
  Routes, 
  EmbedBuilder, 
  PermissionsBitField, 
  ChannelType, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  Events,
  AttachmentBuilder
} = require("discord.js");
const { REST } = require("@discordjs/rest");

function keepAlive() {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Bot is alive!");
  });
  server.listen(3000, () => console.log("✅ Keep-alive server running on port 3000"));
}
keepAlive();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

// Temporary memory to track stop data for logs
const activeStops = new Map();

// ===== COMMAND REGISTRATION =====
const commands = [
  new SlashCommandBuilder()
    .setName("fine")
    .setDescription("Create a traffic violation record")
    .addUserOption(opt => opt.setName("user").setDescription("Who are you going to fine?").setRequired(true))
    .addStringOption(opt => opt.setName("reason").setDescription("What's the reason for the fine?").setRequired(true))
    .addStringOption(opt => opt.setName("city").setDescription("Fined in which map?").setRequired(true))
    .addStringOption(opt => opt.setName("vehicle").setDescription("What's the plate of the car?").setRequired(true))
    .addIntegerOption(opt => opt.setName("amount").setDescription("Fine amount").setRequired(true)),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Start a traffic stop (LFS)")
    .addUserOption(opt => opt.setName("suspect").setDescription("The person you are stopping").setRequired(true))
    .addStringOption(opt => opt.setName("channel_name").setDescription("Name for the channel").setRequired(true)),

  new SlashCommandBuilder()
    .setName("add_to_stop")
    .setDescription("Add another person to this traffic stop")
    .addUserOption(opt => opt.setName("user").setDescription("User to add").setRequired(true))
].map(cmd => cmd.toJSON());

async function registerCommands() {
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.guildId), { body: commands });
    console.log("✅ Slash commands registered!");
  } catch (err) { console.error("❌ Failed to register commands:", err); }
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ===== INTERACTION HANDLER =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const isCop = member.roles.cache.has(process.env.copRoleId);

  // --- STOP COMMAND ---
  if (interaction.commandName === "stop") {
    if (!isCop) return interaction.reply({ content: "🚫 Only Officers can use this.", ephemeral: true });
    const suspect = interaction.options.getUser("suspect");
    const channelNameInput = interaction.options.getString("channel_name");

    if (suspect.id === interaction.user.id) return interaction.reply({ content: "❌ You cannot stop yourself!", ephemeral: true });

    try {
      const stopChannel = await interaction.guild.channels.create({
        name: `stop-${channelNameInput}`,
        type: ChannelType.GuildText,
        parent: process.env.STOP_CATEGORY_ID || null,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: suspect.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: process.env.staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel] }
        ],
      });

      // Save metadata for logs
      activeStops.set(stopChannel.id, {
        officer: interaction.user,
        suspect: suspect,
        addedUsers: [],
        startTime: new Date().toLocaleString()
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("release_suspect").setLabel("Release Suspect").setStyle(ButtonStyle.Success)
      );

      await stopChannel.send({
        content: `🚨 **Traffic Stop Initiated**\nOfficer: <@${interaction.user.id}>\nSuspect: <@${suspect.id}>\n\nPlease cooperate with the officer.`,
        components: [row]
      });

      await interaction.reply({ content: `✅ Stop channel created: <#${stopChannel.id}>`, ephemeral: true });
    } catch (err) {
      interaction.reply({ content: "❌ Error creating channel.", ephemeral: true });
    }
  }

  // --- ADD TO STOP COMMAND ---
  if (interaction.commandName === "add_to_stop") {
    if (!isCop) return interaction.reply({ content: "🚫 Authorized personnel only.", ephemeral: true });
    if (!interaction.channel.name.startsWith("stop-")) return interaction.reply({ content: "❌ Use in a Stop channel.", ephemeral: true });

    const userToAdd = interaction.options.getUser("user");
    await interaction.channel.permissionOverwrites.edit(userToAdd.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });

    // Update log metadata
    const stopData = activeStops.get(interaction.channel.id);
    if (stopData && !stopData.addedUsers.includes(userToAdd.tag)) {
        stopData.addedUsers.push(userToAdd.tag);
    }

    await interaction.channel.send(`➕ <@${userToAdd.id}> added by <@${interaction.user.id}>.`);
    await interaction.reply({ content: `✅ Added ${userToAdd.tag}`, ephemeral: true });
  }

  // --- FINE COMMAND ---
  if (interaction.commandName === "fine") {
    if (!isCop) return interaction.reply({ content: "🚫 Unauthorized.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const officer = interaction.user;
    const finedUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const city = interaction.options.getString("city");
    const plate = interaction.options.getString("vehicle");
    const amount = interaction.options.getInteger("amount");

    const fineNumber = Math.floor(1000000000 + Math.random() * 9000000000);
    const moroorChannel = await interaction.guild.channels.create({
      name: `${finedUser.id}-fine`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: officer.id, allow: [PermissionsBitField.Flags.ViewChannel] },
        { id: finedUser.id, allow: [PermissionsBitField.Flags.ViewChannel] },
      ],
    });

    const embed = new EmbedBuilder()
      .setColor("Grey")
      .setDescription(`Violation Recorded\nReason: ${reason}\nFine #: ${fineNumber}\nAmount: ${amount}\nPlate: ${plate}`)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("close_fine").setLabel("Close Case").setStyle(ButtonStyle.Danger));
    await moroorChannel.send({ content: `<@${finedUser.id}>`, embeds: [embed], components: [row] });
    interaction.editReply({ content: `✅ Fine issued: <#${moroorChannel.id}>` });
  }
});

// ===== BUTTON HANDLER WITH LOGGING =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const isCop = member.roles.cache.has(process.env.copRoleId);
  const isStaff = member.roles.cache.has(process.env.staffRoleId);

  if (interaction.customId === "release_suspect") {
    if (!isCop) return interaction.reply({ content: "🚫 Officers only.", ephemeral: true });

    await interaction.reply({ content: "📑 Generating transcript and closing..." });

    // 1. Fetch Stop Metadata
    const stopData = activeStops.get(interaction.channel.id) || { officer: {tag: "Unknown"}, suspect: {tag: "Unknown"}, addedUsers: [], startTime: "Unknown" };

    // 2. Fetch all messages for transcript
    const messages = await interaction.channel.messages.fetch({ limit: 100 });
    let transcript = `TRAFFIC STOP LOG\n`;
    transcript += `====================================\n`;
    transcript += `Channel: ${interaction.channel.name}\n`;
    transcript += `Started: ${stopData.startTime}\n`;
    transcript += `Officer: ${stopData.officer.tag}\n`;
    transcript += `Suspect: ${stopData.suspect.tag}\n`;
    transcript += `Added Users: ${stopData.addedUsers.join(", ") || "None"}\n`;
    transcript += `Closed By: ${interaction.user.tag}\n`;
    transcript += `====================================\n\n`;

    const logLines = messages.reverse().map(m => `[${m.createdAt.toLocaleString()}] ${m.author.tag}: ${m.content}`);
    transcript += logLines.join("\n");

    // 3. Send to Logs
    const logChannel = interaction.guild.channels.cache.get(process.env.logChannelId);
    if (logChannel) {
      const attachment = new AttachmentBuilder(Buffer.from(transcript, "utf-8"), { name: `stop-${interaction.channel.name}.txt` });
      
      const logEmbed = new EmbedBuilder()
        .setTitle("🛑 Traffic Stop Closed")
        .setColor("Green")
        .addFields(
            { name: "Officer", value: `<@${stopData.officer.id}>`, inline: true },
            { name: "Suspect", value: `<@${stopData.suspect.id}>`, inline: true },
            { name: "Closed By", value: `<@${interaction.user.id}>`, inline: true },
            { name: "Additional People", value: stopData.addedUsers.join(", ") || "None" }
        )
        .setTimestamp();

      await logChannel.send({ embeds: [logEmbed], files: [attachment] });
    }

    // 4. Cleanup
    activeStops.delete(interaction.channel.id);
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
  }

  // Close Fine Button
  if (interaction.customId === "close_fine") {
    if (!isStaff) return interaction.reply({ content: "🚫 Staff only.", ephemeral: true });
    await interaction.reply({ content: "✅ Closing...", ephemeral: true });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
  }

  // End 911 Call Button
  if (interaction.customId === "end_call") {
    await interaction.reply({ content: "📞 Ending call...", ephemeral: true });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
  }
});

// ===== 911 CALL SYSTEM (Simplified) =====
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.content.toLowerCase() !== "!call 911") return;
  const callChannel = await message.guild.channels.create({
    name: `call-${message.author.id}`,
    type: ChannelType.GuildText,
    permissionOverwrites: [{ id: message.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }, { id: message.author.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }],
  });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("end_call").setLabel("End Call").setStyle(ButtonStyle.Danger));
  await callChannel.send({ content: `🚨 911 - How can we help?`, components: [row] });
});

client.login(process.env.TOKEN);
