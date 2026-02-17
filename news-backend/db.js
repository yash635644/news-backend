
const { Pool } = require('pg');

// Neon / PostgreSQL Connection
// Ensure DATABASE_URL is set in .env (e.g., postgres://user:pass@ep-xyz.us-east-1.aws.neon.tech/neondb?sslmode=require)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    max: 20, // Connection pool limit
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool
};
