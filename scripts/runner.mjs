#!/usr/bin/env node
/* The Mac helper behind the dashboard's two run buttons.
 *
 * The dashboard cannot reach this Mac, so it queues a job on the Worker and
 * this script, left running here, polls for it every 30 seconds, runs Claude
 * Code in this folder with /score or /homework, and writes the final report
 * back for the dashboard to show.
 *
 *   node scripts/runner.mjs          run in the foreground, Ctrl+C to stop
 *
 * ~/Library/LaunchAgents/com.kidshomework.runner.plist keeps it running in the
 * background and restarts it at login. That file is not in the repo because it
 * names this Mac's paths. Log: ~/Library/Logs/kids-homework-runner.log
 *
 * Claude runs headless with a fixed tool list: the data CLI, node, python,
 * file edits and read only shell commands. git, wrangler and curl are NOT on
 * it, so a run from the dashboard can push next week's questions through
 * kh.py but can never commit, deploy or reach anywhere else.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const API = process.env.KH_API || md.match(/^\| API \| (https:\/\/\S+?)\s*\|/m)[1];
const TOKEN = process.env.KH_ADMIN_TOKEN || md.match(/Worker admin token:\s*`([^`]+)`/)[1];

const POLL_MS = 30_000;
const MAX_MS = 90 * 60_000;    // a run that takes longer than this is stuck
const REPORT_MAX = 20_000;

const UNATTENDED = '\n\nThis run was started from the dashboard and nobody is at the terminal. '
  + 'Do not ask anything or wait for a reply: decide, as CLAUDE.md section 2 says, and finish with the report.';
const PROMPTS = {
  score: '/score' + UNATTENDED,
  homework: '/homework' + UNATTENDED
    + ' Apply your own recommendations and carry straight on through step 8, building, gating and pushing next week, as the standing instruction says.',
};

const TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'TodoWrite',
  'mcp__command-bar__plan_steps', 'mcp__command-bar__report_progress',
  ...['scripts/kh.py', 'python3', 'node', 'printf', 'swift', 'cd', 'ls', 'cat', 'head', 'tail',
    'grep', 'sed', 'wc', 'sort', 'cut', 'mkdir', 'date'].map((c) => `Bash(${c}:*)`),
];

const now = () => new Date().toISOString();
const log = (...a) => console.log(now(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function admin(p, body = {}) {
  const res = await fetch(API + p, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status} from ${p}`);
  return j;
}
const sql = (s, params = []) => admin('/admin/sql', { statements: [{ sql: s, params }] });

function runClaude(prompt) {
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', ...TOOLS],
      { cwd: ROOT, env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), MAX_MS);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: `Could not start claude: ${e.message}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const text = out.trim() || err.trim()
        || (signal ? `Stopped after ${MAX_MS / 60_000} minutes.` : `claude exited with code ${code} and printed nothing.`);
      resolve({ ok: code === 0, text });
    });
    child.stdin.end(prompt);
  });
}

async function tick() {
  const { job } = await admin('/admin/runner/poll');
  if (!job) return;
  await sql("UPDATE job SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'", [now(), job.id]);
  log(`job ${job.id}: running ${job.kind}`);
  const r = await runClaude(PROMPTS[job.kind]);
  await sql('UPDATE job SET status = ?, finished_at = ?, report = ? WHERE id = ?',
    [r.ok ? 'done' : 'failed', now(), r.text.slice(-REPORT_MAX), job.id]);
  log(`job ${job.id}: ${r.ok ? 'done' : 'failed'}`);
}

// A job left running by a helper that died can never be finished by anyone else,
// and it would block every new run, so close it on start.
await sql("UPDATE job SET status = 'failed', finished_at = ?, report = 'The Mac helper restarted while this run was in progress. Start it again.' WHERE status = 'running'", [now()]);
log(`runner up, polling ${API} every ${POLL_MS / 1000}s`);
for (;;) {
  try { await tick(); } catch (e) { log('poll failed:', e.message); }
  await sleep(POLL_MS);
}
