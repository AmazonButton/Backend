import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inDollarQuote = false;
  let inSingleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const nextChar = sql[i + 1] || '';

    // Line comment
    if (!inSingleQuote && !inDollarQuote && !inBlockComment && char === '-' && nextChar === '-') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (inLineComment && (char === '\n' || char === '\r')) {
      inLineComment = false;
      current += char;
      i++;
      continue;
    }
    if (inLineComment) {
      i++;
      continue;
    }

    // Block comment
    if (!inSingleQuote && !inDollarQuote && !inLineComment && char === '/' && nextChar === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (inBlockComment && char === '*' && nextChar === '/') {
      inBlockComment = false;
      i += 2;
      continue;
    }
    if (inBlockComment) {
      i++;
      continue;
    }

    // Dollar quote ($$ or $function$)
    if (!inSingleQuote && char === '$') {
      const match = sql.slice(i).match(/^(\$[a-zA-Z0-9_]*\$)/);
      if (match) {
        inDollarQuote = !inDollarQuote;
        current += match[1];
        i += match[1].length;
        continue;
      }
    }

    // Single quote
    if (!inDollarQuote && char === "'") {
      if (nextChar === "'") {
        current += "''";
        i += 2;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      current += char;
      i++;
      continue;
    }

    // Semicolon when outside quotes
    if (!inDollarQuote && !inSingleQuote && char === ';') {
      const trimmed = current.trim();
      if (trimmed) {
        statements.push(trimmed);
      }
      current = '';
      i++;
      continue;
    }

    current += char;
    i++;
  }

  const remainder = current.trim();
  if (remainder) {
    statements.push(remainder);
  }

  return statements;
}

async function applyMigrations() {
  console.log('--- Applying Platform Button Rental Migrations with Robust SQL Parsing ---');

  const migrationFiles = [
    path.join(__dirname, '../prisma/migrations/20261030000000_platform_button_rental_expansion/migration.sql'),
    path.join(__dirname, '../prisma/migrations/20261030180000_rental_deep_hardening/migration.sql'),
    path.join(__dirname, '../prisma/migrations/20261030190000_rental_backfill_and_lease_hardening/migration.sql'),
    path.join(__dirname, '../prisma/migrations/20261030200000_rental_historical_backfill_and_audit_immutability/migration.sql'),
    path.join(__dirname, '../prisma/migrations/20261030210000_rental_historical_backfill_precision/migration.sql'),
  ];

  for (const file of migrationFiles) {
    const dirName = path.basename(path.dirname(file));
    console.log(`\nProcessing migration: [${dirName}]`);
    const sql = fs.readFileSync(file, 'utf-8');
    const statements = splitSqlStatements(sql);
    console.log(`Found ${statements.length} valid statements.`);

    for (let idx = 0; idx < statements.length; idx++) {
      const stmt = statements[idx];
      const preview = stmt.replace(/\s+/g, ' ').slice(0, 60);
      try {
        await prisma.$executeRawUnsafe(stmt);
        console.log(`  [${idx + 1}/${statements.length}] ✔ ${preview}...`);
      } catch (err: any) {
        console.error(`  [${idx + 1}/${statements.length}] ✖ ${preview}... ERROR: ${err.message}`);
      }
    }
  }

  await prisma.$disconnect();
  console.log('\nMigration execution completed.');
}

applyMigrations().catch((err) => {
  console.error('Fatal migration runner error:', err);
  process.exit(1);
});
