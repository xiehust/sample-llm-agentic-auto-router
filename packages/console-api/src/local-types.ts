// Small aliases over @auto-router/console-contract used by console-api. The contract (18) now carries every shape
// 73 proposed (config document per design §2.1, redeliver, delivery-failed, ValidationIssue.rule, audit actions,
// admin.session ?caller=).
import type { ConfigDocument, ConfigVersionMeta, ErrorCode, ValidationIssue } from '@auto-router/console-contract'

export type { ConfigDocument }
export const CONFIG_SECTIONS = ['policy', 'assessor', 'identity', 'access'] as const
export interface StoredVersion { meta: ConfigVersionMeta; document: ConfigDocument }
export type Issue = ValidationIssue
export type ApiErrorCode = ErrorCode
export type { Delivery } from '@auto-router/console-contract'
