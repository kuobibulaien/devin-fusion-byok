'use strict';
const path = require('node:path');
const {
  MAX_EVIDENCE_LENGTH, REPORT_STATUSES, identifier, goalId, runId, capabilityToken,
  normalizeEvidence, readCapability, readGoal, writeReport
} = require('./goal-store.cjs');

const USAGE = '用法：goal-report.cjs --store <绝对路径> --capability <令牌> \'{"status":"progress","evidence":"..."}\'';
const REPORT_FIELDS = new Set(['status', 'evidence']);

const fail = error => ({ ok: false, error });

function parseArguments(argv) {
  let store, token, payload = null;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--store' || argument === '--capability') {
      const value = argv[++index];
      if (typeof value !== 'string' || !value) return fail('缺少参数值：' + argument);
      if (argument === '--store') store = value; else token = value;
      continue;
    }
    if (argument === '--help' || argument === '-h') return { ok: true, help: true };
    if (argument.startsWith('--')) return fail('不支持的参数：' + argument);
    if (payload !== null) return fail('只接受一个 JSON 参数。');
    payload = argument;
  }
  if (!store || !token || payload === null) return fail('参数不完整。' + USAGE);
  if (!path.isAbsolute(store)) return fail('store 必须是绝对路径。');
  if (!capabilityToken(token)) return fail('能力令牌格式无效。');
  let parsed;
  try { parsed = JSON.parse(payload); } catch { return fail('JSON 参数无法解析。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('JSON 参数必须是对象。');
  for (const key of Object.keys(parsed)) if (!REPORT_FIELDS.has(key)) return fail('不支持的字段：' + key);
  const validated = validateReport(parsed);
  if (!validated.ok) return validated;
  return { ok: true, store, token, status: validated.status, evidence: validated.evidence };
}

function validateReport(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('报告必须是对象。');
  for (const key of Object.keys(parsed)) if (!REPORT_FIELDS.has(key)) return fail('不支持的字段：' + key);
  if (!REPORT_STATUSES.includes(parsed.status)) return fail('status 必须是 ' + REPORT_STATUSES.join('/') + '。');
  const evidence = normalizeEvidence(parsed.evidence);
  if (!evidence) return fail('evidence 必须是 1 到 ' + MAX_EVIDENCE_LENGTH + ' 字符的文本。');
  return { ok: true, status: parsed.status, evidence };
}

function submit({ store, token, status, evidence, now = Date.now }) {
  const validated = validateReport({ status, evidence });
  if (!validated.ok) return validated;
  let capability, goal;
  try {
    capability = readCapability(store, token);
    if (!capability) return fail('能力令牌无效或已失效。');
    goal = readGoal(store, capability.sessionId);
  } catch { return fail('目标状态存储不可读或已损坏。'); }
  if (!goal) return fail('目标状态不存在。');
  if (goal.id !== capability.id) return fail('能力令牌与目标不匹配。');
  if (goal.revision !== capability.revision) return fail('目标修订已变化，本次报告被拒绝。');
  if (goal.activeRun !== capability.runId) return fail('该运行已不是当前活动运行。');
  if (goal.status !== 'active') return fail('目标当前不接受报告。');
  const run = runId(capability.runId);
  if (!run) return fail('运行标识无效。');
  try {
    writeReport(store, run, {
      id: goalId(capability.id), revision: capability.revision, sessionId: identifier(capability.sessionId),
      status: validated.status, evidence: validated.evidence
    });
  } catch (error) {
    if (error?.code === 'EEXIST') return fail('该运行已经提交过报告。');
    return fail('报告写入失败。');
  }
  return { ok: true, accepted: true, runId: run, status: validated.status, revision: capability.revision, submittedAt: now() };
}

function main(argv) {
  const parsed = parseArguments(argv);
  if (!parsed.ok) return { code: 2, result: parsed };
  if (parsed.help) return { code: 0, result: { ok: true, usage: USAGE } };
  const result = submit(parsed);
  return { code: result.ok ? 0 : 1, result };
}

if (require.main === module) {
  const outcome = main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(outcome.result) + '\n');
  process.exitCode = outcome.code;
}

module.exports = { main, parseArguments, validateReport, submit, USAGE };