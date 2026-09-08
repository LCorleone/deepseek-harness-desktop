/** Locked-build agent preset roster pinned to the company-managed Deloitte preset. */

import AgentPresets, {
  type AgentPreset,
} from '@deepseek-ai/dsh-agent-presets'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** The one preset a locked company build ships: the upstream standard composition with a company persona. */
export const COMPANY_PRESET_ID = 'deloitte-standard'

/**
 * Upstream preset ids a locked build no longer ships. Sessions and settings
 * recorded them before the company roster switch; every one resolves to the
 * company preset, whose composition is a full copy of `standard` and therefore
 * compatible with sessions authored on any of them.
 */
export const COMPANY_RETIRED_PRESET_IDS = ['standard', 'ptc', 'cordis', 'minimal'] as const

/** Whether one preset id belongs to the retired upstream roster. */
export function isCompanyRetiredPresetId(id: string): boolean {
  return (COMPANY_RETIRED_PRESET_IDS as readonly string[]).includes(id)
}

/**
 * Agent-preset roster of a locked company build: discovery sees only the
 * company preset (plus anything a person authored in their own user root),
 * while ids recorded by pre-migration sessions fall back to it instead of
 * failing. The subclass pattern mirrors WindowsAgentPresets
 * (src/windows-agent-presets.ts); it takes the agent-presets row on every
 * platform, because the locked roots already exclude every upstream preset —
 * including the Windows-unsupported `minimal`.
 */
export class CompanyAgentPresets extends AgentPresets {
  override get defaultId(): string {
    const id = super.defaultId
    return isCompanyRetiredPresetId(id) ? COMPANY_PRESET_ID : id
  }

  override async resolve(id?: string): Promise<AgentPreset> {
    return await super.resolve(
      id !== undefined && isCompanyRetiredPresetId(id) ? COMPANY_PRESET_ID : id,
    )
  }

  override async copy(from: string, id: string, name?: string): Promise<void> {
    if (isCompanyRetiredPresetId(id)) throw presetExistsError(id)
    await super.copy(from, id, name)
  }
}

/** Stable `agent-preset/invalid` rejection mirroring upstream `copy()` refusals. */
function presetExistsError(id: string): RemoteError {
  const reason = `preset "${id}" already exists — a copy never overwrites; delete the existing preset first or choose another id`
  return new RemoteError('agent-preset/invalid', `agent-presets: ${reason}`, {
    agentPreset: id,
    reason,
  })
}

export default CompanyAgentPresets
