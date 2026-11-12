/** Browser-safe Remote contract mounted once by the primary client provider. */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { HAPI_REMOTE } from '../client-api.ts'
import { HHPI_REMOTE } from '../hhpi-api.ts'
import { SOURCE_WORKSPACE_REMOTE } from '../workspace/source-api.ts'
import { SOURCE_TERMINAL_REMOTE } from '../workspace/terminal-api.ts'
import { SOURCE_NAVIGATION_REMOTE } from '../workspace/source-navigation-api.ts'
import { APP_SERVICES_REMOTE } from '../workspace/app-api.ts'
import { SOURCE_ALIAS_REMOTE } from '../workspace/source-alias-api.ts'

/** Both namespaces belong to this package and must be registered atomically. */
export const HAPI_DSH_REMOTE: TypertRemoteContribution = {
  package: 'hapi-dsh',
  descriptors: [...HAPI_REMOTE.descriptors, ...HHPI_REMOTE.descriptors, ...SOURCE_WORKSPACE_REMOTE.descriptors, ...SOURCE_TERMINAL_REMOTE.descriptors,
    ...SOURCE_NAVIGATION_REMOTE.descriptors, ...APP_SERVICES_REMOTE.descriptors, ...SOURCE_ALIAS_REMOTE.descriptors],
}
