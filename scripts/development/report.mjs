import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export function writeReport(report, output) {
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
  if (!output.endsWith('.html')) { writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 }); return }
  const end = report.run.finished ?? report.run.started + report.elapsedMs
  const duration = Math.max(1, end - report.run.started)
  const rows = report.spans.filter(s => s.kind !== 'task').map(s => {
    const left = Math.max(0, 100 * (s.started - report.run.started) / duration)
    const width = Math.max(.2, Math.min(100 - left, 100 * ((s.finished ?? end) - s.started) / duration))
    return `<div class="trace"><span>${escape(s.agent)} · ${escape(s.node || 'unassigned')} · ${escape(s.label)}</span><div class="track"><i class="${escape(s.status)}" style="left:${left}%;width:${width}%" title="${escape(s.status)}"></i></div><small>${s.finished === null ? '未结束' : `${((s.finished - s.started) / 1000).toFixed(2)} s`}</small></div>`
  }).join('')
  const table = report.coverage.map(c => `<tr><td>${escape(c.requirement)}</td><td>${escape(c.layer)}</td><td>${escape(c.status)}</td><td>${escape(c.evidence)}</td></tr>`).join('')
  const tasks = report.tasks.map(t => `<tr><td>${escape(t.node)}</td><td>${escape(t.state)}</td><td>${t.initialQueueMs === null ? '未就绪' : `${(t.initialQueueMs / 1000).toFixed(1)} s`}</td><td>${(t.blockedMs / 1000).toFixed(1)} s</td></tr>`).join('')
  writeFileSync(output, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Development profile</title>
<style>body{font:15px/1.6 system-ui,sans-serif;color:#243536;background:#f5f7f6;max-width:1150px;margin:32px auto;padding:0 20px}h1{font-size:25px}section{background:white;border:1px solid #dde5e1;border-radius:12px;padding:20px;margin:20px 0}.metrics{display:flex;gap:28px;flex-wrap:wrap}.metrics b{font-size:26px;display:block}.trace{display:grid;grid-template-columns:minmax(160px,30%) 1fr 70px;gap:12px;align-items:center;font-size:12px;margin:9px 0}.trace span{overflow-wrap:anywhere}.track{position:relative;height:18px;background:#f0f4f2}.track i{position:absolute;height:100%;background:#397468;border-radius:3px}.track .failed,.track .timed-out,.track .cancelled{background:#bd5148}.track .running{background:#ce9d39}table{width:100%;border-collapse:collapse}td,th{text-align:left;border-bottom:1px solid #eee;padding:9px;overflow-wrap:anywhere}small{color:#647572}details{margin:15px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){.trace{grid-template-columns:1fr}.track{height:12px}section{padding:12px}td{font-size:12px;padding:5px}}</style>
<h1>开发执行 profile</h1><p>${escape(report.run.id)} · ${escape(report.run.status)} · policy ${escape(report.run.policy)}</p>
<section class="metrics"><div>记录跨度（含中断等待）<b>${(report.elapsedMs / 1000).toFixed(1)} s</b></div><div>命令覆盖时长（重叠去重）<b>${(report.observedUnionMs / 1000).toFixed(1)} s</b></div><div>缺失行为证据<b>${report.coverage.filter(c => c.status === 'unknown').length}</b></div></section>
<p>记录跨度不是实际开发工时，命令覆盖时长只含完整起止记录；两者之差不能当作浪费或模型思考时间。并发、嵌套调用会重叠；累计耗时不能当成交付经过时间。分类由调用者填写，旧 verification 混有构建和 RSI，不能当作产品测试占比。缺失记录保持未知。</p>
<section><h2>执行时间线</h2>${rows || '<p>尚无调用记录。</p>'}</section>
<section><h2>任务等待</h2><table><tr><th>节点</th><th>状态</th><th>就绪到首次领取</th><th>已记录阻塞</th></tr>${tasks}</table></section>
<section><h2>用户行为与证据</h2><table><tr><th>要求</th><th>证据层</th><th>状态</th><th>依据</th></tr>${table}</table></section>
<section><h2>待验证的改进假设</h2>${report.issues.map(issue => `<details open><summary>${escape(issue.kind)}</summary><p>${escape(issue.hypothesis)}</p><pre>${escape(JSON.stringify(issue.evidence, null, 2))}</pre></details>`).join('') || '<p>当前规则未发现候选问题，不代表不存在缺陷。</p>'}</section></html>`, { mode: 0o600 })
}
