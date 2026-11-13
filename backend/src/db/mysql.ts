import { createPool, type Pool } from "mysql2/promise";

let readPool: Pool | undefined;

// Reads a required MySQL setting or throws a clear error.
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for MySQL ERP integration`);
  return value;
}

// Returns the shared read-only MySQL pool for the ERP database.
export function getMysqlReadPool(): Pool {
  if (!readPool) {
    readPool = createPool({
      host: process.env.MYSQL_READ_HOST?.trim() || required("MYSQL_HOST"),
      port: Number(process.env.MYSQL_PORT || 3306),
      user: required("MYSQL_USER"),
      password: required("MYSQL_PASSWORD"),
      database: required("MYSQL_DATABASE"),
      waitForConnections: true,
      connectionLimit: Number(process.env.MYSQL_POOL_LIMIT || 10),
      queueLimit: 0,
      enableKeepAlive: true,
      multipleStatements: false,
      connectTimeout: 8000
    });
  }
  return readPool;
}

// Closes the MySQL pool if it was opened.
export async function closeMysql(): Promise<void> {
  if (readPool) {
    const pool = readPool;
    readPool = undefined;
    await pool.end();
  }
}
