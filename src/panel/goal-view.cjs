'use strict';
const crypto = require('node:crypto');

const STATUS_LABELS = {
  active: '进行中', paused: '已暂停', waiting: '等待输入', blocked: '受阻', limited: '已达运行上限',
  review: '待验收（不等于已完成）', completed: '已完成'
};
const SESSION_LABELS = { idle: '空闲', busy: '忙', unknown: '未知' };
const REASON_LABELS = {
  review: '模型请求人工验收，尚未完成', 'missing-report': '连续两次运行没有提交报告，已暂停',
  'max-runs': '已达运行上限', 'no-progress': '连续三次证据没有变化，已暂停', 'user-paused': '由用户暂停',
  'manual-prompt': '检测到用户手动输入，已暂停', 'session-busy': '会话正在处理其它请求，已暂停',
  'session-unavailable': '会话状态未知或不可用，已暂停', 'session-not-idle': '会话不再空闲，已暂停',
  reloaded: '窗口重新加载，需手动恢复', disposed: '控制器已停用', disabled: '插件已停用',
  'missing-goal': '目标已不存在', 'dispatch-failed': '派发失败，已暂停', 'store-write-failed': '状态写入失败，已暂停',
  'capability-failed': '报告凭据创建失败，已暂停', 'ownership-lost': '该会话归属已变化，已暂停',
  'run-ended-unknown': '运行结束状态未知，已暂停', cancelled: '运行被取消', refusal: '模型拒绝继续',
  permission: '等待权限确认', 'session-inactive': '会话已结束或不可用', disconnected: '连接已断开',
  interrupted: '运行被中断', suspended: '已挂起', accepted: '已由用户验收'
};
function statusText(goal) {
  const base = STATUS_LABELS[goal.status] || goal.status;
  if (goal.locked) return base + '（该会话由另一个窗口占用，本窗口不可操作）';
  const reason = goal.reason ? REASON_LABELS[goal.reason] || goal.reason : '';
  return reason ? base + ' · ' + reason : base;
}

function goalScript() {
  return `const vscode=acquireVsCodeApi();let state=null,errorText='',notice='',sessions=[],selectedSession='';
const STATUS_LABELS=${JSON.stringify(STATUS_LABELS)},REASON_LABELS=${JSON.stringify(REASON_LABELS)},SESSION_LABELS=${JSON.stringify(SESSION_LABELS)};
const el=id=>document.getElementById(id);
function statusText(goal){const base=STATUS_LABELS[goal.status]||goal.status;
if(goal.locked)return base+'（该会话由另一个窗口占用，本窗口不可操作）';
const reason=goal.reason?(REASON_LABELS[goal.reason]||goal.reason):'';return reason?base+' · '+reason:base;}
function option(value,label){const o=document.createElement('option');o.value=value;o.textContent=label;return o;}
function sessionLabel(id){const session=sessions.find(s=>s.sessionId===id);const label=session?.title||id;
return sessions.filter(s=>(s.title||s.sessionId)===label).length>1?label+' · '+id:label;}
function renderSessions(){const select=el('session');select.replaceChildren();
select.append(option('','请选择空闲会话'));
for(const s of sessions){const o=option(s.sessionId,sessionLabel(s.sessionId)+'（'+(SESSION_LABELS[s.status]||SESSION_LABELS.unknown)+'）');o.title=s.sessionId;if(s.status!=='idle')o.disabled=true;select.append(o);}
const usable=sessions.filter(s=>s.status==='idle');
if(sessions.some(s=>s.sessionId===selectedSession))select.value=selectedSession;
const chosen=sessions.find(s=>s.sessionId===select.value);
el('sessionHint').textContent=usable.length?'仅可对空闲会话启动；请手动选择。':'当前没有已观察为空闲的会话。';
el('start').disabled=!state.enabled||!state.trusted||!select.value||!chosen||chosen.status!=='idle';}
function render(){if(!state)return;el('enabled').textContent=state.enabled?'已启用':'已停用';
el('trusted').textContent=state.trusted?'工作区已信任':'工作区未信任';
el('storeError').textContent=state.storeError?('状态存储问题：'+state.storeError):'';
el('corrupt').textContent=state.corruptGoals?('发现 '+state.corruptGoals+' 条无法解析的目标记录，已保留未覆盖。'):'';
el('error').textContent=errorText;el('notice').textContent=notice;
sessions=state.sessions||[];renderSessions();
const list=el('goals');list.replaceChildren();
for(const goal of state.goals||[]){const item=document.createElement('div');item.className='goal';
const head=document.createElement('div');head.className='goalhead';head.textContent=statusText(goal)+' · '+sessionLabel(goal.sessionId);item.append(head);
const meta=document.createElement('div');meta.className='meta';meta.textContent='运行额度已使用 '+goal.runsStarted+' / '+goal.maxRuns+'（含派发准备，非模型回复数）· 修订 '+goal.revision+(goal.archived?' · 已归档':'');item.append(meta);
const objective=document.createElement('pre');objective.textContent='目标：'+goal.objective+'\\n验收标准：'+goal.criteria;item.append(objective);
const evidence=document.createElement('div');evidence.className='evidence';
if(!goal.evidence.length)evidence.textContent='尚无证据。';
for(const entry of goal.evidence){const line=document.createElement('pre');line.textContent='['+entry.status+'] '+entry.evidence;evidence.append(line);}
item.append(evidence);
const actions=document.createElement('div');actions.className='actions';
const act=(type,label,extra,needsConfirm)=>{const b=document.createElement('button');b.textContent=label;
b.disabled=!!goal.locked;b.onclick=()=>send(type,Object.assign({id:goal.id},extra||{}),needsConfirm);actions.append(b);};
if(!goal.locked){if(goal.status==='active')act('goal.pause','暂停');
else if(!goal.archived&&goal.status!=='completed')act('goal.resume','恢复',{},false);
if(goal.status==='review')act('goal.accept','验收完成',{},true);
if(!goal.archived)act('goal.archive','归档',{},goal.status==='active');}
item.append(actions);list.append(item);}
const history=el('history');history.replaceChildren();
for(const goal of state.history||[]){const line=document.createElement('pre');line.textContent='['+goal.status+'] '+sessionLabel(goal.sessionId)+' · 修订 '+goal.revision+'\\n'+goal.objective;history.append(line);}}
function send(type,payload,needsConfirm){const id=String(Math.random());errorText='';notice='';el('error').textContent='';el('notice').textContent='';
vscode.postMessage({type,id,payload,confirm:needsConfirm===true});}
window.addEventListener('message',event=>{const data=event.data;if(!data)return;
if(data.type==='goal-state'){state=data.state;render();return;}
if(data.type==='goal-result'){if(!data.ok){errorText=data.error||'操作失败。';}else{notice=data.notice||'';}render();}});
el('start').onclick=()=>{send('goal.start',{sessionId:el('session').value,objective:el('objective').value,criteria:el('criteria').value,maxRuns:Number(el('maxRuns').value)});};
el('refresh').onclick=()=>send('goal.refresh',{});
el('session').addEventListener('change',()=>{selectedSession=el('session').value;renderSessions();});
vscode.postMessage({type:'goal.ready',id:String(Math.random()),payload:{}});`;
}

function goalHtml(nonce) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;line-height:1.7}label{display:block;margin-top:12px}input,textarea,select{width:100%;box-sizing:border-box;padding:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent)}textarea{min-height:70px}.goal{border:1px solid var(--vscode-panel-border,#555);padding:12px;margin-top:12px}.goalhead{font-weight:600}.meta{opacity:.8}.actions{margin-top:8px;display:flex;gap:8px;flex-wrap:wrap}button{padding:5px 10px;cursor:pointer}.error{color:var(--vscode-errorForeground)}.notice{color:var(--vscode-descriptionForeground)}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:6px 0}.hint{opacity:.7}.evidence{border-left:2px solid var(--vscode-panel-border,#555);padding-left:8px;margin-top:6px}</style></head><body><h2>Fusion BYOK Goal</h2><p class="hint">一个会话同一时间只允许一个目标；只有人工验收才能把目标标记为已完成，“待验收”不等于“已完成”。自动运行次数按已派发的 Goal 提示计数。</p><p>插件：<span id="enabled">未知</span> · <span id="trusted">未知</span></p><p id="storeError" class="error" role="status"></p><p id="corrupt" class="error" role="status"></p><label for="session">会话（仅空闲可用）</label><select id="session"></select><p id="sessionHint" class="hint"></p><label for="objective">目标描述</label><textarea id="objective" maxlength="4000"></textarea><label for="criteria">验收标准（必填）</label><textarea id="criteria" maxlength="8000"></textarea><label for="maxRuns">运行上限（1-100，默认 10）</label><input id="maxRuns" type="number" min="1" max="100" value="10"><div class="actions"><button id="start">启动目标</button><button id="refresh">刷新</button></div><p id="error" class="error" role="status"></p><p id="notice" class="notice" role="status"></p><div id="goals"></div><h3>历史（已归档）</h3><div id="history"></div><script nonce="${nonce}">${goalScript()}</script></body></html>`;
}

function createGoalUi({ vscode, context, controller, isEnabled = () => true, isTrusted = () => true, safeError = () => ({ message: '操作失败。' }) }) {
  let panel, disposed = false;
  const item = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Right ?? 2, 18);
  function refreshStatusBar() {
    if (!item) return;
    let count = 0;
    try { count = (controller.snapshot().goals || []).filter(goal => !goal.archived).length; } catch {}
    item.text = '$(target) Goal' + (count ? ' ' + count : '');
    item.tooltip = 'Fusion BYOK Goal：一个会话一个目标，人工验收。';
    item.command = 'devinFusionByok.goal';
    item.show();
  }
  function state() {
    try { return controller.snapshot(); }
    catch { return { enabled: isEnabled(), trusted: isTrusted(), storeError: 'unavailable', corruptGoals: 0, sessions: [], goals: [], history: [] }; }
  }
  async function confirm(message) {
    if (typeof vscode.window.showWarningMessage !== 'function') return false;
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, '确认');
    return choice === '确认';
  }
  async function askRunLimit(goal) {
    if (typeof vscode.window.showInputBox !== 'function') return null;
    const answer = await vscode.window.showInputBox({
      title: '提高运行上限后恢复目标',
      prompt: '已派发 ' + goal.runsStarted + ' 次，请输入新的总运行上限（1-100，必须大于已派发次数）',
      value: String(Math.min(100, Math.max(goal.runsStarted + 1, goal.maxRuns))),
      validateInput: value => {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) return '请输入 1 到 100 的整数。';
        if (parsed <= goal.runsStarted) return '必须大于已派发的 ' + goal.runsStarted + ' 次。';
        return null;
      }
    });
    if (answer === undefined || answer === null || answer === '') return null;
    const parsed = Number(answer);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100 || parsed <= goal.runsStarted) return null;
    return parsed;
  }
  async function handleMessage(message) {
    if (!message || typeof message.type !== 'string' || typeof message.id !== 'string' || message.id.length > 100) return;
    const target = panel;
    if (!target) return;
    if (message.type === 'goal.ready' || message.type === 'goal.refresh') {
      await target.webview.postMessage({ type: 'goal-state', state: state() });
      return;
    }
    const payload = message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload) ? message.payload : {};
    let result;
    try {
      if (message.type === 'goal.start') result = controller.start(payload);
      else if (message.type === 'goal.pause') result = controller.pause(payload);
      else if (message.type === 'goal.resume') {
        const goal = (state().goals || []).find(item => item.id === payload.id);
        if (goal && goal.runsStarted >= goal.maxRuns) {
          const answer = await askRunLimit(goal);
          if (answer === null) return;
          payload.maxRuns = answer;
        }
        result = controller.resume(payload);
      } else if (message.type === 'goal.accept') {
        if (!(await confirm('确认把该目标标记为已完成？只有待验收状态且已有证据的目标可以验收。'))) return;
        result = controller.accept(payload);
      } else if (message.type === 'goal.archive') {
        const goal = (state().goals || []).find(item => item.id === payload.id);
        if (goal && goal.status === 'active' && !(await confirm('该目标仍在运行，确认归档并停止自动推进？'))) return;
        result = controller.archive(payload);
      } else return;
      await target.webview.postMessage({ type: 'goal-result', id: message.id, ok: true });
      await target.webview.postMessage({ type: 'goal-state', state: state() });
    } catch (error) {
      const text = error?.code ? error.message : safeError(error).message;
      await target.webview.postMessage({ type: 'goal-result', id: message.id, ok: false, error: text });
      try { await target.webview.postMessage({ type: 'goal-state', state: state() }); } catch {}
    }
    refreshStatusBar();
  }
  function open() {
    if (disposed) return;
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('devinFusionByok.goal', 'Fusion BYOK Goal', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    const current = panel;
    current.webview.html = goalHtml(crypto.randomBytes(24).toString('base64'));
    const listener = current.webview.onDidReceiveMessage(message => { void handleMessage(message); });
    const closing = current.onDidDispose(() => { listener.dispose(); closing.dispose(); if (panel === current) panel = undefined; });
  }
  const command = vscode.commands.registerCommand('devinFusionByok.goal', open);
  const timer = setInterval(() => {
    if (disposed || !panel) return;
    refreshStatusBar();
    try { void panel.webview.postMessage({ type: 'goal-state', state: state() }); } catch {}
  }, 3000);
  timer.unref?.();
  const handle = { dispose() { disposed = true; clearInterval(timer); command.dispose(); item?.dispose(); panel?.dispose(); }, refresh: refreshStatusBar };
  context.subscriptions.push(handle);
  refreshStatusBar();
  return handle;
}

module.exports = { createGoalUi, goalHtml, goalScript, statusText, STATUS_LABELS, SESSION_LABELS, REASON_LABELS };