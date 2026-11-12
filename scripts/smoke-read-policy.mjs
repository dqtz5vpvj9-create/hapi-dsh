/** Read-only browser acceptance boundary for native DSH and HHPI. */
import { sourcePositionRequest } from '../src/workspace/source-navigation-api.ts';
import runnerRemote from '@deepseek-ai/dsh-cordis-host-runner/remote';
const readMethods = new Set([
  'hhpi/catalog', 'hhpi/resolve', 'hhpi/read', 'hhpi/resource',
  'sourceAliases/resolve', 'sourceNavigation/resumeContext', 'sourceNavigation/locatePosition', 'hapi/catalog', 'hapi/workspaceGet',
  'session/list', 'session/projections', 'session/modelCatalog', 'session/page', 'session/attachment',
  'session/search', 'session/canOpenWorkspacePath', 'session/workspacePathApplications',
  'skills/list', 'fileReferences/list', 'account/list', 'account/get', 'remotes/list',
  'agentPresets/list', 'pluginManager/list', 'permissionPresets/list',
  'account/getState', 'account/getProfile', 'account/getBalance', 'account/getUnnotifiedBonuses',
  'account/hasRunningAccountTasks',
  'settings/describe', 'permissionPresets/catalog',
  'pluginManager/listPlugins', 'pluginManager/listBundles', 'pluginManager/listVersionExemptions',
  'pluginManager/registries', 'agentPresets/read', 'commands/list',
  'llm/listProviders', 'llm/listConfigurableProviders',
  'credentials/describe', 'dynamicCordisRunner/inventory', 'cotTranslation/limits',
]);
export const readStreams = new Set(['$events', 'session/follow', 'hhpi/changes',
  'remoteAccess/follow', 'account/watch', 'account/watchExpiry', 'session/control', 'workspace/follow']);
const manifestInput = runnerRemote.methods['dynamicCordisRunner/syncInspectManifest'].input({ strict: true }).create();
/** Only explicit reads may reach the Host; browser housekeeping remains isolated. */
export function requestPolicy(method, body) {
  if (method === 'sourceNavigation/locatePosition') return sourcePositionRequest.safeParse(body?.payload?.args?.request).success ? 'read' : 'block';
  if (method === 'hapi/workspacePut') return 'isolate-workspace';
  if (method === 'dynamicCordisRunner/syncInspectManifest'
    && manifestInput.safeParse(body?.payload?.args).success) return 'isolate-inspect-manifest';
  if (readMethods.has(method)) return 'read';
  return 'block';
}
export function streamPolicy(path, message) {
  if (path.endsWith('/hapi-dsh/notifications') && message?.type === 'presence'
    && ['visible', 'hidden'].includes(message.visibility)
    && Object.keys(message).length === 2) return 'isolate-presence';
  if (!path.endsWith('/remote.mux')) return 'block';
  if (message?.type === 'open' && readStreams.has(message.endpoint)) return 'read';
  if (['cancel', 'end'].includes(message?.type) && typeof message.streamId === 'string'
    && Object.keys(message).length === 2) return 'read';
  return 'block';
}
