import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DISCLAIMER_ITEMS,
  DISCLAIMER_TITLE,
  disclaimerTextHash,
} from '../src/disclaimer-text.ts'

/**
 * The v2 statement is pinned VERBATIM here (定稿 2026-09-07, 老板拍板): any
 * edit to the copy is a deliberate revision that must change the hash and
 * re-prompt the fleet — this spec is where an accidental edit gets caught.
 */
describe('disclaimer v2 copy (verbatim pin)', () => {
  it('keeps the fixed heading and exactly seven clauses', () => {
    expect(DISCLAIMER_TITLE).toBe('内测声明')
    expect(DISCLAIMER_ITEMS).toHaveLength(7)
    for (const item of DISCLAIMER_ITEMS) expect(item.length).toBeGreaterThan(0)
  })

  it('keeps every clause character-for-character as decided', () => {
    expect(DISCLAIMER_ITEMS[0]).toBe('您输入的内容和上传的文档不能涉及个人敏感信息及高度保密信息。')
    expect(DISCLAIMER_ITEMS[1]).toBe('您使用本工具进行的处理活动应遵守德勤中国的数据处理要求，不得使用本工具进行重要数据的处理。')
    expect(DISCLAIMER_ITEMS[2]).toBe('您应确保相关文档自合法来源收集，并您有权使用和处理相关文件及内容。')
    expect(DISCLAIMER_ITEMS[3]).toBe('本工具依赖于大模型算法，答案的准确性和完整性可能会受到多种因素的影响，您应当自行判断并确保所生成内容的准确性、合法性、道德性及可靠性，并承担使用本工具所带来的所有风险和责任。')
    expect(DISCLAIMER_ITEMS[4]).toBe('您在使用上要严格遵守德勤及相关法律法规、监管要求及国家相关标准的指引及要求，包括但不限于以下：\n国家互联网信息办公室：关于《生成式人工智能服务管理暂行办法》的通知\n德勤亚太：关于生成式人工智能（包括ChatGPT）的临时使用指引\n生成式AI合规指引(第一版)')
    expect(DISCLAIMER_ITEMS[5]).toBe('此工具仅限于德勤内部学习及办公辅助用途，用户若将本工具用于向具体客户交付项目，必须事先咨询 PIC 及业务风险团队。')
    expect(DISCLAIMER_ITEMS[6]).toBe('如有任何关于Deloitte Deepseek Harness的相关问题，请联系 cndchatgen@deloittecn.com.cn。')
  })

  it('carries the three referenced guidelines of clause five as separate lines', () => {
    const lines = (DISCLAIMER_ITEMS[4] ?? '').split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[1]).toContain('国家互联网信息办公室')
    expect(lines[2]).toContain('德勤亚太')
    expect(lines[3]).toBe('生成式AI合规指引(第一版)')
  })
})

describe('disclaimer text hash', () => {
  it('is a stable 64-hex sha256 of the canonical JSON form', () => {
    const first = disclaimerTextHash()
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(disclaimerTextHash()).toBe(first)
    // The hash is exactly sha256(JSON.stringify({ title, items })) — the
    // same computation an analyst can reproduce from the pinned copy.
    expect(first).toBe(
      createHash('sha256')
        .update(JSON.stringify({ title: DISCLAIMER_TITLE, items: DISCLAIMER_ITEMS }), 'utf8')
        .digest('hex'),
    )
  })

  it('changes when any clause, the clause count, or the heading changes', () => {
    const baseline = disclaimerTextHash()
    const revisedClause = [...DISCLAIMER_ITEMS]
    revisedClause[0] = `${revisedClause[0] ?? ''}（修订）`
    expect(disclaimerTextHash(revisedClause)).not.toBe(baseline)
    expect(disclaimerTextHash(DISCLAIMER_ITEMS.slice(0, 6))).not.toBe(baseline)
    expect(disclaimerTextHash(DISCLAIMER_ITEMS, '修订声明')).not.toBe(baseline)
  })

  it('depends on the exact characters of a clause, not just its shape', () => {
    const baseline = disclaimerTextHash()
    const punctuationEdited = DISCLAIMER_ITEMS.map((item, index) => index === 5 ? item.replace('。', '．') : item)
    expect(disclaimerTextHash(punctuationEdited)).not.toBe(baseline)
  })
})
