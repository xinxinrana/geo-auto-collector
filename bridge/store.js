import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { GeoError, TERMINAL, taskLinks } from '../shared/protocol.js';

export class Store {
  constructor(home) {
    this.home = home;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'artifacts'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(home, 'bridge.sqlite'));
    chmodSync(join(home, 'bridge.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, idem TEXT UNIQUE, hash TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);`);
  }
  task(id) { const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id); if (!row) throw new GeoError('not_found', '任务不存在', 404); return JSON.parse(row.data); }
  all() { return this.db.prepare('SELECT data FROM tasks ORDER BY rowid DESC').all().map(r => JSON.parse(r.data)); }
  active() { return this.all().filter(t => !TERMINAL.includes(t.status)); }
  create(command, idem, canAccept) {
    const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT * FROM tasks WHERE idem=?').get(idem);
      if (old) {
        if (old.hash !== hash) throw new GeoError('idempotency_conflict', '同一幂等键的参数不同', 409, { links: taskLinks(old.id) });
        this.db.exec('COMMIT'); return { task: JSON.parse(old.data), replay: true };
      }
      canAccept();
      const busy = this.active();
      if (command.action !== 'stop' && busy.length) throw new GeoError('busy', '已有页面动作正在执行', 409, { links: taskLinks(busy[0].id) });
      if (command.action === 'stop') {
        const target = command.taskId ? this.task(command.taskId) : busy.find(t => t.command.action !== 'stop');
        if (!target || TERMINAL.includes(target.status) || target.command.action === 'stop') throw new GeoError('no_active_task', '没有可停止的任务', 409);
        if (busy.some(t => t.command.action === 'stop')) throw new GeoError('busy', '停止请求正在等待确认', 409);
        command = { ...command, taskId: target.id };
      }
      const now = new Date().toISOString();
      const task = { id: `task_${randomUUID()}`, command, status: 'queued', step: 'accepted', createdAt: now, updatedAt: now, revision: 0, lastSeq: 0, resultAvailable: false };
      this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?)').run(task.id, idem, hash, JSON.stringify(task));
      this.db.exec('COMMIT'); return { task, replay: false };
    } catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
  }
  save(task) { this.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(task), task.id); }
  artifactPath(id, kind) { if (!/^task_[a-f0-9-]+$/.test(id) || !['result', 'screenshot'].includes(kind)) throw new GeoError('not_found', '产物不存在', 404); return join(this.home, 'artifacts', `${id}.${kind === 'result' ? 'json' : 'png'}`); }
  writeArtifact(id, kind, body) { const path = this.artifactPath(id, kind); const tmp = `${path}.tmp`; writeFileSync(tmp, body, { mode: 0o600 }); renameSync(tmp, path); }
  event(event) {
    const task = this.task(event.taskId);
    if (typeof event.runnerId !== 'string' || event.runnerId.length > 100 || !Number.isSafeInteger(event.seq) || event.seq < 1) throw new GeoError('invalid_event', '事件标识无效');
    const key = `${task.id}:${event.runnerId}:${event.seq}`;
    if (this.db.prepare('SELECT cursor FROM events WHERE key=?').get(key)) return;
    if (task.runnerId && task.runnerId !== event.runnerId) throw new GeoError('runner_conflict', '执行实例不匹配', 409);
    if (TERMINAL.includes(task.status)) throw new GeoError('terminal_task', '任务已经结束', 409);
    if (event.seq !== task.lastSeq + 1) throw new GeoError('event_gap', '事件序号不连续', 409, { expectedSeq: task.lastSeq + 1 });
    const { status, step, error, result, diagnostic, tabId, submissionState } = event;
    if (!['running', ...TERMINAL].includes(status) || typeof step !== 'string' || step.length > 100) throw new GeoError('invalid_event', '事件状态无效');
    if (status === 'done' && !result) throw new GeoError('invalid_event', '成功事件必须包含结果');
    const update = { ...task, runnerId: event.runnerId, lastSeq: event.seq, revision: task.revision + 1, status, step, updatedAt: new Date().toISOString() };
    if (error) update.error = error;
    if (tabId !== undefined) update.tabId = tabId;
    if (submissionState) update.submissionState = submissionState;
    if (result || diagnostic) {
      const saved = { ...(result || {}), ...(diagnostic ? { diagnostic } : {}) };
      if (saved.screenshotBase64) {
        const png = Buffer.from(saved.screenshotBase64, 'base64');
        if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new GeoError('invalid_artifact', '截图必须为 PNG');
        this.writeArtifact(task.id, 'screenshot', png);
        delete saved.screenshotBase64; saved.screenshot = { status: 'saved', format: 'png' };
      }
      this.writeArtifact(task.id, 'result', JSON.stringify(saved));
      update.resultAvailable = Boolean(result);
      update.diagnosticAvailable = Boolean(diagnostic);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.save(update);
      this.db.prepare('INSERT INTO events(task,key,data) VALUES (?,?,?)').run(task.id, key, JSON.stringify({ taskId: task.id, seq: event.seq, status, step, at: update.updatedAt, ...(error ? { error } : {}) }));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  lose(id) {
    const task = this.task(id);
    if (task.status === 'queued' || TERMINAL.includes(task.status)) return;
    this.event({ taskId: id, runnerId: task.runnerId, seq: task.lastSeq + 1, status: 'interrupted', step: 'recovery', error: { code: task.submissionState === 'intent' ? 'submission_unknown' : 'execution_lost', message: '扩展没有原执行记录；不会自动重新提交' } });
  }
  result(id) { this.task(id); const path = this.artifactPath(id, 'result'); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; }
  events(id, since = 0) {
    this.task(id);
    const rows = this.db.prepare('SELECT cursor,data FROM events WHERE task=? AND cursor>? ORDER BY cursor LIMIT 101').all(id, since);
    return { events: rows.slice(0, 100).map(r => ({ cursor: r.cursor, ...JSON.parse(r.data) })), cursor: rows.length ? rows[Math.min(rows.length, 100) - 1].cursor : since, hasMore: rows.length > 100 };
  }
  close() { this.db.close(); }
}
export function publicTask(t) {
  return { id: t.id, action: t.command.action, platform: t.command.platform, status: t.status, step: t.step, tabId: t.tabId, revision: t.revision, createdAt: t.createdAt, updatedAt: t.updatedAt, pollAfterMs: 2000, resultAvailable: t.resultAvailable, submissionState: t.submissionState, error: t.error, links: { ...taskLinks(t.id), ...(t.diagnosticAvailable ? { diagnostic: `/diagnostic/${t.id}` } : {}) } };
}
