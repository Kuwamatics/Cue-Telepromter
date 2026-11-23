// SomaPrompt owner tools. Run on the server (on Render: open your service, then Shell).
//
//   node tools/admin.mjs users                         list accounts and their teams
//   node tools/admin.mjs reset-password EMAIL          set a new random password and print it
//   node tools/admin.mjs reset-password EMAIL NEWPASS  set a password you choose (8+ characters)
//
// Resetting a password also signs that person out everywhere.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.CUE_DATA || path.join(ROOT, 'data');
const db = new DatabaseSync(path.join(DATA, 'cue.db'));

function hashPass(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString('base64')}$${h.toString('base64')}`;
}

const [cmd, email, given] = process.argv.slice(2);

if (cmd === 'users') {
  const rows = db.prepare(`SELECT u.name, u.email, w.name AS team, w.code, datetime(u.created/1000,'unixepoch') AS joined
    FROM users u JOIN workspaces w ON w.id = u.workspace ORDER BY u.created`).all();
  if (!rows.length) console.log('No accounts yet.');
  for (const r of rows) console.log(`${r.email}  ·  ${r.name}  ·  team "${r.team}" (invite code ${r.code})  ·  joined ${r.joined} UTC`);
} else if (cmd === 'reset-password' && email) {
  const u = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!u) { console.error(`No account with the email ${email}.`); process.exit(1); }
  const pw = given || crypto.randomBytes(9).toString('base64url');
  if (pw.length < 8) { console.error('Use a password of at least 8 characters.'); process.exit(1); }
  db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPass(pw), u.id);
  const ended = db.prepare('DELETE FROM sessions WHERE user = ?').run(u.id).changes;
  console.log(`Password for ${u.name} <${email}> is now: ${pw}`);
  console.log(`Signed out of ${ended} session(s). Ask them to sign in and keep the new password safe.`);
} else {
  console.log('Usage:\n  node tools/admin.mjs users\n  node tools/admin.mjs reset-password EMAIL [NEWPASS]');
  process.exit(cmd ? 1 : 0);
}
