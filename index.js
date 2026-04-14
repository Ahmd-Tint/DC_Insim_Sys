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
const FINE_LOG_CHANNEL_ID = "1423428971311271976"; // Your requested log channel

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

    try {
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

      await interaction.reply({ content: `✅ Stop channel created: <#${stopChannel.id}>`, ephemeral: true });
    } catch (err) {
      console.error(err);
      interaction.reply({ content: "❌ Error creating channel.", ephemeral: true });
    }
  }

  // --- ADD TO STOP COMMAND ---
  if (interaction.commandName === "add_to_stop") {
    if (!isCop) return interaction.reply({ content: "🚫 Authorized personnel only.", ephemeral: true });
    if (!interaction.channel.name.startsWith("stop-")) return interaction.reply({ content: "❌ Not a stop channel.", ephemeral: true });

    const userToAdd = interaction.options.getUser("user");
    await interaction.channel.permissionOverwrites.edit(userToAdd.id, { ViewChannel: true, SendMessages: true });
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

    // 1. Generation
    const fineNumber = Math.floor(1000000000 + Math.random() * 9000000000);
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0]; 
    const timeStr = now.toTimeString().slice(0, 5);   
    const dateUnderline = `__${dateStr}__`;
    const timeUnderline = `__${timeStr}__`;

    // 2. Dynamic Channel Naming
    const baseName = finedUser.id;
    const existing = interaction.guild.channels.cache.filter(ch => 
      ch.name && (ch.name === baseName || ch.name.startsWith(`${baseName}-`))
    );

    let channelName = baseName;
    if (existing.size > 0) {
      let max = 1;
      existing.forEach(ch => {
        const m = ch.name.match(new RegExp(`^${baseName}-(\\d+)$`));
        if (m) {
          const n = parseInt(m[1], 10);
          if (n >= max) max = n + 1;
        } else if (ch.name === baseName) { if (max < 2) max = 2; }
      });
      channelName = `${baseName}-${max}`;
    }

    const moroorChannel = await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: officer.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        { id: finedUser.id, allow: [PermissionsBitField.Flags.ViewChannel] },
        { id: process.env.staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel] }
      ],
    });

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

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("close_fine").setLabel("Close Case").setStyle(ButtonStyle.Danger)
    );

    // 3. Send to Fine Channel
    await moroorChannel.send({ content: `<@${finedUser.id}>`, embeds: [embed], components: [row] });

    // 4. Log to specific Log Channel (1423428971311271976)
    const logChannel = interaction.guild.channels.cache.get(FINE_LOG_CHANNEL_ID);
    if (logChannel) {
      await logChannel.send({
        content: `📝 **Fine Logged**\n` +
                 `**Officer:** ${officer.tag} (${officer.id})\n` +
                 `**Fined User:** ${finedUser.tag} (${finedUser.id})\n` +
                 `**Reason:** ${reason}\n` +
                 `**City:** ${city}\n` +
                 `**Plate:** ${plate}\n` +
                 `**Amount:** ${amount}\n` +
                 `**Fine Number:** ${fineNumber}`
      });
    }

    await interaction.editReply({ content: `✅ Fine issued: <#${moroorChannel.id}>` });
  }
});

// ===== BUTTON HANDLER =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  const isStaff = (await interaction.guild.members.fetch(interaction.user.id)).roles.cache.has(process.env.staffRoleId);

  if (interaction.customId === "release_suspect" || interaction.customId === "close_fine" || interaction.customId === "end_call") {
    if (interaction.customId === "close_fine" && !isStaff) return interaction.reply({ content: "🚫 Staff only.", ephemeral: true });
    
    await interaction.reply({ content: "📑 Closing channel..." });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
  }
});

// ===== 911 CALL SYSTEM =====
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.content.toLowerCase() !== "!call 911") return;
  const callChannel = await message.guild.channels.create({
    name: `call-${message.author.id}`,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: message.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: message.author.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
    ],
  });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("end_call").setLabel("End Call").setStyle(ButtonStyle.Danger));
  await callChannel.send({ content: `🚨 **911 Dispatch**\n<@${message.author.id}>, how can we help?`, components: [row] });
});

client.login(process.env.TOKEN);
