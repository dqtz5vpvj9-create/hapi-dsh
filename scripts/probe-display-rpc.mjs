/** CDP Fetch.requestPaused supplies a string field, unlike Playwright's accessor. */
export function parseCdpRpcBody(request) {
  if (typeof request?.postData !== 'string') return undefined;
  try { return JSON.parse(request.postData); } catch { return undefined; }
}

/** Only the exact source's display resolver and lease lifecycle may write. */
export function allowedDisplayRpc(path, body, expectedHub, expectedSource) {
  const method = path.replace(/^\/api\/hapi\//, '');
  const request = body?.payload?.args?.request ?? body?.payload?.request ?? body?.request ?? body;
  if (!request || typeof request !== 'object' || request.hubId !== expectedHub
    || request.sourceSessionId !== expectedSource) return false;
  if (method === 'sourceSessionResolve')
    return Object.keys(request).every(key => key === 'hubId' || key === 'sourceSessionId');
  if (method === 'sourceDisplayLease')
    return ['acquire', 'renew', 'release'].includes(request.action)
      && Object.keys(request).every(key => ['hubId', 'sourceSessionId', 'leaseId', 'action', 'ttlMs'].includes(key));
  return false;
}
