require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');

const db = require('./db');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const STAFF_ROLES = ['ADM', 'Mediador', 'Suporte'];

// Importação dos módulos do sistema
const fila = require('./fila');
const sala = require('./sala');
const torneio = require('./torneio');
const perfil = require('./perfil');

// Agrupamento de todos os Slash Commands
const baseCommands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Cria os cargos e canais do servidor')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('painel-ticket')
    .setDescription('Envia o painel de tickets neste canal')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

const commands = baseCommands.concat(
  fila.commands || [],
  torneio.commands || [],
  perfil.commands || []
);

// Funções auxiliares de infraestrutura
async function getRole(guild, name, color) {
  let role = guild.roles.cache.find((r) => r.name === name);
  if (!role) role = await guild.roles.create({ name, color, reason: 'Setup automático' });
  return role;
}

async function getCategory(guild, name) {
  let cat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === name
  );
  if (!cat) cat = await guild.channels.create({ name, type: ChannelType.GuildCategory });
  return cat;
}

async function getText(guild, name, parent, overwrites = []) {
  let ch = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name && c.parentId === parent.id
  );
  if (!ch) {
    ch = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: parent.id,
      permissionOverwrites: overwrites,
    });
  }
  return ch;
}

function isStaff(member) {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.roles.cache.some((r) => STAFF_ROLES.includes(r.name))
  );
}

// Configuração do servidor /setup
async function runSetup(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  await guild.roles.fetch();
  await guild.channels.fetch();

  const adm = await getRole(guild, 'ADM', 0xe74c3c);
  const mediador = await getRole(guild, 'Mediador', 0xf1c40f);
  const suporte = await getRole(guild, 'Suporte', 0x3498db);
  await getRole(guild, 'Jogador', 0x2ecc71);

  const everyone = guild.roles.everyone;
  const somenteLeitura = [{ id: everyone.id, deny: [PermissionFlagsBits.SendMessages] }];
  const soStaff = [
    { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...[adm, mediador, suporte].map((r) => ({
      id: r.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    })),
  ];

  const info = await getCategory(guild, 'INFORMAÇÕES');
  await getText(guild, 'regras', info, somenteLeitura);
  await getText(guild, 'avisos', info, somenteLeitura);

  const filasCat = await getCategory(guild, 'FILAS');
  for (const nome of ['1v1', '2v2', '3v3', '4v4']) {
    await getText(guild, nome, filasCat, somenteLeitura);
  }

  const tickets = await getCategory(guild, 'TICKETS');
  await getText(guild, 'ticket', tickets, somenteLeitura);
  await getText(guild, 'suporte', tickets);

  const resultados = await getCategory(guild, 'RESULTADOS');
  await getText(guild, 'enviar-resultado', resultados);

  const staff = await getCategory(guild, 'STAFF');
  await getText(guild, 'staff-chat', staff, soStaff);
  await getText(guild, 'recrutamento', staff, soStaff);

  await interaction.editReply('✅ Servidor configurado com sucesso!');
}

// Sistema de Tickets
async function sendTicketPanel(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('Central de Suporte')
    .setDescription(
      'Precisa de ajuda, quer denunciar um jogador ou resolver uma dúvida?\n' +
      'Clique no botão abaixo para abrir um ticket privado com a nossa equipe.'
    )
    .setColor(0x3498db);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('abrir_ticket')
      .setLabel('Abrir ticket')
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.channel.send({ embeds: [embed], components: [row] });
  await interaction.reply({ content: 'Painel enviado!', flags: MessageFlags.Ephemeral });
}

async function openTicket(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const user = interaction.user;
  await guild.channels.fetch();

  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.topic === `ticket:${user.id}`
  );
  if (existing) {
    return interaction.editReply(`Você já tem um ticket aberto: ${existing}`);
  }

  const category = await getCategory(guild, 'TICKETS');
  const staffRoles = guild.roles.cache.filter((r) => STAFF_ROLES.includes(r.name));

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    ...staffRoles.map((r) => ({
      id: r.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    })),
  ];

  const nome = user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'usuario';
  const channel = await guild.channels.create({
    name: `ticket-${nome}`,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `ticket:${user.id}`,
    permissionOverwrites: overwrites,
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('fechar_ticket')
      .setLabel('Fechar ticket')
      .setStyle(ButtonStyle.Danger)
  );

  await channel.send({
    content: `${user}, a equipe já vai te atender. Descreva o que você precisa.`,
    components: [row],
  });

  await interaction.editReply(`Ticket criado: ${channel}`);
}

async function closeTicket(interaction) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({
      content: 'Só a equipe pode fechar tickets.',
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.reply('Ticket será fechado em 5 segundos...');
  setTimeout(() => interaction.channel.delete().catch(console.error), 5000);
}

// EVENDO NOVO: Cadastra no Supabase assim que entra no servidor Discord
client.on('guildMemberAdd', async (member) => {
  if (member.user.bot) return;
  try {
    console.log(`[NOVO MEMBRO] Cadastrando no banco: ${member.user.username} (${member.user.id})`);
    await db.query(
      `INSERT INTO users (discord_id, username, balance, locked_balance)
       VALUES ($1, $2, 0.00, 0.00)
       ON CONFLICT (discord_id) DO NOTHING`,
      [member.user.id, member.user.username]
    );
  } catch (err) {
    console.error('Erro ao cadastrar novo membro:', err);
  }
});

// Evento quando o bot liga
client.once('ready', async () => {
  console.log(`🤖 Bot online como ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('Registrando Slash Commands...');
    for (const guild of client.guilds.cache.values()) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id),
        { body: commands }
      );
      console.log(`Comandos registrados com sucesso na Guild: ${guild.name}`);

      // Cadastra todos os membros que JÁ ESTÃO no servidor ao ligar
      const members = await guild.members.fetch();
      for (const [, member] of members) {
        if (!member.user.bot) {
          await db.query(
            `INSERT INTO users (discord_id, username, balance, locked_balance)
             VALUES ($1, $2, 0.00, 0.00)
             ON CONFLICT (discord_id) DO NOTHING`,
            [member.user.id, member.user.username]
          );
        }
      }
      console.log(`Membros da Guild ${guild.name} sincronizados com o Supabase!`);
    }
  } catch (error) {
    console.error('Erro no evento ready:', error);
  }
});

// Manipulador de interações
client.on('interactionCreate', async (interaction) => {
  try {
    if (await perfil.handle(interaction)) return;
    if (await sala.handle(interaction)) return;
    if (await torneio.handle(interaction)) return;
    if (await fila.handle(interaction)) return;

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup') return await runSetup(interaction);
      if (interaction.commandName === 'painel-ticket') return await sendTicketPanel(interaction);
    }
    if (interaction.isButton()) {
      if (interaction.customId === 'abrir_ticket') return await openTicket(interaction);
      if (interaction.customId === 'fechar_ticket') return await closeTicket(interaction);
    }
  } catch (err) {
    console.error('Erro na interação:', err);
  }
});

client.login(process.env.DISCORD_TOKEN);