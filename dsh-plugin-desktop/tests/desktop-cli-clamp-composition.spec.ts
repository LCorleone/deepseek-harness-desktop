/**
 * Composition pinning of the locked CLI clamp (review guard-clamp P2-2).
 *
 * The clamp's shipped overlay (src/cli-lock/desktop-cli-lock.patch.yml) is
 * applied by desktop-cli.ts as a `--patch` layer, and the upstream CLI
 * composes it over the profile's on-disk bundle layers — for the shipped
 * desktop profile, the pinned `@deepseek-ai/dsh-base` +
 * `@deepseek-ai/dsh-web-app` pair. A loader patch that targets a row id the
 * bundles no longer carry only WARNS and is skipped (`applyEntryPatches`:
 * "a patch that matches nothing warns and is skipped"), so an upstream row
 * rename or deletion would silently turn the clamp into a no-op while every
 * existing unit test — which pins the overlay file's own shape — stayed
 * green. This spec closes that hole by composing the real layers with the
 * upstream's own primitives and pinning the five locked faces of the result.
 *
 * Composition inputs, each resolved the way the real consumer resolves it:
 *
 * - the two bundle patch layers come from the node_modules `@deepseek-ai`
 *   packages this workspace pins (yarn.lock, the same published versions the
 *   packaged CLI child composes from its own tree — the same-origin packages,
 *   read-only use, never a submodule edit), each located through its
 *   `dsh.bundle.patch` manifest field exactly like `loadProfile` does;
 * - the clamp overlay is parsed by `loadOverlayPatches` from the shipped
 *   file, not re-declared inline;
 * - the CLI's final roster pin (apps/cli `composeProfile`: after every
 *   `--patch` overlay it appends one more overlay overwriting `roots` on the
 *   upstream `agent-presets` row id with the shipped preset root) is
 *   re-enacted here with the same layer position and the dsh package's own
 *   `config/agent-presets` root, because `composeProfile` is module-private
 *   upstream. The telemetry switch (`resolveTelemetryPatch`) is omitted: it
 *   targets `session-telemetry-otel`, a row none of the five faces touch.
 *
 * The hostile-environment frame: `DSH_PERMISSION_MODE=danger-full-access` is
 * set for the whole test, and the base rows' own `!!js` expressions are
 * evaluated with the loader's evaluator to show they arm under it — the
 * exact leak the clamp's literal restatements must disarm.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { evaluate, isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { COMPANY_PRESET_ID } from '../src/company-agent-presets.ts'
import {
  DESKTOP_CLI_CLAMP_ENVIRONMENT,
  desktopCliCompanyPresetRoot,
  desktopCliLockOverlayPath,
} from '../src/desktop-cli.ts'
import { lockedPermissionConfig } from '../src/profile.ts'

const require = createRequire(import.meta.url)

/** Resolve one pinned bundle's patch file through its dsh.bundle manifest, like loadProfile. */
function bundlePatchPath(packageName: string): string {
  const packageJsonPath = require.resolve(`${packageName}/package.json`)
  const declared = (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    dsh?: { bundle?: { patch?: unknown } }
  }).dsh?.bundle?.patch
  if (typeof declared !== 'string') {
    throw new Error(`test fixture: bundle ${packageName} declares no dsh.bundle.patch`)
  }
  return join(dirname(packageJsonPath), declared)
}

/** The dsh installation's shipped preset root, the same directory the CLI's final pin writes. */
function shippedPresetRoot(): string {
  return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'config', 'agent-presets')
}

/** Compose layers with the upstream primitive while collecting every skip warning. */
function compose(layers: PatchOptions[][]): { rows: EntryOptions[], warnings: string[] } {
  const warnings: string[] = []
  const rows = composeEntries(layers, message => { warnings.push(message) })
  return { rows, warnings }
}

/** Composed row index by id, mirroring composeProfile's own launcher index. */
function rowIndex(rows: readonly EntryOptions[]): Map<string, EntryOptions> {
  return new Map(rows.filter(row => typeof row.id === 'string').map(row => [row.id as string, row]))
}

describe('locked CLI clamp composition', () => {
  it('holds all five locked faces under a hostile inherited mode override', () => {
    const previousMode = process.env.DSH_PERMISSION_MODE
    const previousPresetRoot = process.env[DESKTOP_CLI_CLAMP_ENVIRONMENT.presetRoot]
    process.env.DSH_PERMISSION_MODE = 'danger-full-access'
    try {
      const basePatches = loadOverlayPatches('dsh-desktop-clamp-pin', bundlePatchPath('@deepseek-ai/dsh-base'))
      const webAppPatches = loadOverlayPatches('dsh-desktop-clamp-pin', bundlePatchPath('@deepseek-ai/dsh-web-app'))
      const clampPatches = loadOverlayPatches('dsh-desktop-clamp-pin', desktopCliLockOverlayPath())

      // Threat baseline: without the clamp, the base rows' own expressions
      // arm under this environment — the leak this composition must close.
      const unclamped = compose([basePatches, webAppPatches])
      expect(unclamped.warnings).toEqual([])
      const unclampedById = rowIndex(unclamped.rows)
      const baseMode = unclampedById.get('sandbox-policy')?.config?.mode
      const basePolicy = unclampedById.get('approval')?.config?.policy
      expect(isJsExpr(baseMode)).toBe(true)
      expect(isJsExpr(basePolicy)).toBe(true)
      expect(evaluate({ process }, (baseMode as { __jsExpr: string }).__jsExpr)).toBe('danger-full-access')
      expect(evaluate({ process }, (basePolicy as { __jsExpr: string }).__jsExpr)).toBe('never')

      // The clamped stack, in the CLI's real layer order: bundles, then the
      // --patch clamp overlay, then the re-enacted final roster pin.
      const clampedBeforePin = compose([basePatches, webAppPatches, clampPatches])
      expect(clampedBeforePin.warnings).toEqual([])
      const overlays: PatchOptions[] = [...clampPatches]
      const pinnedRoster = rowIndex(clampedBeforePin.rows).get('agent-presets')
      if (pinnedRoster !== undefined) {
        overlays.push({
          id: 'agent-presets',
          config: {
            ...(pinnedRoster.config as Record<string, unknown>),
            roots: [{ path: shippedPresetRoot(), trust: 'system' }],
          },
        })
      }
      const clamped = compose([basePatches, webAppPatches, overlays])
      // The drift tripwire: a renamed or deleted upstream row id turns a
      // clamp patch into a warn-and-skip no-op; any warning fails here, and
      // the face assertions below fail on the rows that never got restated.
      expect(clamped.warnings).toEqual([])
      const byId = rowIndex(clamped.rows)

      // Faces 1–2, sandbox and approval: the literals the locked GUI runs,
      // replacing the expressions that just armed above. `toEqual` pins the
      // whole config object, so no surviving expression reads the override.
      expect(byId.get('sandbox-policy')?.name).toBe('@deepseek-ai/dsh-sandbox-policy')
      expect(byId.get('sandbox-policy')?.config).toEqual({
        mode: 'workspace-write',
        workspaceRoot: { __jsExpr: 'process.cwd()' },
      })
      expect(byId.get('approval')?.name).toBe('@deepseek-ai/dsh-user-approval')
      expect(byId.get('approval')?.config).toEqual({ policy: 'ask' })

      // Face 3, permission table: exactly what lockedPermissionConfig derives
      // from the same upstream base row the CLI child composes — no
      // danger-full-access entry anywhere in the composed table.
      const basePermissionConfig = unclampedById.get('permission')?.config as Record<string, unknown>
      expect(byId.get('permission')?.name).toBe('@deepseek-ai/dsh-permission-presets')
      expect(byId.get('permission')?.config).toEqual(lockedPermissionConfig(basePermissionConfig))
      expect((byId.get('permission')?.config as { presets?: Record<string, unknown> }).presets)
        .not.toHaveProperty('danger-full-access')

      // Face 4, upstream roster: disabled, and the CLI's final roots pin
      // still lands on the disabled row without resurrecting it — the pin
      // swaps config, never the disabled flag.
      const roster = byId.get('agent-presets')
      expect(roster?.name).toBe('@deepseek-ai/dsh-agent-presets')
      expect(roster?.disabled).toBe(true)
      expect(roster?.config).toEqual({
        default: 'standard',
        roots: [{ path: shippedPresetRoot(), trust: 'system' }],
      })

      // Face 5, company roster: the inserted row carries the GUI's default
      // preset id and a single system-trust root whose path is the launcher's
      // process-local injection variable — and that variable resolves to the
      // packaged company preset root the locked GUI composes.
      const companyRow = byId.get('desktop-company-agent-presets')
      expect(companyRow?.name).toBe('dsh-plugin-desktop/company-agent-presets')
      expect(companyRow?.disabled).toBeUndefined()
      const companyConfig = companyRow?.config as {
        default: string
        roots: { path: { __jsExpr: string }, trust: string }[]
      }
      expect(companyConfig.default).toBe(COMPANY_PRESET_ID)
      expect(companyConfig.roots).toEqual([
        {
          path: { __jsExpr: `process.env.${DESKTOP_CLI_CLAMP_ENVIRONMENT.presetRoot}` },
          trust: 'system',
        },
      ])
      process.env[DESKTOP_CLI_CLAMP_ENVIRONMENT.presetRoot] = desktopCliCompanyPresetRoot()
      const companyRootExpression = companyConfig.roots[0]?.path.__jsExpr
      expect(companyRootExpression).toBe(`process.env.${DESKTOP_CLI_CLAMP_ENVIRONMENT.presetRoot}`)
      expect(evaluate({ process }, companyRootExpression!)).toBe(desktopCliCompanyPresetRoot())
    } finally {
      if (previousMode === undefined) delete process.env.DSH_PERMISSION_MODE
      else process.env.DSH_PERMISSION_MODE = previousMode
      if (previousPresetRoot === undefined) delete process.env[DESKTOP_CLI_CLAMP_ENVIRONMENT.presetRoot]
      else process.env[DESKTOP_CLI_CLAMP_ENVIRONMENT.presetRoot] = previousPresetRoot
    }
  })
})
