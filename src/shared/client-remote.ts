/** Browser-safe Remote contract mounted once by the primary client provider. */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { HAPI_REMOTE } from '../client-api.ts'
import { HHPI_REMOTE } from '../hhpi-api.ts'

/** Both namespaces belong to this package and must be registered atomically. */
export const HAPI_DSH_REMOTE: TypertRemoteContribution = {
  package: 'hapi-dsh',
  descriptors: [...HAPI_REMOTE.descriptors, ...HHPI_REMOTE.descriptors],
}
