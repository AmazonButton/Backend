/**
 * AWS EC2 Node 3 Remote CLI Controller
 * Allows direct command execution and management of AWS Node 3 from this workspace.
 *
 * Usage:
 *   node scripts/aws_node3.js "pm2 status"
 *   node scripts/aws_node3.js "cd ~/Backend/Backend && git pull && pm2 reload backend-node3"
 */

const { execSync } = require('child_process');
const path = require('path');

const keyPath = path.join(process.env.USERPROFILE, '.ssh', 'id_aws_node3');
const host = 'ubuntu@3.25.136.6';
const sshBinary = 'C:\\Users\\ttphatt_2403\\git\\usr\\bin\\ssh.exe';

const command = process.argv.slice(2).join(' ') || 'uptime && pm2 status';

console.log(`📡 [AWS Node 3] Executing: ${command}`);

try {
  const output = execSync(`"${sshBinary}" -i "${keyPath}" -o StrictHostKeyChecking=no ${host} "${command}"`, {
    encoding: 'utf8',
    stdio: 'inherit',
  });
} catch (err) {
  process.exit(err.status || 1);
}
