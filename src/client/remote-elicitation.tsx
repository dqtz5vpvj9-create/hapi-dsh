/** Native MCP elicitation forms use the source's schema and return typed field values. */
import type { SourceApproval } from '../remote/protocol.ts'
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function choices(schema: Record<string, unknown>): Array<{ value: string; title: string }> {
  if (Array.isArray(schema.enum)) return schema.enum.filter((value): value is string => typeof value === 'string').map((value, index) => ({ value, title: Array.isArray(schema.enumNames) ? String(schema.enumNames[index] ?? value) : value }))
  const rows = schema.oneOf ?? schema.anyOf
  return Array.isArray(rows) ? rows.flatMap(row => record(row) && typeof row.const === 'string' ? [{ value: row.const, title: typeof row.title === 'string' ? row.title : row.const }] : []) : []
}
export function NativeElicitation({ request, disabled, zh, submit }: { request: SourceApproval; disabled: boolean; zh: boolean; submit(response: Record<string, unknown>): Promise<void> }) {
  const params = request.params, schema = record(params.requestedSchema) ? params.requestedSchema : null
  const properties = schema && record(schema.properties) ? schema.properties : {}
  const fields = Object.entries(properties).filter((entry): entry is [string, Record<string, unknown>] => record(entry[1]))
  const supported = schema?.type === 'object' && fields.length === Object.keys(properties).length && fields.every(([, field]) => ['string', 'boolean', 'integer', 'number'].includes(String(field.type)) || field.type === 'array' && record(field.items) && choices(field.items).length > 0)
  let url: string | undefined
  try { const parsed = new URL(String(params.url)); if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.href } catch { /* No valid external link. */ }
  const urlMode = params.mode === 'url' && !!url
  return <form onSubmit={event => {
    event.preventDefault()
    const data = new FormData(event.currentTarget), content: Record<string, unknown> = {}
    for (const [name, field] of fields) {
      if (field.type === 'boolean') content[name] = data.get(name) === 'on'
      else if (field.type === 'array') content[name] = data.getAll(name)
      else if (data.has(name) && data.get(name) !== '') content[name] = field.type === 'number' || field.type === 'integer' ? Number(data.get(name)) : data.get(name)
    }
    void submit({ action: 'accept', ...(urlMode ? {} : { content }) })
  }}>
    <p>{String(params.message ?? params.description ?? '')}</p>
    {urlMode && <a href={url} target="_blank" rel="noopener noreferrer">{zh ? '打开服务验证页面' : 'Open service verification page'}</a>}
    {supported && fields.map(([name, field]) => {
      const required = Array.isArray(schema?.required) && schema.required.includes(name), options = choices(field)
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
    {!supported && !urlMode && <p>{zh ? '此表单需要服务专用的原生界面。' : 'This form requires the service’s native interface.'}</p>}
    <button type="submit" disabled={disabled || !supported && !urlMode}>{zh ? '确认' : 'Confirm'}</button>
    <button type="button" disabled={disabled} onClick={() => { void submit({ action: 'decline' }) }}>{zh ? '拒绝' : 'Decline'}</button>
    <button type="button" disabled={disabled} onClick={() => { void submit({ action: 'cancel' }) }}>{zh ? '取消' : 'Cancel'}</button>
  </form>
}
