const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const db = require('./db');
const sala = require('./sala');

const MODOS = { '1v1': 2, '2v2': 4, '3v3': 6, '4v4': 8 };
const STAFF_ROLES = ['ADM', 'Mediador', 'Suporte'];
const filas = new Map(); // id do canal -> { modo, jogadores: [] }

function statsDe(dados, id) {
  if (!dados.ranking[id]) dados.ranking[id] = { vitorias: 0, derrotas: 0 };
  return dados.ranking[id];
}

function ehStaff(membro) {
  return (
    membro.permissions.has(PermissionFlagsBits.Administrator) ||
    membro.roles.cache.some((r) => STAFF_ROLES.includes(r.name))
  );
}

const commands = [
  new SlashCommandBuilder()
    .setName('painel-fila')
    .setDescription('Envia o painel de fila neste canal')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) =>
      o.setName('modo')
        .setDescription('Modo de jogo')
        .setRequired(true)
        .addChoices(...Object.keys(MODOS).map((m) => ({ name: m, value: m })))
    ),
  new SlashCommandBuilder()
    .setName('ranking')
    .setDescription('Mostra o top 10 de vitórias'),
].map((c) => c.toJSON());

function textoFila(modo, jogadores) {
  const lista = jogadores.length
    ? jogadores.map((id) => `<@${id}>`).join('\n')
    : 'Ninguém na fila ainda.';
  return `**Fila ${modo}** - jogadores (${jogadores.length}/${MODOS[modo]}):\n${lista}`;
}

function botoesFila(modo) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`fila_entrar:${modo}`)
      .setLabel('Entrar na fila')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`fila_sair:${modo}`)
      .setLabel('Sair da fila')
      .setStyle(ButtonStyle.Secondary)
  );
}

function botoesPartida(resultadoRegistrado = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('res_A')
      .setLabel('Time A venceu')
      .setStyle(ButtonStyle.Success)
      .setDisabled(resultadoRegistrado),
    new ButtonBuilder()
      .setCustomId('res_B')
      .setLabel('Time B venceu')
      .setStyle(ButtonStyle.Success)
      .setDisabled(resultadoRegistrado),
    sala.botaoSala(),
    new ButtonBuilder()
      .setCustomId('fila_encerrar')
      .setLabel('Encerrar partida')
      .setStyle(ButtonStyle.Danger)
  );
}

async function criarPartida(interaction, modo, jogadores) {
  const guild = interaction.guild;
  await guild.channels.fetch();

  const embaralhados = [...jogadores].sort(() => Math.random() - 0.5);
  const metade = embaralhados.length / 2;
  const timeA = embaralhados.slice(0, metade);
  const timeB = embaralhados.slice(metade);

  const permitido = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
  ];
  const staffRoles = guild.roles.cache.filter((r) => STAFF_ROLES.includes(r.name));
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...jogadores.map((id) => ({ id, allow: permitido })),
    ...staffRoles.map((r) => ({ id: r.id, allow: permitido })),
  ];

  let categoria = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === 'PARTIDAS'
  );
  if (!categoria) {
    categoria = await guild.channels.create({ name: 'PARTIDAS', type: ChannelType.GuildCategory });
  }

  const numero = Math.floor(Math.random() * 9000) + 1000;
  const canal = await guild.channels.create({
    name: `partida-${modo}-${numero}`,
    type: ChannelType.GuildText,
    parent: categoria.id,
    permissionOverwrites: overwrites,
  });

  const dados = db.ler();
  dados.partidas[canal.id] = { modo, timeA, timeB, finalizada: false };
  db.salvar(dados);

  const texto =
    `**Partida ${modo} encontrada**\n\n` +
    `**Time A:**\n${timeA.map((id) => `<@${id}>`).join('\n')}\n\n` +
    `**Time B:**\n${timeB.map((id) => `<@${id}>`).join('\n')}\n\n` +
    'Um jogador cria a sala no jogo e clica em **Enviar sala** para passar o ID e a senha. ' +
    'Ao terminar, enviem o print do resultado aqui. Um mediador confirma o vencedor pelos botões.';

  await canal.send({ content: texto, components: [botoesPartida()] });

  await interaction.followUp({
    content: `Partida encontrada! Canal: ${canal}`,
    flags: MessageFlags.Ephemeral,
  });
}

// Retorna true se a interação foi tratada aqui
async function handle(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'painel-fila') {
    const modo = interaction.options.getString('modo');
    filas.set(interaction.channelId, { modo, jogadores: [] });
    await interaction.channel.send({
      content: textoFila(modo, []),
      components: [botoesFila(modo)],
      allowedMentions: { parse: [] },
    });
    await interaction.reply({ content: 'Painel de fila enviado!', flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'ranking') {
    const dados = db.ler();
    const lista = Object.entries(dados.ranking)
      .sort((a, b) => b[1].vitorias - a[1].vitorias || a[1].derrotas - b[1].derrotas)
      .slice(0, 10);

    if (!lista.length) {
      await interaction.reply({
        content: 'Ainda não há partidas registradas.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const linhas = lista.map(
      ([id, s], i) => `${i + 1}. <@${id}> - ${s.vitorias}V / ${s.derrotas}D`
    );
    await interaction.reply({
      content: '**Ranking de vitórias**\n' + linhas.join('\n'),
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (!interaction.isButton()) return false;
  const [acao, modo] = interaction.customId.split(':');

  if (acao === 'fila_encerrar') {
    if (!ehStaff(interaction.member)) {
      await interaction.reply({
        content: 'Só a equipe pode encerrar partidas.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    await interaction.reply('Partida será encerrada em 5 segundos...');
    setTimeout(() => interaction.channel.delete().catch(console.error), 5000);
    return true;
  }

  if (acao === 'res_A' || acao === 'res_B') {
    if (!ehStaff(interaction.member)) {
      await interaction.reply({
        content: 'Só a equipe pode confirmar o resultado.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const dados = db.ler();
    const partida = dados.partidas[interaction.channelId];
    if (!partida) {
      await interaction.reply({
        content: 'Não encontrei os dados desta partida.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (partida.finalizada) {
      await interaction.reply({
        content: 'O resultado desta partida já foi registrado.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const venceuA = acao === 'res_A';
    const vencedores = venceuA ? partida.timeA : partida.timeB;
    const perdedores = venceuA ? partida.timeB : partida.timeA;

    vencedores.forEach((id) => { statsDe(dados, id).vitorias += 1; });
    perdedores.forEach((id) => { statsDe(dados, id).derrotas += 1; });

    partida.finalizada = true;
    partida.vencedor = venceuA ? 'A' : 'B';
    db.salvar(dados);

    await interaction.update({ components: [botoesPartida(true)] });
    await interaction.channel.send({
      content:
        `Resultado confirmado por ${interaction.user}: **Time ${venceuA ? 'A' : 'B'} venceu!**\n` +
        `Vencedores: ${vencedores.map((id) => `<@${id}>`).join(' ')}\n` +
        'Use **Encerrar partida** quando quiser fechar este canal.',
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (acao !== 'fila_entrar' && acao !== 'fila_sair') return false;

  let fila = filas.get(interaction.channelId);
  if (!fila || fila.modo !== modo) {
    fila = { modo, jogadores: [] };
    filas.set(interaction.channelId, fila);
  }
  const userId = interaction.user.id;

  if (acao === 'fila_sair') {
    if (!fila.jogadores.includes(userId)) {
      await interaction.reply({
        content: 'Você não está nessa fila.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    fila.jogadores = fila.jogadores.filter((id) => id !== userId);
    await interaction.update({
      content: textoFila(modo, fila.jogadores),
      components: [botoesFila(modo)],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  for (const f of filas.values()) {
    if (f.jogadores.includes(userId)) {
      await interaction.reply({
        content: 'Você já está em uma fila.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
  }

  fila.jogadores.push(userId);

  if (fila.jogadores.length >= MODOS[modo]) {
    const grupo = fila.jogadores.splice(0, MODOS[modo]);
    await interaction.update({
      content: textoFila(modo, fila.jogadores),
      components: [botoesFila(modo)],
      allowedMentions: { parse: [] },
    });
    await criarPartida(interaction, modo, grupo);
    return true;
  }

  await interaction.update({
    content: textoFila(modo, fila.jogadores),
    components: [botoesFila(modo)],
    allowedMentions: { parse: [] },
  });
  return true;
}

module.exports = { commands, handle };