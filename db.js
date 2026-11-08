const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Pool de conexão com o Supabase PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const FILE = path.join(__dirname, 'data.json');

function lerJSON() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      ranking: d.ranking || {},
      partidas: d.partidas || {},
      torneios: d.torneios || {},
    };
  } catch {
    return { ranking: {}, partidas: {}, torneios: {} };
  }
}

function salvarJSON(dados) {
  fs.writeFileSync(FILE, JSON.stringify(dados, null, 2));
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  ler: lerJSON,
  salvar: salvarJSON,
};