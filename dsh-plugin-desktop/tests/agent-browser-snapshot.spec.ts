/**
 * Snapshot builder over fixture `getDocument` payloads: tree projection,
 * truncation, password masking, and the build-time budget (B1 acceptance,
 * design §3 — the walk shares the main-process event loop).
 */

import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { AgentBrowserCdpNode } from '../src/agent-browser-cdp.ts'
import {
  AGENT_BROWSER_SNAPSHOT_NODE_BUDGET,
  AGENT_BROWSER_SNAPSHOT_TRUNCATION_MARKER,
  agentBrowserNodeAttributes,
  agentBrowserRef,
  buildAgentBrowserSnapshotTree,
  isSensitiveInputNode,
} from '../src/agent-browser-session.ts'

function node(overrides: Partial<AgentBrowserCdpNode> & { nodeId: number }): AgentBrowserCdpNode {
  return { nodeType: 1, nodeName: overrides.localName?.toUpperCase() ?? 'DIV', children: [], ...overrides }
}

/** Fixture page carrying the sensitive-input shapes the walker must mask. */
function loginDocument(): AgentBrowserCdpNode {
  return node({
    nodeId: 1,
    nodeType: 9,
    nodeName: '#document',
    children: [
      node({ nodeId: 2, localName: 'html', children: [
        node({ nodeId: 3, localName: 'body', children: [
          node({ nodeId: 4, localName: 'h1', backendNodeId: 100, children: [
            node({ nodeId: 5, nodeType: 3, nodeName: '#text', nodeValue: '  Company   sign-in  ' }),
          ] }),
          node({
            nodeId: 6,
            localName: 'input',
            backendNodeId: 101,
            attributes: ['type', 'password', 'value', 'hunter2', 'autocomplete', 'current-password'],
          }),
          node({
            nodeId: 7,
            localName: 'input',
            backendNodeId: 102,
            attributes: ['type', 'text', 'value', 'alice@example.test', 'autocomplete', 'username'],
          }),
          node({
            nodeId: 8,
            localName: 'input',
            backendNodeId: 103,
            attributes: ['type', 'text', 'autocomplete', 'one-time-code', 'value', '123456'],
          }),
          node({
            nodeId: 9,
            localName: 'input',
            backendNodeId: 104,
            attributes: ['type', 'text', 'autocomplete', 'cc-number', 'value', '4242424242424242'],
          }),
          node({
            nodeId: 10,
            localName: 'input',
            backendNodeId: 105,
            attributes: ['type', 'TEXT', 'autocomplete', 'NEW-PASSWORD', 'value', 'next-secret'],
          }),
          node({
            nodeId: 14,
            localName: 'input',
            backendNodeId: 110,
            // Multi-token autocomplete (B1 review P2): the sensitive section
            // token rides alongside an autofill detail token.
            attributes: ['type', 'tel', 'autocomplete', 'tel current-password', 'value', 'p@ss'],
          }),
          node({
            nodeId: 15,
            localName: 'input',
            backendNodeId: 111,
            // Secret-shaped name with a plain-text type and no autocomplete.
            attributes: ['type', 'text', 'name', 'user_password', 'value', 'name-leak'],
          }),
          node({
            nodeId: 16,
            localName: 'input',
            backendNodeId: 112,
            // Secret-shaped id under the pwd abbreviation.
            attributes: ['type', 'text', 'id', 'login-passwd', 'value', 'id-leak'],
          }),
          node({
            nodeId: 17,
            localName: 'input',
            backendNodeId: 113,
            // Hidden CSRF token (B1 review P3): never enters the context.
            attributes: ['type', 'hidden', 'name', 'csrf', 'value', 'csrf-secret-token-123'],
          }),
          node({ nodeId: 18, localName: 'input', backendNodeId: 114, attributes: [
            'type', 'hidden', 'name', 'session', 'value', 'sess-xyz',
          ] }),
          node({ nodeId: 11, localName: 'button', backendNodeId: 106, children: [
            node({ nodeId: 12, nodeType: 3, nodeName: '#text', nodeValue: 'Sign in' }),
          ] }),
          node({ nodeId: 13, localName: 'a', backendNodeId: 107, attributes: ['href', 'https://help.example.test/reset?next=/'] }),
        ] }),
      ] }),
    ],
  })
}

describe('agent-browser snapshot builder', () => {
  it('projects tags, base36 refs, roles, text, and links', () => {
    const result = buildAgentBrowserSnapshotTree(loginDocument())

    expect(result.truncated).toBe(false)
    expect(result.tree).toContain('h1 #e2s')
    expect(result.tree).toContain('Company sign-in')
    expect(result.tree).toContain('button #e2y role=button')
    expect(result.tree).toContain('Sign in')
    // Case-normalized tag with the ref rendered from the backendNodeId.
    expect(result.tree).toMatch(/a #e2z role=link href="https:\/\/help\.example\.test\/reset\?next=\/"/u)
  })

  it('renders refs in the e<base36> form', () => {
    expect(agentBrowserRef(100)).toBe('e2s')
    expect(agentBrowserRef(123456789)).toBe('e21i3v9')
  })

  it('never projects a value for password or sensitive-autocomplete inputs', () => {
    const result = buildAgentBrowserSnapshotTree(loginDocument())
    const tree = result.tree

    expect(tree).toContain('input #e2t type="password"')
    expect(tree).toContain('[password field: value hidden]')
    expect(tree).toContain('input #e2u type="text" value="alice@example.test"')
    expect(tree).not.toContain('hunter2')
    expect(tree).not.toContain('123456')
    expect(tree).not.toContain('4242424242424242')
    expect(tree).not.toContain('next-secret')

    // The classifier itself is exercised on the exact sensitive shapes.
    expect(isSensitiveInputNode(node({ nodeId: 1, localName: 'input', attributes: ['type', 'password'] }))).toBe(true)
    expect(isSensitiveInputNode(node({ nodeId: 1, localName: 'input', attributes: ['autocomplete', 'cc-csc'] }))).toBe(true)
    expect(isSensitiveInputNode(node({ nodeId: 1, localName: 'input', attributes: ['autocomplete', 'email'] }))).toBe(false)
    expect(isSensitiveInputNode(node({ nodeId: 1, localName: 'input', attributes: ['type', 'text'] }))).toBe(false)

    // B1 review P2 heuristics: secret-shaped name/id substrings and
    // multi-token autocomplete values.
    expect(tree).not.toContain('name-leak')
    expect(tree).not.toContain('id-leak')
    expect(tree).not.toContain('p@ss')
    expect(tree).toContain('input #e33 name="user_password" type="text" [password field: value hidden]')
    expect(isSensitiveInputNode(node({ nodeId: 1, localName: 'input', attributes: ['type', 'text', 'name', 'x-passwd-y'] }))).toBe(true)
    expect(isSensitiveInputNode(node({ nodeId: 1, localName: 'input', attributes: ['type', 'text', 'id', 'PWD'] }))).toBe(true)
    expect(isSensitiveInputNode(node({ nodeId: 1, localName: 'input', attributes: ['type', 'text', 'name', 'uploads'] }))).toBe(false)
    expect(isSensitiveInputNode(node({ nodeId: 1, localName: 'input', attributes: ['type', 'tel', 'autocomplete', 'tel current-password'] }))).toBe(true)
    expect(isSensitiveInputNode(node({ nodeId: 1, localName: 'input', attributes: ['type', 'text', 'autocomplete', 'one-time-code tel'] }))).toBe(true)
    expect(isSensitiveInputNode(node({ nodeId: 1, localName: 'input', attributes: ['type', 'tel', 'autocomplete', 'tel national'] }))).toBe(false)

    // Hidden inputs (B1 review P3): the CSRF/session token values never
    // enter the model context; the declared type stays observable.
    expect(tree).toContain('input #e35 name="csrf" type="hidden"')
    expect(tree).not.toContain('csrf-secret-token-123')
    expect(tree).not.toContain('sess-xyz')
  })

  it('flattens flat attribute pairs for lookup', () => {
    expect(agentBrowserNodeAttributes(node({
      nodeId: 1,
      localName: 'input',
      attributes: ['type', 'text', 'name', 'q'],
    }))).toEqual({ type: 'text', name: 'q' })
  })

  it('projects shadow roots and iframe documents from pierced payloads', () => {
    const document = node({
      nodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [
        node({ nodeId: 2, localName: 'host', backendNodeId: 10, shadowRoots: [
          node({ nodeId: 3, localName: 'slot-inner', backendNodeId: 11 }),
        ] }),
        node({ nodeId: 4, localName: 'iframe', backendNodeId: 12, contentDocument: node({
          nodeId: 5,
          nodeType: 9,
          nodeName: '#document',
          children: [node({ nodeId: 6, localName: 'p', backendNodeId: 13 })],
        }) }),
      ],
    })
    const result = buildAgentBrowserSnapshotTree(document)

    expect(result.tree).toContain('shadow-root')
    expect(result.tree).toContain('slot-inner #eb')
    expect(result.tree).toContain('iframe-document')
    expect(result.tree).toContain('p #ed')
  })

  it('truncates at the node budget and marks the tree', () => {
    // A 6_000-node wide page overruns the 5_000 budget mid-walk.
    const wide: AgentBrowserCdpNode = node({
      nodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: Array.from({ length: 6_000 }, (_, index) =>
        node({ nodeId: index + 2, localName: 'span', backendNodeId: index + 2 })),
    })
    const result = buildAgentBrowserSnapshotTree(wide)

    expect(result.truncated).toBe(true)
    expect(result.nodeCount).toBe(AGENT_BROWSER_SNAPSHOT_NODE_BUDGET)
    expect(result.tree.endsWith(AGENT_BROWSER_SNAPSHOT_TRUNCATION_MARKER)).toBe(true)
    // The marker caps output text: the projection never emits node 6_000.
    expect(result.tree).not.toContain('span #e4mp')
  })

  it('honors an explicit smaller budget', () => {
    const result = buildAgentBrowserSnapshotTree(loginDocument(), { nodeBudget: 4 })
    expect(result.truncated).toBe(true)
    expect(result.nodeCount).toBe(4)
  })

  it('keeps the walk inside the snapshot build-time budget', () => {
    // A budget-sized pierced tree (the worst case that still avoids the
    // shallow re-fetch) must not stall the shared main-process loop.
    const heavy: AgentBrowserCdpNode = node({
      nodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: Array.from({ length: 250 }, () => node({
        nodeId: 2,
        localName: 'section',
        children: Array.from({ length: 20 }, () => node({
          nodeId: 3,
          localName: 'div',
          attributes: ['class', 'row', 'data-test', 'value'],
          children: [
            node({ nodeId: 4, nodeType: 3, nodeName: '#text', nodeValue: 'cell text '.repeat(4) }),
          ],
        })),
      })),
    })
    const projection = buildAgentBrowserSnapshotTree(heavy)
    expect(projection.nodeCount).toBeGreaterThan(4_000)

    const started = performance.now()
    for (let index = 0; index < 5; index += 1) buildAgentBrowserSnapshotTree(heavy)
    const perBuild = (performance.now() - started) / 5
    // Generous CI headroom: the assertion is an order-of-magnitude tripwire
    // (a pathological walk shows up as hundreds of ms, not single digits).
    expect(perBuild).toBeLessThan(150)
  })
})
