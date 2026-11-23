const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /heroku|sslmode=require/i.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : undefined
  });
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('Schema applied.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
