const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const db = require('./db');

const commands = [
  new SlashCommandBuilder()
    .setName('perfil')
    .setDescription('Mostra seu saldo de coins e estatísticas de jogo'),
  new SlashCommandBuilder()
    .setName('saldo')
    .setDescription('Gerencia o saldo de coins de um jogador (Apenas Gerente/ADM)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((o) => o.setName('usuario').setDescription('Jogador').setRequired(true))
    .addStringOption((o) =>
      o.setName('operacao')
        .setDescription('Adicionar ou remover')
        .setRequired(true)
        .addChoices(
          { name: 'Adicionar', value: 'add' },
          { name: 'Remover', value: 'remove' }
        )
    )
    .addNumberOption((o) => o.setName('valor').setDescription('Quantidade de coins').setRequired(true)),
].map((c) => c.toJSON());

async function handle(interaction) {
  if (!interaction.isChatInputCommand()) return false;

  // --- Comando /perfil ---
  if (interaction.commandName === 'perfil') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId = interaction.user.id;
    const username = interaction.user.username;

    try {
      // 1. Busca dados no PostgreSQL
      let res = await db.query('SELECT balance, locked_balance FROM users WHERE discord_id = $1', [userId]);

      if (res.rows.length === 0) {
        console.log(`[BANCO] Criando cadastro automático para: ${username} (${userId})`);
        
        // 2. Insere garantindo o preenchimento de discord_id, username, saldos e papel inicial
        await db.query(
          `INSERT INTO users (discord_id, username, balance, locked_balance, role) 
           VALUES ($1, $2, 0.00, 0.00, 'PLAYER')
           ON CONFLICT (discord_id) DO NOTHING`,
          [userId, username]
        );
        
        res = await db.query('SELECT balance, locked_balance FROM users WHERE discord_id = $1', [userId]);
      }

      // Estatísticas do data.json local
      const dadosLocal = db.ler();
      const stats = dadosLocal.ranking[userId] || { vitorias: 0, derrotas: 0 };
      const totalPartidas = stats.vitorias + stats.derrotas;

      const embed = new EmbedBuilder()
        .setTitle(`👤 Perfil de ${username}`)
        .setColor(0x00ff88)
        .addFields(
          { name: '💰 Saldo Disponível', value: `**${parseFloat(res.rows[0].balance).toFixed(2)}** coins`, inline: true },
          { name: '🔒 Saldo Bloqueado', value: `**${parseFloat(res.rows[0].locked_balance).toFixed(2)}** coins`, inline: true },
          { name: '🎮 Total de Partidas', value: `${totalPartidas}`, inline: false },
          { name: '🏆 Vitórias', value: `${stats.vitorias}`, inline: true },
          { name: '❌ Derrotas', value: `${stats.derrotas}`, inline: true }
        )
        .setThumbnail(interaction.user.displayAvatarURL())
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return true;
    } catch (err) {
      console.error('❌ [ERRO BANCO /PERFIL]:', err);
      await interaction.editReply('❌ Erro ao buscar dados do perfil.');
      return true;
    }
  }

  // --- Comando /saldo ---
  if (interaction.commandName === 'saldo') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const alvo = interaction.options.getUser('usuario');
    const operacao = interaction.options.getString('operacao');
    const valor = interaction.options.getNumber('valor');

    if (valor <= 0) {
      await interaction.editReply('❌ O valor deve ser maior que zero.');
      return true;
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Garantia de registro do usuário de destino
      await client.query(
        `INSERT INTO users (discord_id, username, balance, locked_balance, role)
         VALUES ($1, $2, 0.00, 0.00, 'PLAYER')
         ON CONFLICT (discord_id) DO NOTHING`,
        [alvo.id, alvo.username]
      );

      let sql = '';
      if (operacao === 'add') {
        sql = `UPDATE users SET balance = balance + $1 WHERE discord_id = $2 RETURNING balance`;
      } else {
        sql = `UPDATE users SET balance = GREATEST(0, balance - $1) WHERE discord_id = $2 RETURNING balance`;
      }

      const res = await client.query(sql, [valor, alvo.id]);

      // Registra transação auditada na tabela transactions
      const tipoTransacao = operacao === 'add' ? 'DEPOSIT' : 'WITHDRAWAL';
      const valorTransacao = operacao === 'add' ? valor : -valor;

      await client.query(
        `INSERT INTO transactions (user_id, amount, type, description)
         VALUES ($1, $2, $3, $4)`,
        [alvo.id, valorTransacao, tipoTransacao, `Ajuste manual por ${interaction.user.username}`]
      );

      await client.query('COMMIT');

      const novoSaldo = parseFloat(res.rows[0].balance).toFixed(2);
      await interaction.editReply(
        `✅ Saldo de <@${alvo.id}> atualizado com sucesso! Novo saldo: **${novoSaldo} coins**.`
      );
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ [ERRO BANCO /SALDO]:', err);
      await interaction.editReply('❌ Erro ao atualizar o saldo do jogador.');
      return true;
    } finally {
      client.release();
    }
  }

  return false;
}

module.exports = { commands, handle };