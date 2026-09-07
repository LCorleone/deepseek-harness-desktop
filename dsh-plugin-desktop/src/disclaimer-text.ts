/**
 * The beta disclaimer copy (v2 定稿, 2026-09-07) shown once per client
 * version AND text revision before the desktop shell mounts.
 *
 * The statement is product copy, not a secret: it lives in code (no blob),
 * and revising it means changing this constant and shipping a release —
 * which is exactly the governance the per-version+hash acknowledgment
 * (`disclaimer-gate.ts`) assumes. The hash below is taken over the JSON
 * serialization of `{ title, items }`, so the acknowledged text and the
 * displayed text are the same bytes by construction (the window renders
 * these constants through its view model).
 *
 * @module dsh-plugin-desktop/disclaimer-text
 */

import { createHash } from 'node:crypto'

/** Statement heading, verbatim from the v2 定稿. */
export const DISCLAIMER_TITLE = '内测声明'

/**
 * The seven numbered clauses, verbatim from the v2 定稿 (each entry is the
 * text AFTER its list number — the renderer numbers the list itself). Item
 * five carries its three referenced guidelines as embedded line breaks; the
 * renderer honors them with `white-space: pre-line`.
 */
export const DISCLAIMER_ITEMS: readonly string[] = [
  '您输入的内容和上传的文档不能涉及个人敏感信息及高度保密信息。',
  '您使用本工具进行的处理活动应遵守德勤中国的数据处理要求，不得使用本工具进行重要数据的处理。',
  '您应确保相关文档自合法来源收集，并您有权使用和处理相关文件及内容。',
  '本工具依赖于大模型算法，答案的准确性和完整性可能会受到多种因素的影响，您应当自行判断并确保所生成内容的准确性、合法性、道德性及可靠性，并承担使用本工具所带来的所有风险和责任。',
  '您在使用上要严格遵守德勤及相关法律法规、监管要求及国家相关标准的指引及要求，包括但不限于以下：\n国家互联网信息办公室：关于《生成式人工智能服务管理暂行办法》的通知\n德勤亚太：关于生成式人工智能（包括ChatGPT）的临时使用指引\n生成式AI合规指引(第一版)',
  '此工具仅限于德勤内部学习及办公辅助用途，用户若将本工具用于向具体客户交付项目，必须事先咨询 PIC 及业务风险团队。',
  '如有任何关于Deloitte Deepseek Harness的相关问题，请联系 cndchatgen@deloittecn.com.cn。',
]

/**
 * sha256 (hex) of the statement's canonical JSON form
 * `JSON.stringify({ title, items })`. Pure and total: the same constants
 * always hash to the same digest, any revision of any clause changes it,
 * and tests pin both properties. Defaults make `disclaimerTextHash()` the
 * current build's disclaimer revision id.
 */
export function disclaimerTextHash(
  items: readonly string[] = DISCLAIMER_ITEMS,
  title: string = DISCLAIMER_TITLE,
): string {
  return createHash('sha256').update(JSON.stringify({ title, items }), 'utf8').digest('hex')
}
