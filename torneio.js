const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  UserSelectMenuBuilder, MessageFlags,
} = require('discord.js');
const db = require('./db');

const STAFF_ROLES = ['ADM', 'Mediador', 'Suporte'];
const EPH = MessageFlags.Ephemeral;
const MODOS = ['1v1', '2v2', '3v3', '4v4'];

const commands = [
  new SlashCommandBuilder()
    .setName('torneio')
    .setDescription('Gerencia campeonatos')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) =>
      s.setName('criar')
        .setDescription('Cria um campeonato neste canal')
        .addStringOption((o) =>
          o.setName('nome').setDescription('Nome do campeonato').setRequired(true))
        .addStringOption((o) =>
          o.setName('modo').setDescription('Modo de jogo').setRequired(true)
            .addChoices(...MODOS.map((m) => ({ name: m, value: m }))))
        .addIntegerOption((o) =>
          o.setName('vagas').setDescription('Número de times (no 1v1, número de jogadores)').setRequired(true)
            .addChoices(
              { name: '4 times', value: 4 },
              { name: '8 times', value: 8 },
              { name: '16 times', value: 16 }
            ))
    )
    .addSubcommand((s) =>
      s.setName('cancelar').setDescription('Cancela o campeonato atual')
    ),
  new SlashCommandBuilder()
    .setName('chave')
    .setDescription('Mostra a chave do campeonato atual'),
].map((c) => c.toJSON());

// ---------- Utilidades ----------
function ehStaff(membro) {
  return (
    membro.permissions.has(PermissionFlagsBits.Administrator) ||
    membro.roles.cache.some((r) => STAFF_ROLES.includes(r.name))
  );
}

function embaralhar(lista) {
  const a = [...lista];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mencoes(ids) {
  return ids.map((id) => `<@${id}>`).join(' ');
}

function unidade(t, plural = true) {
  if (t.tamanho === 1) return plural ? 'jogadores' : 'jogador';
  return plural ? 'times' : 'time';
}

function nomeDaRodada(n) {
  return { 2: 'final', 4: 'semifinal', 8: 'quartas', 16: 'oitavas' }[n] || `rodada-${n}`;
}

function tituloDaRodada(n) {
  return {
    2: 'Final', 4: 'Semifinal', 8: 'Quartas de final', 16: 'Oitavas de final',
  }[n] || `Rodada de ${n}`;
}

async function getCategoria(guild, nome) {
  await guild.channels.fetch();
  let cat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === nome
  );
  if (!cat) cat = await guild.channels.create({ name: nome, type: ChannelType.GuildCategory });
  return cat;
}

// ---------- Textos ----------
function textoPainel(t) {
  const cab = `**${t.nome}** - ${t.modo} - ${t.vagas} ${unidade(t)}`;
  if (t.estado === 'finalizado') {
    const c = t.times[t.campeao];
    return `${cab}\n\n**Campeão: ${c.nome}** ${mencoes(c.membros)}`;
  }
  if (t.estado === 'andamento') {
    return `${cab}\n\nCampeonato em andamento. Use /chave para acompanhar.`;
  }
  const lista = t.times.length
    ? t.times.map((x, i) => `${i + 1}. **${x.nome}** - ${mencoes(x.membros)}`).join('\n')
    : `Nenhum ${unidade(t, false)} inscrito ainda.`;
  return `${cab}\n\nInscritos (${t.times.length}/${t.vagas}):\n${lista}`;
}

function textoChave(t) {
  if (t.estado === 'inscricoes') return textoPainel(t);
  const rodadas = [...new Set(t.partidas.map((p) => p.rodada))];
  const blocos = rodadas.map((r) => {
    const ps = t.partidas.filter((p) => p.rodada === r);
    const titulo = tituloDaRodada(ps.length * 2).toUpperCase();
    const linhas = ps.map((p) => {
      const a = t.times[p.a].nome;
      const b = t.times[p.b].nome;
      return p.vencedor === null
        ? `${a} x ${b} - em andamento`
        : `${a} x ${b} - venceu: **${t.times[p.vencedor].nome}**`;
    });
    return `**${titulo}**\n${linhas.join('\n')}`;
  });
  let txt = `**${t.nome}** - ${t.modo}\n\n${blocos.join('\n\n')}`;
  if (t.estado === 'finalizado') txt += `\n\n**Campeão: ${t.times[t.campeao].nome}**`;
  return txt;
}

// ---------- Botões e janelas ----------
function botaoInscrever(t) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('t_inscrever')
      .setLabel(t && t.tamanho === 1 ? 'Inscrever-se' : 'Inscrever time')
      .setStyle(ButtonStyle.Success)
  );
}

function botoesPartida(t, p, desativado) {
  const cortar = (s) => s.slice(0, 30);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('t_vencA')
      .setLabel(`${cortar(t.times[p.a].nome)} venceu`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(desativado),
    new ButtonBuilder()
      .setCustomId('t_vencB')
      .setLabel(`${cortar(t.times[p.b].nome)} venceu`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(desativado),
    new ButtonBuilder()
      .setCustomId('sala_enviar')
      .setLabel('Enviar sala')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('t_fechar')
      .setLabel('Fechar canal')
      .setStyle(ButtonStyle.Danger)
  );
}

function modalInscricao(ids) {
  return new ModalBuilder()
    .setCustomId(`t_modal:${ids.join(',')}`)
    .setTitle('Inscrição')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('t_nome')
          .setLabel('Nome do time (no 1v1, seu nick)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(25)
      )
    );
}

// ---------- Painel ----------
async function atualizarPainel(guild, t) {
  try {
    const canal = await guild.channels.fetch(t.painelCanalId);
    const msg = await canal.messages.fetch(t.painelMsgId);
    await msg.edit({
      content: textoPainel(t),
      components: t.estado === 'inscricoes' ? [botaoInscrever(t)] : [],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error('Erro ao atualizar o painel:', err.message);
  }
}

// ---------- Rodadas ----------
async function criarRodada(guild, dados, t, ordem, numRodada) {
  await guild.roles.fetch();
  const categoria = await getCategoria(guild, 'TORNEIO');
  const staffRoles = guild.roles.cache.filter((r) => STAFF_ROLES.includes(r.name));
  const permitido = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
  ];
  const nomeBase = nomeDaRodada(ordem.length);

  for (let i = 0; i < ordem.length; i += 2) {
    const a = ordem[i];
    const b = ordem[i + 1];
    const ta = t.times[a];
    const tb = t.times[b];

    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      ...[...ta.membros, ...tb.membros].map((id) => ({ id, allow: permitido })),
      ...staffRoles.map((r) => ({ id: r.id, allow: permitido })),
    ];

    const canal = await guild.channels.create({
      name: ordem.length === 2 ? 'final' : `${nomeBase}-${i / 2 + 1}`,
      type: ChannelType.GuildText,
      parent: categoria.id,
      permissionOverwrites: overwrites,
    });

    const p = { rodada: numRodada, a, b, canalId: canal.id, vencedor: null };
    t.partidas.push(p);
    db.salvar(dados);

    await canal.send({
      content:
        `**${t.nome} - ${tituloDaRodada(ordem.length)}**\n\n` +
        `**${ta.nome}:** ${mencoes(ta.membros)}\n` +
        `**${tb.nome}:** ${mencoes(tb.membros)}\n\n` +
        'Um jogador cria a sala no jogo e clica em **Enviar sala** para passar o ID e a senha. ' +
        'Ao terminar, enviem o print do resultado aqui. Um mediador confirma o vencedor pelos botões.',
      components: [botoesPartida(t, p, false)],
    });
  }
}

async function iniciar(guild, dados, t) {
  t.estado = 'andamento';
  t.partidas = [];
  db.salvar(dados);
  await atualizarPainel(guild, t);
  const ordem = embaralhar(t.times.map((_, i) => i));
  await criarRodada(guild, dados, t, ordem, 1);
}

async function finalizar(guild, dados, t, idx) {
  t.estado = 'finalizado';
  t.campeao = idx;
  db.salvar(dados);
  const time = t.times[idx];

  await guild.roles.fetch();
  let role = guild.roles.cache.find((r) => r.name === 'Campeão');
  if (!role) {
    role = await guild.roles.create({
      name: 'Campeão', color: 0xf1c40f, reason: 'Campeão de torneio',
    });
  }
  for (const id of time.membros) {
    try {
      const membro = await guild.members.fetch(id);
      await membro.roles.add(role);
    } catch (err) {
      console.error('Não consegui dar o cargo Campeão:', err.message);
    }
  }

  await guild.channels.fetch();
  const avisos = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === 'avisos'
  );
  if (avisos) {
    await avisos
      .send(`**CAMPEÃO DO ${t.nome.toUpperCase()}: ${time.nome}!**\n${mencoes(time.membros)}\nParabéns!`)
      .catch(console.error);
  }
  await atualizarPainel(guild, t);
}

async function avancar(guild, dados, t, rodada) {
  const daRodada = t.partidas.filter((p) => p.rodada === rodada);
  if (daRodada.some((p) => p.vencedor === null)) return;

  const vencedores = daRodada.map((p) => p.vencedor);
  if (vencedores.length === 1) {
    await finalizar(guild, dados, t, vencedores[0]);
  } else {
    await criarRodada(guild, dados, t, vencedores, rodada + 1);
  }
}

// ---------- Tratamento das interações ----------
// Retorna true se a interação foi tratada aqui
async function handle(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'chave') {
      const t = db.ler().torneios[guild.id];
      if (!t) {
        await interaction.reply({ content: 'Não há campeonato ativo.', flags: EPH });
        return true;
      }
      await interaction.reply({ content: textoChave(t), allowedMentions: { parse: [] } });
      return true;
    }

    if (interaction.commandName === 'torneio') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'criar') {
        await interaction.deferReply({ flags: EPH });
        const dados = db.ler();
        const atual = dados.torneios[guild.id];
        if (atual && atual.estado !== 'finalizado') {
          await interaction.editReply(
            'Já existe um campeonato ativo. Use /torneio cancelar antes de criar outro.'
          );
          return true;
        }

        const modo = interaction.options.getString('modo');
        const t = {
          nome: interaction.options.getString('nome'),
          modo,
          tamanho: parseInt(modo[0], 10),
          vagas: interaction.options.getInteger('vagas'),
          times: [],
          estado: 'inscricoes',
          partidas: [],
          campeao: null,
          painelCanalId: interaction.channelId,
          painelMsgId: null,
        };

        const msg = await interaction.channel.send({
          content: textoPainel(t),
          components: [botaoInscrever(t)],
          allowedMentions: { parse: [] },
        });
        t.painelMsgId = msg.id;
        dados.torneios[guild.id] = t;
        db.salvar(dados);
        await interaction.editReply('Campeonato criado! O painel de inscrição foi enviado.');
        return true;
      }

      if (sub === 'cancelar') {
        await interaction.deferReply({ flags: EPH });
        const dados = db.ler();
        const t = dados.torneios[guild.id];
        if (!t) {
          await interaction.editReply('Não há campeonato para cancelar.');
          return true;
        }
        await guild.channels.fetch();
        for (const p of t.partidas || []) {
          const c = guild.channels.cache.get(p.canalId);
          if (c) await c.delete().catch(() => {});
        }
        try {
          const canal = await guild.channels.fetch(t.painelCanalId);
          const msg = await canal.messages.fetch(t.painelMsgId);
          await msg.edit({
            content: `**${t.nome}** foi cancelado.`,
            components: [],
          });
        } catch (err) {
          console.error(err.message);
        }
        delete dados.torneios[guild.id];
        db.salvar(dados);
        await interaction.editReply('Campeonato cancelado.');
        return true;
      }
    }
    return false;
  }

  const id = interaction.customId || '';
  if (!id.startsWith('t_')) return false;

  // Botão "Inscrever"
  if (id === 't_inscrever' && interaction.isButton()) {
    const t = db.ler().torneios[guild.id];
    if (!t || t.estado !== 'inscricoes') {
      await interaction.reply({ content: 'As inscrições não estão abertas.', flags: EPH });
      return true;
    }
    if (t.times.some((x) => x.membros.includes(interaction.user.id))) {
      await interaction.reply({ content: 'Você já está inscrito.', flags: EPH });
      return true;
    }
    if (t.tamanho === 1) {
      await interaction.showModal(modalInscricao([]));
      return true;
    }
    const menu = new UserSelectMenuBuilder()
      .setCustomId('t_sel')
      .setPlaceholder(`Escolha seus ${t.tamanho - 1} companheiros`)
      .setMinValues(t.tamanho - 1)
      .setMaxValues(t.tamanho - 1);
    await interaction.reply({
      content: `Você será o capitão. Selecione os outros ${t.tamanho - 1} jogadores do time:`,
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: EPH,
    });
    return true;
  }

  // Escolha dos companheiros
  if (id === 't_sel' && interaction.isUserSelectMenu()) {
    const ids = interaction.values;
    if (ids.includes(interaction.user.id)) {
      await interaction.reply({
        content: 'Não selecione você mesmo, você já é o capitão.',
        flags: EPH,
      });
      return true;
    }
    if (ids.some((i) => interaction.users.get(i)?.bot)) {
      await interaction.reply({ content: 'Bots não podem jogar.', flags: EPH });
      return true;
    }
    await interaction.showModal(modalInscricao(ids));
    return true;
  }

  // Envio do nome do time
  if (id.startsWith('t_modal') && interaction.isModalSubmit()) {
    await interaction.deferReply({ flags: EPH });
    const dados = db.ler();
    const t = dados.torneios[guild.id];
    if (!t || t.estado !== 'inscricoes') {
      await interaction.editReply('As inscrições não estão abertas.');
      return true;
    }

    const resto = id.split(':')[1] || '';
    const ids = resto ? resto.split(',') : [];
    const membros = [...new Set([interaction.user.id, ...ids])];
    const nome = interaction.fields.getTextInputValue('t_nome').trim();

    if (membros.length !== t.tamanho) {
      await interaction.editReply('Quantidade de jogadores incorreta para este modo.');
      return true;
    }
    if (t.times.length >= t.vagas) {
      await interaction.editReply('As vagas acabaram.');
      return true;
    }
    const ocupados = new Set(t.times.flatMap((x) => x.membros));
    if (membros.some((m) => ocupados.has(m))) {
      await interaction.editReply('Algum jogador já está inscrito em outro time.');
      return true;
    }
    if (t.times.some((x) => x.nome.toLowerCase() === nome.toLowerCase())) {
      await interaction.editReply('Já existe um time com esse nome. Escolha outro.');
      return true;
    }

    t.times.push({ nome, capitao: interaction.user.id, membros });
    db.salvar(dados);
    await interaction.editReply(`**${nome}** inscrito!`);

    if (t.times.length >= t.vagas) {
      await iniciar(guild, dados, t);
    } else {
      await atualizarPainel(guild, t);
    }
    return true;
  }

  // Resultado da partida do torneio
  if ((id === 't_vencA' || id === 't_vencB') && interaction.isButton()) {
    if (!ehStaff(interaction.member)) {
      await interaction.reply({
        content: 'Só a equipe pode confirmar o resultado.',
        flags: EPH,
      });
      return true;
    }

    const dados = db.ler();
    const t = dados.torneios[guild.id];
    const p = t && t.partidas.find((x) => x.canalId === interaction.channelId);
    if (!p) {
      await interaction.reply({ content: 'Não encontrei os dados desta partida.', flags: EPH });
      return true;
    }
    if (p.vencedor !== null) {
      await interaction.reply({ content: 'O resultado já foi registrado.', flags: EPH });
      return true;
    }

    p.vencedor = id === 't_vencA' ? p.a : p.b;
    db.salvar(dados);

    await interaction.update({ components: [botoesPartida(t, p, true)] });
    await interaction.channel.send({
      content:
        `Resultado confirmado por ${interaction.user}: ` +
        `**${t.times[p.vencedor].nome}** venceu e avança!`,
      allowedMentions: { parse: [] },
    });
    await avancar(guild, dados, t, p.rodada);
    return true;
  }

  // Fechar canal da partida
  if (id === 't_fechar' && interaction.isButton()) {
    if (!ehStaff(interaction.member)) {
      await interaction.reply({ content: 'Só a equipe pode fechar o canal.', flags: EPH });
      return true;
    }
    await interaction.reply('Canal será fechado em 5 segundos...');
    setTimeout(() => interaction.channel.delete().catch(console.error), 5000);
    return true;
  }

  return false;
}

module.exports = { commands, handle };