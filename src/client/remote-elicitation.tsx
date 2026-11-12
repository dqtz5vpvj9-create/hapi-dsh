/** Native MCP forms submit typed values; unsupported schemas and device proof never become generic approvals. */
import { useState } from 'react'
import type { SourceApproval } from '../remote/protocol.ts'
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function choices(schema: Record<string, unknown>): Array<{ value: string; title: string }> {
  if (Array.isArray(schema.enum)) return schema.enum.filter((value): value is string => typeof value === 'string').map((value, index) => ({ value, title: Array.isArray(schema.enumNames) ? String(schema.enumNames[index] ?? value) : value }))
  const rows = schema.oneOf ?? schema.anyOf
  return Array.isArray(rows) ? rows.flatMap(row => record(row) && typeof row.const === 'string' ? [{ value: row.const, title: typeof row.title === 'string' ? row.title : row.const }] : []) : []
}
const fieldKeys = new Set(['type', 'title', 'description', 'default', 'enum', 'enumNames', 'oneOf', 'anyOf', 'format', 'minLength', 'maxLength', 'minimum', 'maximum', 'items', 'minItems', 'maxItems'])
function supportedField(field: Record<string, unknown>): boolean {
  if (Object.keys(field).some(key => !fieldKeys.has(key))) return false
  if (field.type === 'array') return record(field.items) && choices(field.items).length > 0
  if (!['string', 'boolean', 'integer', 'number'].includes(String(field.type))) return false
  if (field.enum !== undefined || field.oneOf !== undefined || field.anyOf !== undefined) return field.type === 'string' && choices(field).length > 0
  return field.format === undefined || field.format === null || ['email', 'uri', 'date', 'date-time'].includes(String(field.format))
}
export function NativeElicitation({ request, disabled, zh, submit }: { request: SourceApproval; disabled: boolean; zh: boolean; submit(response: Record<string, unknown>): Promise<void> }) {
  const [error, setError] = useState('')
  const params = request.params, schema = record(params.requestedSchema) ? params.requestedSchema : null
  const properties = schema && record(schema.properties) ? schema.properties : {}
  const fields = Object.entries(properties).filter((entry): entry is [string, Record<string, unknown>] => record(entry[1]))
  const requiredNames = Array.isArray(schema?.required) ? schema.required : []
  const supported = ['form', 'openai/form', 'openaiForm'].includes(String(params.mode)) && schema?.type === 'object'
    && Object.keys(schema).every(key => ['type', 'properties', 'required', '$schema', 'additionalProperties'].includes(key))
    && requiredNames.every(name => typeof name === 'string' && name in properties) && fields.length === Object.keys(properties).length && fields.every(([, field]) => supportedField(field))
  let url: string | undefined
  try { const parsed = new URL(String(params.url)); if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.href } catch { /* No valid external link. */ }
  const urlMode = params.mode === 'url' && !!url
  return <form onSubmit={event => {
    event.preventDefault(); event.stopPropagation(); setError('')
    if (disabled || !supported && !urlMode) return
    if (!event.currentTarget.checkValidity()) { event.currentTarget.reportValidity(); return }
    const data = new FormData(event.currentTarget), content: Record<string, unknown> = {}
    for (const [name, field] of fields) {
      if (field.type === 'boolean') content[name] = data.get(name) === 'on'
      else if (field.type === 'array') {
        const values = data.getAll(name)
        if (typeof field.minItems === 'number' && values.length < field.minItems || typeof field.maxItems === 'number' && values.length > field.maxItems) { setError(zh ? '请选择符合数量限制的选项。' : 'Select the number of options requested by this service.'); return }
        content[name] = values
      } else if (data.has(name) && data.get(name) !== '') {
        const value = String(data.get(name))
        if (field.type === 'number' || field.type === 'integer') {
          const number = Number(value)
          if (!Number.isFinite(number) || field.type === 'integer' && !Number.isInteger(number)) { setError(zh ? '请输入有效数字。' : 'Enter a valid number.'); return }
          content[name] = number
        } else {
          if (field.format === 'date-time' && (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value)))) { setError(zh ? '请输入带时区的完整日期和时间。' : 'Enter a complete date and time with a timezone.'); return }
          content[name] = value
        }
      }
    }
    void submit({ action: 'accept', ...(urlMode ? {} : { content }) })
  }}>
    {typeof params.serverName === 'string' && <p>{zh ? '服务：' : 'Service: '}{params.serverName}</p>}
    <p>{String(params.message ?? params.description ?? '')}</p>
    {urlMode && <a href={url} target="_blank" rel="noopener noreferrer">{zh ? '打开服务验证页面' : 'Open service verification page'}</a>}
    {supported && fields.map(([name, field]) => {
      const required = requiredNames.includes(name), options = choices(field)
      return <label key={name} style={{ display: 'block' }}>{String(field.title ?? name)}
        {field.type === 'boolean' ? <input name={name} type="checkbox" defaultChecked={field.default === true} disabled={disabled}/>
          : field.type === 'array' && record(field.items) ? <select name={name} multiple required={required} disabled={disabled} defaultValue={Array.isArray(field.default) ? field.default.map(String) : []}>{choices(field.items).map(option => <option key={option.value} value={option.value}>{option.title}</option>)}</select>
          : options.length ? <select name={name} required={required} disabled={disabled} defaultValue={typeof field.default === 'string' ? field.default : ''}><option value="">—</option>{options.map(option => <option key={option.value} value={option.value}>{option.title}</option>)}</select>
          : <input name={name} disabled={disabled} required={required} defaultValue={typeof field.default === 'string' || typeof field.default === 'number' ? field.default : ''}
            type={field.type === 'integer' || field.type === 'number' ? 'number' : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : field.format === 'date' ? 'date' : 'text'}
            step={field.type === 'integer' ? 1 : 'any'} min={typeof field.minimum === 'number' ? field.minimum : undefined} max={typeof field.maximum === 'number' ? field.maximum : undefined}
            minLength={typeof field.minLength === 'number' ? field.minLength : undefined} maxLength={typeof field.maxLength === 'number' ? field.maxLength : undefined}/>
        }{typeof field.description === 'string' && <small>{field.description}</small>}
      </label>
    })}
    {!supported && !urlMode && <p>{params.mode === 'openai/userVerification' ? zh ? '此请求需要可信原生界面生成设备验证证明。' : 'This request needs a trusted native interface to produce device verification proof.' : zh ? '此表单需要服务专用的原生界面。' : 'This form requires the service’s native interface.'}</p>}
    {error && <p role="alert">{error}</p>}
    <button type="submit" disabled={disabled || !supported && !urlMode}>{urlMode ? zh ? '我已完成服务验证' : 'I completed service verification' : zh ? '确认' : 'Confirm'}</button>
    <button type="button" disabled={disabled} onClick={() => { void submit({ action: 'decline' }) }}>{zh ? '拒绝' : 'Decline'}</button>
    <button type="button" disabled={disabled} onClick={() => { void submit({ action: 'cancel' }) }}>{zh ? '取消' : 'Cancel'}</button>
  </form>
}
