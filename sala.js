const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');

function botaoSala() {
  return new ButtonBuilder()
    .setCustomId('sala_enviar')
    .setLabel('Enviar sala')
    .setStyle(ButtonStyle.Primary);
}

function limpar(texto) {
  return texto.replace(/`/g, '').trim();
}

// Retorna true se a interação foi tratada aqui
async function handle(interaction) {
  if (interaction.isButton() && interaction.customId === 'sala_enviar') {
    const modal = new ModalBuilder()
      .setCustomId('sala_modal')
      .setTitle('Enviar sala')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('sala_id')
            .setLabel('ID da sala')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(30)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('sala_senha')
            .setLabel('Senha da sala')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(30)
        )
      );
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'sala_modal') {
    const id = limpar(interaction.fields.getTextInputValue('sala_id'));
    const senha = limpar(interaction.fields.getTextInputValue('sala_senha'));

    await interaction.channel.send({
      content:
        `**Sala enviada por ${interaction.user}**\n` +
        `ID da sala: \`${id}\`\n` +
        `Senha: \`${senha}\``,
      allowedMentions: { parse: [] },
    });
    await interaction.reply({ content: 'Sala enviada!', flags: MessageFlags.Ephemeral });
    return true;
  }

  return false;
}

module.exports = { botaoSala, handle };