const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Resolves the running commit SHA from platform env vars or local git metadata.
 */
function resolveCommitSha(env = process.env, repoRoot = path.resolve(__dirname, '..')) {
  const candidates = [env.RENDER_GIT_COMMIT, env.GITHUB_SHA, env.COMMIT_SHA];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return sha || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = { resolveCommitSha };
