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
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel],
});

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

// Memory to track stop metadata for the transcript
const activeStops = new Map();

// ===== COMMANDS =====
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

// ===== MAIN HANDLER =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const isCop = member.roles.cache.has(process.env.copRoleId);

  // --- STOP COMMAND ---
  if (interaction.commandName === "stop") {
    if (!isCop) return interaction.reply({ content: "🚫 Only Officers can use this.", ephemeral: true });
    
    const suspect = interaction.options.getUser("suspect");
    const channelNameInput = interaction.options.getString("channel_name");

    if (suspect.id === interaction.user.id) {
      return interaction.reply({ content: "❌ You cannot stop yourself!", ephemeral: true });
    }

    try {
      // Force parent ID to be a string and check if it exists
      const categoryId = process.env.STOP_CATEGORY_ID ? String(process.env.STOP_CATEGORY_ID).trim() : null;

      const stopChannel = await interaction.guild.channels.create({
        name: `stop-${channelNameInput}`,
        type: ChannelType.GuildText,
        parent: categoryId, 
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: suspect.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: process.env.staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel] }
        ],
      });

      activeStops.set(stopChannel.id, {
        officer: interaction.user,
        suspect: suspect,
        addedUsers: [],
        startTime: new Date().toLocaleString()
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("release_suspect").setLabel("Release Suspect & Log").setStyle(ButtonStyle.Success)
      );

      await stopChannel.send({
        content: `🚨 **Traffic Stop Initiated**\nOfficer: <@${interaction.user.id}>\nSuspect: <@${suspect.id}>\n\nPlease cooperate with the officer.`,
        components: [row]
      });

      await interaction.reply({ content: `✅ Stop channel created in category: <#${stopChannel.id}>`, ephemeral: true });
    } catch (err) {
      console.error(err);
      interaction.reply({ content: "❌ Error creating channel. Verify `STOP_CATEGORY_ID` in .env is correct.", ephemeral: true });
    }
  }

  // --- ADD TO STOP COMMAND ---
  if (interaction.commandName === "add_to_stop") {
    if (!isCop) return interaction.reply({ content: "🚫 Authorized personnel only.", ephemeral: true });
    if (!interaction.channel.name.startsWith("stop-")) {
      return interaction.reply({ content: "❌ This command is for Traffic Stop channels only.", ephemeral: true });
    }

    const userToAdd = interaction.options.getUser("user");
    await interaction.channel.permissionOverwrites.edit(userToAdd.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });

    const stopData = activeStops.get(interaction.channel.id);
    if (stopData && !stopData.addedUsers.includes(userToAdd.tag)) {
        stopData.addedUsers.push(userToAdd.tag);
    }

    await interaction.channel.send(`➕ <@${userToAdd.id}> has been added to the stop by <@${interaction.user.id}>.`);
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
      name: `fine-${finedUser.id}`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: officer.id, allow: [PermissionsBitField.Flags.ViewChannel] },
        { id: finedUser.id, allow: [PermissionsBitField.Flags.ViewChannel] },
        { id: process.env.staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel] }
      ],
    });

    const embed = new EmbedBuilder()
      .setColor("Grey")
      .setTitle("Traffic Violation Record")
      .setDescription(`**Reason:** ${reason}\n**Fine Number:** ${fineNumber}\n**Amount:** ${amount}\n**Vehicle Plate:** ${plate}\n**City:** ${city}`)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("close_fine").setLabel("Close Case").setStyle(ButtonStyle.Danger)
    );

    await moroorChannel.send({ content: `<@${finedUser.id}>`, embeds: [embed], components: [row] });
    interaction.editReply({ content: `✅ Fine issued: <#${moroorChannel.id}>` });
  }
});

// ===== BUTTON HANDLER (TRANSCRIPTS & CLOSING) =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const isCop = member.roles.cache.has(process.env.copRoleId);
  const isStaff = member.roles.cache.has(process.env.staffRoleId);

  if (interaction.customId === "release_suspect") {
    if (!isCop) return interaction.reply({ content: "🚫 Only Officers can release.", ephemeral: true });

    await interaction.reply({ content: "📑 Generating log and closing channel..." });

    const stopData = activeStops.get(interaction.channel.id) || { officer: interaction.user, suspect: {tag: "N/A", id: "0"}, addedUsers: [], startTime: "Unknown" };

    // Fetch messages
    const messages = await interaction.channel.messages.fetch({ limit: 100 });
    let transcript = `OFFICIAL TRAFFIC STOP TRANSCRIPT\n`;
    transcript += `====================================\n`;
    transcript += `Channel: ${interaction.channel.name}\n`;
    transcript += `Start Time: ${stopData.startTime}\n`;
    transcript += `Primary Officer: ${stopData.officer.tag} (${stopData.officer.id})\n`;
    transcript += `Suspect: ${stopData.suspect.tag} (${stopData.suspect.id})\n`;
    transcript += `Additional People: ${stopData.addedUsers.join(", ") || "None"}\n`;
    transcript += `Closed By: ${interaction.user.tag}\n`;
    transcript += `====================================\n\n`;

    const logLines = messages.reverse().map(m => `[${m.createdAt.toLocaleString()}] ${m.author.tag}: ${m.content}`);
    transcript += logLines.join("\n");

    const logChannel = interaction.guild.channels.cache.get(process.env.logChannelId);
    if (logChannel) {
      const attachment = new AttachmentBuilder(Buffer.from(transcript, "utf-8"), { name: `stop-log-${interaction.channel.name}.txt` });
      
      const logEmbed = new EmbedBuilder()
        .setTitle("🛑 Stop Closed & Archived")
        .setColor("Blue")
        .addFields(
            { name: "Officer", value: `<@${stopData.officer.id}>`, inline: true },
            { name: "Suspect", value: `<@${stopData.suspect.id}>`, inline: true },
            { name: "Additional", value: stopData.addedUsers.join(", ") || "None" }
        )
        .setFooter({ text: `Case closed by ${interaction.user.tag}` })
        .setTimestamp();

      await logChannel.send({ embeds: [logEmbed], files: [attachment] });
    }

    activeStops.delete(interaction.channel.id);
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
  }

  if (interaction.customId === "close_fine") {
    if (!isStaff) return interaction.reply({ content: "🚫 Staff only.", ephemeral: true });
    await interaction.reply({ content: "✅ Case archived.", ephemeral: true });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
  }

  if (interaction.customId === "end_call") {
    await interaction.reply({ content: "📞 Call ended.", ephemeral: true });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
  }
});

// ===== 911 CALL SYSTEM =====
const LOG_CHANNEL_ID = "1423428971311271976";
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.content.toLowerCase() !== "!call 911") return;

  const callerId = message.author.id;
  const callChannel = await message.guild.channels.create({
    name: `call-${callerId}`,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: message.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: callerId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
    ],
  });

  const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("end_call").setLabel("End Call").setStyle(ButtonStyle.Danger)
  );

  await callChannel.send({ content: `🚨 **911 Dispatch**\n<@${callerId}>, how can we help?`, components: [row] });
  
  const log = message.guild.channels.cache.get(LOG_CHANNEL_ID);
  if (log) log.send(`📞 **911 Call Started** by <@${callerId}>`);
});

client.login(process.env.TOKEN);
