if (global.botStarted) {
  console.log("Bot instance already running, exiting duplicate instance.");
  process.exit();
}
global.botStarted = true;

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
  Events
} = require("discord.js");
const { REST } = require("@discordjs/rest");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

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
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
  }
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
    if (!isCop) return interaction.reply({ content: "🚫 Only Officers with a COP License can use this.", ephemeral: true });

    const suspect = interaction.options.getUser("suspect");
    const channelNameInput = interaction.options.getString("channel_name");

    if (suspect.id === interaction.user.id) {
      return interaction.reply({ content: "❌ You cannot stop yourself!", ephemeral: true });
    }

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

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("release_suspect")
          .setLabel("Release Suspect")
          .setStyle(ButtonStyle.Success)
      );

      await stopChannel.send({
        content: `🚨 **Traffic Stop Initiated**\nOfficer: <@${interaction.user.id}>\nSuspect: <@${suspect.id}>\n\nPlease cooperate with the officer.`,
        components: [row]
      });

      await interaction.reply({ content: `✅ Stop channel created: <#${stopChannel.id}>`, ephemeral: true });
    } catch (err) {
      console.error(err);
      interaction.reply({ content: "❌ Error creating channel. Check Category ID and permissions.", ephemeral: true });
    }
  }

  // --- ADD TO STOP COMMAND ---
  if (interaction.commandName === "add_to_stop") {
    if (!isCop) return interaction.reply({ content: "🚫 Authorized personnel only.", ephemeral: true });
    if (!interaction.channel.name.startsWith("stop-")) {
      return interaction.reply({ content: "❌ This can only be used in a Stop channel.", ephemeral: true });
    }

    const userToAdd = interaction.options.getUser("user");
    await interaction.channel.permissionOverwrites.edit(userToAdd.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });

    await interaction.channel.send(`➕ <@${userToAdd.id}> has been added to the scene by <@${interaction.user.id}>.`);
    await interaction.reply({ content: `✅ Added ${userToAdd.tag}`, ephemeral: true });
  }

  // --- FINE COMMAND (Original Logic) ---
  if (interaction.commandName === "fine") {
    if (!isCop) return interaction.reply({ content: "🚫 Unauthorized.", ephemeral: true });
    
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply(`<a:2366_Loading_Pixels:1427600726691156100> Loading...`);

    const officer = interaction.user;
    const finedUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const city = interaction.options.getString("city");
    const plate = interaction.options.getString("vehicle");
    const amount = interaction.options.getInteger("amount");

    const fineNumber = Math.floor(1000000000 + Math.random() * 9000000000);
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toTimeString().slice(0, 5);

    const moroorChannel = await interaction.guild.channels.create({
      name: `${finedUser.id}-fine`,
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
      .setDescription(`Violation recorded:\n${reason}\nFine Number:\n__${fineNumber}__\nID:\n${finedUser.id}\nDate:\n__${dateStr}__\nTime:\n__${timeStr}__\nCity:\n${city}\nOn vehicle:\n${plate}\nAmount: ${amount}`)
      .setFooter({ text: `Pay via: !pay ${officer.tag} ${amount}` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("close_fine").setLabel("Close Case").setStyle(ButtonStyle.Danger)
    );

    await moroorChannel.send({ content: `<@${finedUser.id}>`, embeds: [embed], components: [row] });
    interaction.editReply({ content: `✅ Fine issued: <#${moroorChannel.id}>` });
  }
});

// ===== BUTTON HANDLER =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const isCop = member.roles.cache.has(process.env.copRoleId);
  const isStaff = member.roles.cache.has(process.env.staffRoleId);

  if (interaction.customId === "close_fine") {
    if (!isStaff) return interaction.reply({ content: "🚫 Staff only.", ephemeral: true });
    await interaction.reply({ content: "✅ Closing channel...", ephemeral: true });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
  }

  if (interaction.customId === "release_suspect") {
    if (!isCop) return interaction.reply({ content: "🚫 Only an Officer can release the suspect.", ephemeral: true });
    await interaction.reply({ content: "✅ Suspect released. Closing channel..." });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
  }

  if (interaction.customId === "end_call") {
    await interaction.reply({ content: "📞 Ending call...", ephemeral: true });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
  }
});

// ===== 911 CALL SYSTEM (Original Logic) =====
const LOG_CHANNEL_ID = "1423428971311271976";
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.content.toLowerCase() !== "!call 911") return;

  const callerId = message.author.id;
  const existing = message.guild.channels.cache.find(ch => ch.name === callerId);
  if (existing) return message.reply("🚫 Active call exists.");

  const callChannel = await message.guild.channels.create({
    name: callerId,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: message.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: callerId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
    ],
  });

  await callChannel.send("📞 Calling 911...");
  const log = message.guild.channels.cache.get(LOG_CHANNEL_ID);
  if (log) log.send(`📞 **911 Call** by <@${callerId}> | <#${callChannel.id}>`);

  setTimeout(async () => {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("end_call").setLabel("End Call").setStyle(ButtonStyle.Danger)
    );
    await callChannel.send({ content: `<@${callerId}>, 911 — how can I help you?`, components: [row] });
  }, 10000);
});

client.login(process.env.TOKEN);
