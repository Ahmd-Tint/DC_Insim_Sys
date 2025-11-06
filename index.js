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
  ComponentType,
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



// const finesFile = "./fines.json";

// Ensure fines.json exists
// if (!fs.existsSync(finesFile)) {
//  fs.writeJsonSync(finesFile, []);
// }



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

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "fine") return;

  
  await interaction.deferReply({ ephemeral: true });

  
  await interaction.editReply(`<a:2366_Loading_Pixels:1427600726691156100> Loading...\nPlease be patient`);

  
  const officer = interaction.user;
  const finedUser = interaction.options.getUser("user");
  const reason = interaction.options.getString("reason");
  const city = interaction.options.getString("city");
  const plate = interaction.options.getString("vehicle");
  const amount = interaction.options.getInteger("amount");

  const member = await interaction.guild.members.fetch(officer.id);
  if (!member.roles.cache.has(process.env.copRoleId)) {
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
      { id: process.env.staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel] },
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
  console.log(`================================================`);
  console.log(`${officer.tag}`);
  console.log(`${reason}`);
  console.log(`${fineNumber}`);
  console.log(`${finedUser.id}`);
  console.log(`${dateUnderline}`);
  console.log(`${timeUnderline}`);
  console.log(`${city}`);
  console.log(`${plate}`);
  console.log(`${amount}`);
  console.log(`================================================`);
  const msg = await moroorChannel.send({ content: `<@${finedUser.id}>`, embeds: [embed], components: [row] });
  // -------------------------
  // Button collector (no immediate timeout) — staff only check inside handler
  // -------------------------
  
  // Log to staff channel
  const staffLogChannel = interaction.guild.channels.cache.get(process.env.logChannelId);
  if (staffLogChannel) {
    staffLogChannel.send({
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
//   try {
//     let fines = [];
//     if (await fs.pathExists(finesFile)) {
//       fines = await fs.readJson(finesFile);
//     }
//     fines.push({
//       fineNumber,
//       officer: officer.tag,
//       officerId: officer.id,
//       finedUser: finedUser.tag,
//       finedUserId: finedUser.id,
//       reason,
//       city,
//       plate,
//       amount,
//       date: dateStr,
//       time: timeStr,
//       status: "open"
//     });
//    await fs.writeJson(finesFile, fines, { spaces: 2 });
//   } catch (err) {
//    console.error("❌ Failed to save fine to JSON:", err);
//   }
//     interaction.editReply({ content: `✅ Fine issued successfully! Case logged in <#${moroorChannel.id}>`, ephemeral: true });
});

// GLOBAL handler for the Close Case button (works after restart)
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId !== "close_fine") return;

  if (!interaction.member?.roles?.cache.has(process.env.staffRoleId)) {
    return interaction.reply({ content: "🚫 You cannot close this case.", ephemeral: true });
  }

  const moroorChannel = interaction.channel;

  try {
    await interaction.reply({ content: "✅ Case closed and channel will be deleted.", ephemeral: true });
    console.log(`✅ Case closed: ${moroorChannel.name} by ${interaction.user.tag}`);
    setTimeout(() => moroorChannel.delete().catch(() => {}), 3000);
  } catch (err) {
    console.error("❌ Error closing case:", err);
    try { await interaction.reply({ content: "❌ Error while closing case.", ephemeral: true }); } catch {}
  }
});


// CALL 911


const LOG_CHANNEL_ID = "1423428971311271976"; // Logs go here

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}.` + ` ` + `Reached 911 CALL side`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (message.content.toLowerCase() === "!call 911") {
    const guild = message.guild;
    const caller = message.member;
    const callerId = caller.id;

    // Prevent multiple calls from same user
    const existingChannel = guild.channels.cache.find(
      (ch) => ch.name === callerId
    );
    if (existingChannel) {
      return message.reply("🚫 You already have an active call channel.");
    }

    // Find roles
    const teamRole = guild.roles.cache.find((r) => r.name === "[RL] Team");
    const copRole = guild.roles.cache.find((r) => r.name === "COP License");

    // Create the private channel
    const callChannel = await guild.channels.create({
      name: callerId,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        {
          id: callerId,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
          ],
        },
        ...(teamRole
          ? [
              {
                id: teamRole.id,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                ],
              },
            ]
          : []),
        ...(copRole
          ? [
              {
                id: copRole.id,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                ],
              },
            ]
          : []),
      ],
    });

    // Send initial message
    await callChannel.send("📞 Calling 911...");

    // Log call creation
    const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) {
      logChannel.send(
        `📞 **911 Call Started** by <@${callerId}> | Channel: <#${callChannel.id}>`
      );
    }

    // After 10 seconds
    setTimeout(async () => {
      const messages = await callChannel.messages.fetch({ limit: 1 });
      const firstMsg = messages.first();
      if (firstMsg) await firstMsg.edit("🚨 911");

      // Send response + End Call button
      const endButton = new ButtonBuilder()
        .setCustomId("end_call")
        .setLabel("End Call")
        .setStyle(ButtonStyle.Danger);

      const row = new ActionRowBuilder().addComponents(endButton);

      await callChannel.send({
        content: `${caller}, 911 — how can I help you?`,
        components: [row],
      });
    }, 10000);
  }
});

// Handle End Call button
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === "end_call") {
    await interaction.reply({
      content: "📞 Call ending in 3 seconds...",
      ephemeral: true,
    });

    // Log before closing
    const logChannel = interaction.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) {
      logChannel.send(
        `🔚 **911 Call Ended** | Call by: <@${interaction.channel.name}> | Closed by: <@${interaction.user.id}>`
      );
    }

    setTimeout(() => {
      interaction.channel.delete().catch(() => {});
    }, 3000);
  }
});


// END OF CALL 911


client.login(process.env.TOKEN);
console.log('Version 12:21 PM, Thu, Nov 6, 2025');











