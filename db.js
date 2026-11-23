const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

let pool = null;
let ready = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /heroku|sslmode=require/i.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : undefined,
      max: 5
    });
  }
  return pool;
}

async function initDb() {
  if (!ready) {
    ready = (async () => {
      const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
      await getPool().query(schema);
      await getPool().query(`INSERT INTO settings (key, value) VALUES ('rate', '21.5') ON CONFLICT (key) DO NOTHING`);
    })();
  }
  return ready;
}

const q = (text, params) => getPool().query(text, params);

module.exports = { initDb, q, getPool };
