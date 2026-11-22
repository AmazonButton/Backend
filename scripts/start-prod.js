require('dotenv/config');
const path = require('path');
const { resolveCommitSha } = require('./resolve-commit-sha');

if (!process.env.RENDER_GIT_COMMIT && !process.env.GITHUB_SHA && !process.env.COMMIT_SHA) {
  const resolvedSha = resolveCommitSha(process.env, path.resolve(__dirname, '..'));
  if (resolvedSha && resolvedSha !== 'unknown') {
    process.env.COMMIT_SHA = resolvedSha;
  }
}

console.log('🔄 Checking database environment...');
const dbUrl = process.env.DATABASE_URL || '';

if (!dbUrl) {
  console.error('❌ [FATAL] DATABASE_URL is NOT SET in Environment Variables!');
  process.exit(1);
}

// Launch NestJS Production Server immediately for fast zero-downtime container readiness
console.log('🚀 Launching NestJS Production Server...');
require(path.resolve(__dirname, '../dist/src/main.js'));
