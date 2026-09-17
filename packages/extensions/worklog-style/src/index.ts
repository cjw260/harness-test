/**
 * Work-log style assistant, node half.
 *
 * - Opens one KV storage unit `worklog_style` (json backend) holding daily
 *   logs, writing-style samples, and the learned style profile.
 * - Registers the `worklog_*` model tools (collect git work, manage samples,
 *   learn / read the style profile).
 * - Registers a runtime skill (`worklog-writing`) carrying the anti-AI-flavor
 *   writing rules and a small system-prompt section for discoverability.
 * - Serves `/worklog/<endpoint>` JSON RPC for the browser settings page.
 * @module @deepseek-ai/dsh-worklog-style
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'worklog-style'
export const inject = ['tools']

/** Minimal storage face (json backend KV unit) reached through ctx.get. */
interface KvUnitLike {
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>
  putRecord(table: string, key: string, value: unknown): Promise<void>
  deleteRecord(table: string, key: string): Promise<void>
  setGlobal(value: unknown): Promise<void>
  close(): Promise<void>
}

interface StorageLike {
  backend: {
    get(backendName: string): { kv?: { open(descriptor: unknown): Promise<KvUnitLike> } }
  }
}

/** Minimal node http request face (structural — no ambient node types). */
interface ReqLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
}

/** Minimal node http response face (structural — no ambient node types). */
interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string): unknown
}

interface WebServerLike {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: ReqLike, res: ResLike) => void | Promise<void>
  }): () => void
}

interface SkillsLike {
  register(skill: {
    name: string
    description: string
    whenToUse?: string
    content: string
    source?: string
  }): () => void
}

interface SystemPromptLike {
  section(section: { name: string; order: number; text: string }): () => void
}

interface ShellRunResultLike {
  exitCode: number | null
  stdout: { text: string }
  sandbox?: { denied?: boolean; mode?: unknown }
}

interface ShellLike {
  resolve(request: unknown): unknown
  run(spec: unknown): Promise<ShellRunResultLike>
}

interface LlmLike {
  stream(options: {
    provider: string
    model: string
    system?: string
    temperature?: number
    maxTokens?: number
    messages: unknown[]
  }): AsyncIterable<{ type: string; text?: string; error?: unknown; reason?: unknown }>
}

interface AgentDefaultModelLike {
  currentSelection(): { provider?: unknown; model?: unknown }
}

interface FsLike {
  resolve(path: string, opts?: { cwd?: string }): Promise<{ targetKey?: string }>
  stat(target: { targetKey?: string }): Promise<unknown>
  readText(target: { targetKey?: string }): Promise<string>
  readBytes(target: { targetKey?: string }, signal: unknown, maxBytes: number): Promise<Uint8Array>
  writeText(target: { targetKey?: string }, content: string, expected?: unknown, signal?: unknown, sandboxPolicy?: unknown): Promise<unknown>
}

/** Log record stored under the `logs` table, keyed by YYYY-MM-DD. */
interface LogRecord {
  date: string
  content: string
  updatedAt: string
}

/** Sample record stored under the `samples` table, keyed by sample id. */
interface SampleRecord {
  id: string
  label: string
  savedAt: string
  length: number
  text: string
}

/** Report template stored under the `templates` table: daily | weekly | monthly. */
interface TemplateRecord {
  type: string
  content: string
  source: 'inline' | 'file'
  filePath?: string
  updatedAt: string
}

const CHECKLIST = [
  '- 少用连接词:不用“首先/其次/最后/综上所述/此外/与此同时/值得注意的是”。',
  '- 动词具体:“改、修、调、加、顺手处理了”,避免“完善、优化、赋能、提升体验”这类空词。',
  '- 先理解再写:拿到 diff 和提交记录后,先想清楚每个改动在解决什么问题、为什么这么做,再动笔;写的是“原因 + 效果”,不是参数变更的转述。',
  '- 英文标识符做减法:组件名、文件名、参数名不直接搬进日志,翻译成“是什么、干什么”的中文说法;只有品牌、产品、协议、图片格式这类专有名词才保留英文(如 Shopify、Figma、AVIF、WebP)。',
  '- 设计稿引用不写节点号:不写“Figma 1257”“Figma 1381:323”这类具体节点编号,统一写成“Figma 原型图/设计稿”。',
  '- 具体但口语化:写清楚做了什么,但用自然说法,如“给详情图做了三档宽度适配”,而不是“新增 transitionDetailImageWidths 三档宽度”;“单独设了 wideTransitionDetailImageSizes”应写成“横图塞进竖容器会被放大裁切,所以给横向特写图单独设了一套尺寸”。',
  '- 合并细节:一个功能里的多个小改动合并成一句自然描述,不要逐条转述 diff 和提交记录。',
  '- 允许过程感:可以写“这里之前没注意”“卡了一会儿”“最后发现是 xxx”。',
  '- 句长混排:短句为主,偶尔一个长句;允许不完整口语句;不要排比,不要三连。',
  '- 不总结意义:每件事说完就停,不要加“提升了用户体验”之类收尾。',
  '- 克制格式:按范文格式来,不要过度 markdown,不要加粗满天飞。',
  '- 不写完美句:全篇没一处不通顺反而像 AI;允许一两处口语化的粗糙表达。',
  '- 篇幅对齐范文平均长度,不要每篇写满。',
  '- 不用 emoji,不堆砌“——”破折号,少用括号补充。',
].join('\n')

const SKILL_CONTENT = [
  '# 工作日志代写(worklog-writing)',
  '',
  '## 何时使用',
  '用户要求写工作日志/日报/今日总结、周报、月报、保存范文、学习文风、调整日志措辞、导出文件,或询问本插件怎么用时。',
  '',
  '## 首次使用指引',
  '- 用户问“这个插件在哪里设置/怎么用/关键词是什么”时,告诉他:设置页在左下角「设置」→「工作日志」,写日志、看历史、配模板、改导出目录都在那个页面;页面顶部有完整的使用指引。',
  '- 常用关键词:「写今天的日志」(按 git 改动起草日报)、「写这周的周报」「写这个月的月报」(收集区间提交并套用模板)、「学习文风」(基于已保存日志和范文生成文风档案)、「导出成 Word/PDF/md」(导出文件到配置目录)、粘贴旧日志并说「存成范文」(扩充文风素材)。',
  '',
  '## 标准工作流',
  '1. 收集素材:调用 worklog_collect_work(可传 repoPath/date/author)。没有 git 改动时如实说明,并问用户今天还做了什么,不要编造。',
  '2. 取模板:调用 worklog_get_template(type) 看用户是否配置了日报/周报/月报模板;有模板就严格按模板结构填写,没有就用默认结构。',
  '3. 读取文风:调用 worklog_get_style,拿到文风档案、素材节选和反 AI 味守则。',
  '4. 消化改动:通读 git 素材,把每个改动想清楚——它在解决什么问题、为什么这么做、做完什么效果,再决定怎么写。',
  '5. 起草:严格按档案的结构/常用词/语气词/句式来写,内容只来自 git 事实;逐条对照档案特征,而不是只参考大意。',
  '6. 交付与迭代:直接在对话里输出。用户说太短/太正式/换个说法/加一条,就按意见修改后重新输出,直到用户满意。用户定稿后,调用 worklog_save_log 把日志存进日志库(或让用户自己在「设置 → 工作日志」保存);这些日志会作为以后「学习文风」的素材。用户要导出文件时,调用 worklog_export 把内容导出成 md/Word/PDF 文件到工作区。',
  '',
  '## 周报与月报',
  '- 用户说“写周报/月报/总结这周/总结这个月”时,用 worklog_collect_work 传 startDate/endDate(只给 endDate 默认从 6 天前开始)收集区间素材,提交会按天分组。',
  '- 先调用 worklog_get_template(type) 取用户配置的模板;模板里的章节、表格、状态标记都要保留,占位说明替换成实际内容。',
  '- 结构:先写一两句整体进展,再按天(或按项目)列出关键事项;每件事写原因和效果,不逐条转述 diff。',
  '- 提炼重点:周报/月报不是把每天的日志拼起来,一个任务一段话说完;语气用词沿用文风档案。',
  '- 定稿后可用 worklog_save_log 保存(用结束日期),也可由用户自行处理。',
  '',
  '## 消化改动,不要转述 diff',
  '- 提交记录和 diff 是线索,不是台词:先理解每个改动在解决什么问题(为什么删、为什么加这个参数、为什么这样裁切),再用自己的话把原因和效果写出来。',
  '- 英文标识符做减法:组件名/文件名/参数名不直接搬进日志,翻译成中文说法;品牌、产品、协议、图片格式等专有名词保留英文。',
  '- 设计稿节点号不写:Figma 1257、Figma 1381:323 这类编号统一写成“Figma 原型图/设计稿”。',
  '- 示例:不写“新增了 transitionDetailImageWidths 三档宽度和 wideTransitionDetailImageSizes”,写“给详情图做了三档宽度适配;横图塞进竖容器会被放大裁切,所以横向特写图单独设了一套尺寸”。',
  '- 不要逐条转述:一个功能里的多个小改动合并成一句自然描述。',
  '',
  '## 文风管理',
  '- 用户粘贴旧日志 → worklog_save_sample;用户给文件路径 → worklog_import_sample。',
  '- 用户说“学习文风” → 调用 worklog_learn_style,插件会调用模型分析全部素材(已保存日志 + 范文)并保存档案。',
  '- worklog_list_style 查看素材与档案状态;worklog_remove_sample 删除某篇范文。',
  '',
  '## 反 AI 味守则',
  CHECKLIST,
].join('\n')

const PROMPT_SECTION_TEXT = '当用户要求写工作日志/日报/今日总结、周报、月报、保存范文、学习文风或导出文件时,使用 worklog_* 工具:worklog_collect_work 收集 git 改动(单日用 date,周报/月报传 startDate/endDate,区间提交按天分组),worklog_get_template 读取用户配置的日报/周报/月报模板,worklog_get_style 读取文风档案与反 AI 味守则,worklog_save_sample / worklog_import_sample 保存范文,worklog_save_log 保存定稿日志,worklog_export 把内容导出成 md/Word/PDF 文件,worklog_learn_style 学习文风(素材 = 已保存日志 + 范文),worklog_list_style 查看状态。起草时严格按文风档案与模板写作,并在对话里响应用户的修改意见。'

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…(已截断,原文更长)`
}

function extractJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function renderProfile(record: { learnedAt: string; corpusCount: number; logCount?: number; sampleCount?: number; profile?: Record<string, unknown> }): string {
  const p = record.profile ?? {}
  const list = (v: unknown): string => (Array.isArray(v) ? v.map(String).join('、') : '—')
  const tones = Array.isArray(p.toneWords)
    ? (p.toneWords as Array<{ word?: unknown; frequency?: unknown }>).map(t => `${String(t.word ?? '')}(${String(t.frequency ?? '')})`).join('、')
    : '—'
  const corpusNote = `基于 ${record.corpusCount} 篇素材(日志 ${record.logCount ?? 0} 篇 + 范文 ${record.sampleCount ?? 0} 篇)`
  return [
    `## 文风档案(学习时间 ${record.learnedAt},${corpusNote})`,
    `- 结构:${String(p.structure ?? '—')}`,
    `- 常用词:${list(p.commonWords)}`,
    `- 语气词:${tones}`,
    `- 描述方式:${String(p.descriptionStyle ?? '—')}`,
    `- 句式:${String(p.sentenceStyle ?? '—')}`,
    `- 习惯表达:${list(p.signaturePhrases)}`,
    `- 避免:${list(p.thingsToAvoid)}`,
  ].join('\n')
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function localDate(): string {
  const d = new Date()
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** N days before a YYYY-MM-DD date, same format. */
function minusDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() - n)
  const pad = (x: number): string => (x < 10 ? `0${x}` : String(x))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function shq(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// ── export helpers (md / docx / pdf) ────────────────────────────────────

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64Encode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out += B64_CHARS[b0 >> 2]!
      + B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)]!
      + (i + 1 < bytes.length ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)]! : '=')
      + (i + 2 < bytes.length ? B64_CHARS[b2 & 63]! : '=')
  }
  return out
}

let CRC_TABLE: Uint32Array | undefined
function crc32(data: Uint8Array): number {
  if (CRC_TABLE === undefined) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xFF]! ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function le16(v: number): number[] { return [v & 0xFF, (v >> 8) & 0xFF] }
function le32(v: number): number[] { return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF] }

/** Minimal ZIP writer with STORED (uncompressed) entries — valid for .docx. */
function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder()
  const parts: number[] = []
  const central: number[] = []
  let offset = 0
  for (const file of files) {
    const name = encoder.encode(file.name)
    const crc = crc32(file.data)
    parts.push(
      ...le32(0x04034B50), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0),
      ...le32(crc), ...le32(file.data.length), ...le32(file.data.length),
      ...le16(name.length), ...le16(0),
      ...name, ...file.data,
    )
    central.push(
      ...le32(0x02014B50), ...le16(20), ...le16(20), ...le16(0), ...le16(0),
      ...le16(0), ...le16(0),
      ...le32(crc), ...le32(file.data.length), ...le32(file.data.length),
      ...le16(name.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0),
      ...le32(offset), ...name,
    )
    offset += 30 + name.length + file.data.length
  }
  parts.push(
    ...central,
    ...le32(0x06054B50), ...le16(0), ...le16(0),
    ...le16(files.length), ...le16(files.length),
    ...le32(central.length), ...le32(offset), ...le16(0),
  )
  return new Uint8Array(parts)
}

interface MdBlock {
  kind: 'heading' | 'paragraph' | 'bullet' | 'table' | 'skip'
  level?: number
  text?: string
  rows?: string[][]
}

interface Seg { text: string; bold: boolean }

function unescapeMd(text: string): string {
  return text.replace(/\\([_*#\[\](){}<>\\-])/g, '$1')
}

function parseInline(text: string): Seg[] {
  const source = unescapeMd(text)
  const segs: Seg[] = []
  const re = /\*\*(.+?)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    if (m.index > last) segs.push({ text: source.slice(last, m.index), bold: false })
    segs.push({ text: m[1]!, bold: true })
    last = m.index + m[0].length
  }
  if (last < source.length) segs.push({ text: source.slice(last), bold: false })
  if (segs.length === 0) segs.push({ text: source, bold: false })
  return segs
}

function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const t = lines[i]!.trim()
    if (t === '') {
      i++
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(t)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! })
      i++
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      blocks.push({ kind: 'skip' })
      i++
      continue
    }
    if (/^\|.*\|$/.test(t)) {
      const rows: string[][] = []
      while (i < lines.length && /^\|.*\|$/.test(lines[i]!.trim())) {
        const cells = lines[i]!.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
        const isSeparator = cells.every(c => /^:?-{2,}:?$/.test(c))
        if (!isSeparator) rows.push(cells)
        i++
      }
      if (rows.length > 0) blocks.push({ kind: 'table', rows })
      continue
    }
    if (/^[-*+]\s+/.test(t)) {
      blocks.push({ kind: 'bullet', text: t.replace(/^[-*+]\s+/, '') })
      i++
      continue
    }
    let text = t
    i++
    while (
      i < lines.length
      && lines[i]!.trim() !== ''
      && !/^(#{1,6}\s|\|.*\|$|[-*+]\s|(-{3,}|\*{3,})$)/.test(lines[i]!.trim())
    ) {
      text += `\n${lines[i]!.trim()}`
      i++
    }
    blocks.push({ kind: 'paragraph', text })
  }
  return blocks
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inlineHtml(text: string): string {
  return parseInline(text).map(seg => (seg.bold ? `<strong>${escapeHtml(seg.text)}</strong>` : escapeHtml(seg.text))).join('')
}

function runsXml(segs: Seg[]): string {
  return segs.map(seg => (
    seg.bold
      ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEscape(seg.text)}</w:t></w:r>`
      : `<w:r><w:t xml:space="preserve">${xmlEscape(seg.text)}</w:t></w:r>`
  )).join('')
}

/** Minimal .docx: heading/bold/bullets/tables, stored-zip container. */
function buildDocx(blocks: MdBlock[]): Uint8Array {
  const encoder = new TextEncoder()
  const paras: string[] = []
  for (const b of blocks) {
    if (b.kind === 'skip') continue
    if (b.kind === 'heading') {
      paras.push(`<w:p><w:pPr><w:pStyle w:val="Heading${b.level}"/></w:pPr>${runsXml(parseInline(b.text ?? ''))}</w:p>`)
    } else if (b.kind === 'bullet') {
      paras.push(`<w:p><w:pPr><w:ind w:left="360" w:hanging="180"/></w:pPr>${runsXml([{ text: '• ', bold: false }, ...parseInline(b.text ?? '')])}</w:p>`)
    } else if (b.kind === 'paragraph') {
      for (const part of (b.text ?? '').split('\n')) {
        paras.push(`<w:p>${runsXml(parseInline(part))}</w:p>`)
      }
    } else if (b.kind === 'table') {
      const rows = (b.rows ?? []).map(row => (
        `<w:tr>${row.map(cell => `<w:tc><w:p>${runsXml(parseInline(cell))}</w:p></w:tc>`).join('')}</w:tr>`
      )).join('')
      const grid = `<w:tblGrid>${(b.rows?.[0] ?? []).map(() => '<w:gridCol w:w="2200"/>').join('')}</w:tblGrid>`
      const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
        .map(side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`)
        .join('')
      paras.push(`<w:tbl><w:tblPr><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${grid}${rows}</w:tbl>`)
    }
  }
  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${paras.join('')}<w:sectPr/></w:body></w:document>`
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>'
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>'
  return zipStore([
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(rels) },
    { name: 'word/document.xml', data: encoder.encode(documentXml) },
  ])
}

function renderHtml(title: string, blocks: MdBlock[]): string {
  const body = blocks.map(b => {
    if (b.kind === 'skip') return ''
    if (b.kind === 'heading') return `<h${b.level}>${inlineHtml(b.text ?? '')}</h${b.level}>`
    if (b.kind === 'bullet') return `<ul><li>${inlineHtml(b.text ?? '')}</li></ul>`
    if (b.kind === 'paragraph') return `<p>${(b.text ?? '').split('\n').map(part => inlineHtml(part)).join('<br/>')}</p>`
    if (b.kind === 'table') {
      const rows = (b.rows ?? []).map(row => `<tr>${row.map(cell => `<td>${inlineHtml(cell)}</td>`).join('')}</tr>`).join('')
      return `<table>${rows}</table>`
    }
    return ''
  }).join('\n')
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + `<title>${escapeHtml(title)}</title>`
    + '<style>'
    + 'body{font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;line-height:1.65;color:#1f2328;max-width:820px;margin:0 auto;padding:36px}'
    + 'h1{font-size:24px;border-bottom:2px solid #e5e7eb;padding-bottom:8px}'
    + 'h2{font-size:20px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;margin-top:26px}'
    + 'h3{font-size:17px;margin-top:20px}'
    + 'p{margin:8px 0}'
    + 'ul{margin:8px 0;padding-left:24px}'
    + 'table{border-collapse:collapse;width:100%;margin:12px 0}'
    + 'td{border:1px solid #d0d7de;padding:6px 10px;font-size:14px;vertical-align:top}'
    + 'td:first-child{font-weight:600;background:#f6f8fa}'
    + '</style></head><body>'
    + body
    + '</body></html>'
}

export function apply(ctx: Context): void {
  // The storage unit opens lazily on first use: this row may activate before
  // the storage row in some compositions, and tools/report errors at call
  // time either way.
  let unitPromise: Promise<KvUnitLike> | null = null

  async function openUnit(): Promise<KvUnitLike> {
    const storage = ctx.get('storage') as unknown as StorageLike | undefined
    if (storage === undefined) throw new Error('storage 服务缺失')
    const backend = storage.backend.get('json')
    if (backend.kv === undefined) throw new Error('storage json 后端未提供 kv 能力')
    return backend.kv.open({ name: 'worklog_style', version: 1, tables: ['logs', 'samples', 'templates', 'config'], hasGlobal: true })
  }

  function requireUnit(): Promise<KvUnitLike> {
    if (unitPromise === null) {
      unitPromise = openUnit().catch((error: unknown) => {
        unitPromise = null
        throw new Error(`存储不可用: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return unitPromise
  }

  ctx.effect(() => () => {
    if (unitPromise !== null) {
      const pending = unitPromise
      void pending.then(unit => unit.close()).catch(() => {})
    }
  })

  async function loadLogs(): Promise<Record<string, LogRecord>> {
    const unit = await requireUnit()
    const all = await unit.loadAll()
    return (all.tables.logs ?? {}) as Record<string, LogRecord>
  }

  async function loadSamples(): Promise<Record<string, SampleRecord>> {
    const unit = await requireUnit()
    const all = await unit.loadAll()
    return (all.tables.samples ?? {}) as Record<string, SampleRecord>
  }

  async function loadGlobal(): Promise<unknown> {
    const unit = await requireUnit()
    const all = await unit.loadAll()
    return all.global
  }

  async function saveLog(date: string, content: string): Promise<void> {
    const unit = await requireUnit()
    await unit.putRecord('logs', date, { date, content, updatedAt: new Date().toISOString() })
  }

  async function deleteLog(date: string): Promise<void> {
    const unit = await requireUnit()
    await unit.deleteRecord('logs', date)
  }

  async function replaceSamples(prev: Record<string, SampleRecord>, next: Record<string, SampleRecord>): Promise<void> {
    const unit = await requireUnit()
    for (const key of Object.keys(prev)) {
      if (next[key] === undefined) await unit.deleteRecord('samples', key)
    }
    for (const key of Object.keys(next)) {
      const p = prev[key]
      const n = next[key]
      if (p === undefined || JSON.stringify(p) !== JSON.stringify(n)) await unit.putRecord('samples', key, n)
    }
  }

  async function setGlobalProfile(record: unknown): Promise<void> {
    const unit = await requireUnit()
    await unit.setGlobal(record)
  }

  const TEMPLATE_TYPES = ['daily', 'weekly', 'monthly'] as const
  type TemplateType = typeof TEMPLATE_TYPES[number]

  async function loadTemplates(): Promise<Record<string, TemplateRecord>> {
    const unit = await requireUnit()
    const all = await unit.loadAll()
    return (all.tables.templates ?? {}) as Record<string, TemplateRecord>
  }

  async function saveTemplateRecord(type: TemplateType, content: string, filePath?: string): Promise<void> {
    const unit = await requireUnit()
    await unit.putRecord('templates', type, {
      type,
      content,
      source: filePath !== undefined ? 'file' : 'inline',
      ...(filePath !== undefined ? { filePath } : {}),
      updatedAt: new Date().toISOString(),
    })
  }

  function templateTypeOf(value: unknown): TemplateType | undefined {
    return TEMPLATE_TYPES.includes(value as TemplateType) ? (value as TemplateType) : undefined
  }

  // ── export directory config ────────────────────────────────────────────
  async function loadConfig(): Promise<Record<string, unknown>> {
    const unit = await requireUnit()
    const all = await unit.loadAll()
    return (all.tables.config ?? {}) as Record<string, unknown>
  }

  async function getExportDir(): Promise<string> {
    const cfg = await loadConfig()
    return typeof cfg.exportDir === 'string' ? cfg.exportDir.trim() : ''
  }

  async function setExportDir(path: string): Promise<void> {
    const unit = await requireUnit()
    await unit.putRecord('config', 'exportDir', path.trim())
  }

  async function setConfigValue(key: string, value: unknown): Promise<void> {
    const unit = await requireUnit()
    await unit.putRecord('config', key, value)
  }

  async function getGuideSeen(): Promise<boolean> {
    const cfg = await loadConfig()
    return cfg.guideSeen === true
  }

  async function homeDir(): Promise<string> {
    const res = await runShell('printf %s "$HOME"', { timeoutMs: 10000 })
    return res.exitCode === 0 ? res.stdout.text.trim() : ''
  }

  /** Configured export directory; unset defaults to ~/Documents/工作日志导出. */
  async function resolveExportDir(): Promise<string> {
    let dir = await getExportDir()
    const home = await homeDir()
    if (dir === '') {
      if (home !== '') dir = `${home}/Documents/工作日志导出`
      else {
        const root = workspaceRoot()
        dir = root !== '' ? `${root}/工作日志导出` : '工作日志导出'
      }
    } else if (dir.startsWith('~/')) {
      dir = home !== '' ? `${home}/${dir.slice(2)}` : dir.slice(2)
    }
    return dir
  }

  // ── export: md / docx / pdf ────────────────────────────────────────────
  async function runShell(command: string, extra: { workdir?: string; stdin?: string; timeoutMs?: number } = {}): Promise<ShellRunResultLike> {
    const shell = ctx.get('shell') as unknown as ShellLike | undefined
    if (shell === undefined) throw new Error('shell 服务不可用')
    const request: Record<string, unknown> = {
      command,
      timeoutMs: extra.timeoutMs ?? 30000,
      stdoutMaxBytes: 200000,
      ...(extra.workdir !== undefined ? { workdir: extra.workdir } : {}),
      ...(extra.stdin !== undefined ? { stdin: extra.stdin } : {}),
    }
    return shell.run(shell.resolve(request))
  }

  function workspaceRoot(): string {
    const sandboxPolicy = ctx.get('sandboxPolicy') as unknown as { workspaceRoot?: unknown } | undefined
    return typeof sandboxPolicy?.workspaceRoot === 'string' ? sandboxPolicy.workspaceRoot.replace(/\/+$/, '') : ''
  }

  /** PDF via headless Chrome/Edge first (best CJK rendering), then cupsfilter. */
  async function buildPdf(title: string, blocks: MdBlock[]): Promise<Uint8Array> {
    const fs = ctx.get('fs') as unknown as FsLike | undefined
    if (fs === undefined) throw new Error('fs 服务不可用')
    const root = workspaceRoot()
    const tmpDir = `${root !== '' ? `${root}/` : ''}.worklog-tmp-${Date.now().toString(36)}`
    const htmlPath = `${tmpDir}/export.html`
    const pdfPath = `${tmpDir}/export.pdf`
    await runShell(`mkdir -p ${shq(tmpDir)}`)
    try {
      const target = await fs.resolve(htmlPath)
      await fs.writeText(target, renderHtml(title, blocks))
      const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
      let chrome: string | undefined
      for (const candidate of candidates) {
        const probe = await runShell(`test -x ${shq(candidate)}`, { timeoutMs: 10000 })
        if (probe.exitCode === 0) {
          chrome = candidate
          break
        }
      }
      if (chrome !== undefined) {
        const res = await runShell(
          `${shq(chrome)} --headless --disable-gpu --no-pdf-header-footer --print-to-pdf=${shq(pdfPath)} ${shq(`file://${htmlPath}`)}`,
          { timeoutMs: 60000 },
        )
        if (res.exitCode === 0) {
          const pdfTarget = await fs.resolve(pdfPath)
          if (await fs.stat(pdfTarget) !== undefined) return await fs.readBytes(pdfTarget, undefined, 20_000_000)
        }
      }
      // Fallback: CUPS texttopdf (macOS/Linux with cups).
      const fallback = await runShell(`cupsfilter -m application/pdf ${shq(htmlPath)} > ${shq(pdfPath)}`, { timeoutMs: 60000 })
      if (fallback.exitCode === 0) {
        const pdfTarget = await fs.resolve(pdfPath)
        if (await fs.stat(pdfTarget) !== undefined) return await fs.readBytes(pdfTarget, undefined, 20_000_000)
      }
      throw new Error('本机没有可用的 PDF 生成器(未找到 Chrome/Edge,也没有 cupsfilter)。请改用 Word 或 Markdown 格式导出,或安装 Chrome 后重试。')
    } finally {
      await runShell(`rm -rf ${shq(tmpDir)}`, { timeoutMs: 15000 }).catch(() => {})
    }
  }

  interface ExportBundle { bytes: Uint8Array; ext: string; mime: string }

  async function buildExport(format: 'md' | 'docx' | 'pdf', title: string, content: string): Promise<ExportBundle> {
    if (format === 'md') {
      return { bytes: new TextEncoder().encode(content), ext: 'md', mime: 'text/markdown;charset=utf-8' }
    }
    const blocks = parseMarkdown(content)
    if (format === 'docx') {
      return { bytes: buildDocx(blocks), ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    }
    return { bytes: await buildPdf(title, blocks), ext: 'pdf', mime: 'application/pdf' }
  }

  async function writeBinaryFile(absPath: string, bytes: Uint8Array): Promise<void> {
    const parent = absPath.includes('/') ? absPath.slice(0, absPath.lastIndexOf('/')) : '.'
    const res = await runShell(`mkdir -p ${shq(parent)} && base64 -d > ${shq(absPath)}`, { stdin: base64Encode(bytes), timeoutMs: 30000 })
    if (res.exitCode !== 0) {
      if (res.sandbox?.denied === true) throw new Error(`导出失败:会话沙箱(mode: ${String(res.sandbox.mode)})不允许写入工作区外的目录 ${absPath}。如需导出到工作区外,请在会话中开启 Full access 权限后重试;或者把导出位置改成当前工作区目录,导出后手动移动文件。`)
      throw new Error('写入导出文件失败')
    }
  }

  async function writeTextFile(absPath: string, content: string): Promise<void> {
    const parent = absPath.includes('/') ? absPath.slice(0, absPath.lastIndexOf('/')) : '.'
    const res = await runShell(`mkdir -p ${shq(parent)} && cat > ${shq(absPath)}`, { stdin: content, timeoutMs: 30000 })
    if (res.exitCode !== 0) {
      if (res.sandbox?.denied === true) throw new Error(`导出失败:会话沙箱(mode: ${String(res.sandbox.mode)})不允许写入工作区外的目录 ${absPath}。如需导出到工作区外,请在会话中开启 Full access 权限后重试;或者把导出位置改成当前工作区目录,导出后手动移动文件。`)
      throw new Error('写入导出文件失败')
    }
  }

  const errText = (error: unknown): string => `✗ ${error instanceof Error ? error.message : String(error)}`

  // ── browser settings-page RPC: /worklog/<endpoint> ─────────────────────
  async function dispatch(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
    switch (endpoint) {
      case 'list-logs': {
        const logs = await loadLogs()
        const items = Object.keys(logs).sort().reverse().map(key => ({
          date: logs[key]?.date ?? key,
          updatedAt: logs[key]?.updatedAt ?? '',
          preview: String(logs[key]?.content ?? '').slice(0, 80),
        }))
        return { logs: items }
      }
      case 'get-log': {
        const date = typeof body.date === 'string' ? body.date : ''
        if (!DATE_RE.test(date)) return { error: '日期格式应为 YYYY-MM-DD' }
        const logs = await loadLogs()
        const rec = logs[date]
        if (rec === undefined) return { date, content: '', updatedAt: '' }
        return { date, content: rec.content, updatedAt: rec.updatedAt }
      }
      case 'save-log': {
        const date = typeof body.date === 'string' ? body.date.trim() : ''
        if (!DATE_RE.test(date)) return { error: '日期格式应为 YYYY-MM-DD' }
        const content = typeof body.content === 'string' ? body.content : ''
        if (content.trim() === '') return { error: '日志内容不能为空' }
        await saveLog(date, content)
        return { ok: true, date }
      }
      case 'delete-log': {
        const date = typeof body.date === 'string' ? body.date : ''
        if (!DATE_RE.test(date)) return { error: '日期格式应为 YYYY-MM-DD' }
        await deleteLog(date)
        return { ok: true, date }
      }
      case 'style-status': {
        const samples = await loadSamples()
        const logs = await loadLogs()
        const g = (await loadGlobal()) as { learnedAt?: string; corpusCount?: number } | null | undefined
        return {
          sampleCount: Object.keys(samples).length,
          logCount: Object.keys(logs).length,
          profile: g?.learnedAt ? { learnedAt: g.learnedAt, corpusCount: g.corpusCount ?? 0 } : null,
        }
      }
      case 'list-templates': {
        const stored = await loadTemplates()
        const templates = TEMPLATE_TYPES.map(type => stored[type] ?? { type, content: '', source: 'inline', updatedAt: '' })
        return { templates }
      }
      case 'save-template': {
        const type = templateTypeOf(body.type)
        if (type === undefined) return { error: '模板类型应为 daily / weekly / monthly' }
        const content = typeof body.content === 'string' ? body.content : ''
        if (content.length > 40000) return { error: '模板超过 40000 字符' }
        await saveTemplateRecord(type, content)
        return { ok: true, type, updatedAt: new Date().toISOString() }
      }
      case 'import-template': {
        const type = templateTypeOf(body.type)
        if (type === undefined) return { error: '模板类型应为 daily / weekly / monthly' }
        const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : ''
        if (filePath === '') return { error: '请填写 md 文件路径(相对会话工作区)' }
        if (!filePath.toLowerCase().endsWith('.md')) return { error: '只支持导入 .md 文件' }
        const fs = ctx.get('fs') as unknown as FsLike | undefined
        if (fs === undefined) return { error: 'fs 服务不可用' }
        const sandboxPolicy = ctx.get('sandboxPolicy') as unknown as { workspaceRoot?: unknown } | undefined
        const root = typeof sandboxPolicy?.workspaceRoot === 'string' ? sandboxPolicy.workspaceRoot : ''
        const target = await fs.resolve(filePath, root !== '' ? { cwd: root } : undefined)
        if (await fs.stat(target) === undefined) return { error: `找不到文件: ${filePath}(相对会话工作区 ${root || '当前目录'})` }
        const content = (await fs.readText(target)).trim()
        if (content === '') return { error: '文件内容为空' }
        if (content.length > 40000) return { error: '模板超过 40000 字符' }
        await saveTemplateRecord(type, content, filePath)
        return { ok: true, type, filePath, updatedAt: new Date().toISOString(), content }
      }
      case 'export-file': {
        const format = body.format === 'docx' || body.format === 'pdf' ? body.format : 'md'
        const given = typeof body.content === 'string' && body.content.trim() !== '' ? body.content : undefined
        let text: string
        let label: string
        if (given !== undefined) {
          text = given
          label = typeof body.date === 'string' && DATE_RE.test(body.date) ? body.date : localDate()
        } else {
          const date = typeof body.date === 'string' && DATE_RE.test(body.date) ? body.date : localDate()
          const logs = await loadLogs()
          const rec = logs[date]
          if (rec === undefined || rec.content.trim() === '') return { error: `${date} 没有已保存的日志,请先在编辑器里写点内容再导出` }
          text = rec.content
          label = date
        }
        const bundle = await buildExport(format, label, text)
        return {
          ok: true,
          base64: base64Encode(bundle.bytes),
          fileName: `工作日志-${label}.${bundle.ext}`,
          mime: bundle.mime,
          size: bundle.bytes.length,
        }
      }
      case 'get-config': {
        return { exportDir: await getExportDir(), guideSeen: await getGuideSeen() }
      }
      case 'save-config': {
        if (body.exportDir !== undefined) {
          const exportDir = typeof body.exportDir === 'string' ? body.exportDir.trim() : ''
          if (exportDir.length > 500) return { error: '路径太长' }
          await setExportDir(exportDir)
        }
        if (body.guideSeen !== undefined) {
          await setConfigValue('guideSeen', body.guideSeen === true)
        }
        return { ok: true, exportDir: await getExportDir(), guideSeen: await getGuideSeen(), resolved: await resolveExportDir() }
      }
      default:
        return { error: `未知接口 ${endpoint}` }
    }
  }

  // The webserver row may activate after this row, so register the RPC route
  // in a child context injected once `webServer` becomes available (the row
  // itself never waits on it, keeping non-web compositions loadable).
  ctx.inject(['webServer'], (webCtx) => {
    const ws = webCtx.get('webServer') as unknown as WebServerLike | undefined
    if (ws === undefined) return
    webCtx.effect(() => ws.register({
      kind: 'prefix',
      path: '/worklog',
      handler: async (req: ReqLike, res: ResLike) => {
        const json = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        }
        try {
          const host = String(req.headers.host ?? '').split(':')[0] ?? ''
          if (host !== '' && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
            json(403, { error: 'forbidden' })
            return
          }
          const endpoint = (req.url ?? '/').slice('/worklog'.length + 1).split('?')[0] ?? ''
          let body: Record<string, unknown> = {}
          if (req.method === 'POST') {
            const decoder = new TextDecoder()
            let raw = ''
            for await (const chunk of req) raw += decoder.decode(chunk, { stream: true })
            raw += decoder.decode()
            if (raw.trim() !== '') {
              try {
                body = JSON.parse(raw) as Record<string, unknown>
              } catch {
                json(400, { error: 'bad json' })
                return
              }
            }
          }
          json(200, await dispatch(endpoint, body))
        } catch (error) {
          json(500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))
  })

  // ── model tools ────────────────────────────────────────────────────────
  const output = {
    schema: { type: 'string' as const },
    render(_args: unknown, value: unknown) {
      return [{ type: 'text' as const, text: String(value) }]
    },
  }

  ctx.tools.register(defineTool({
    name: 'worklog_save_sample',
    description: '保存一篇用户以前写的工作日志范文到文风库,用于后续学习用户的写作风格。当用户在对话里粘贴旧日志时调用。',
    parameters: {
      text: { type: 'string', description: '日志范文全文', required: true },
      label: { type: 'string', description: '可选备注,如日期或来源' },
    },
    output,
    async execute(args) {
      try {
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        if (text === '') return '✗ text 不能为空,请粘贴一篇完整的旧日志。'
        if (text.length > 40000) return '✗ 单篇超过 40000 字符,请换一篇或截取有代表性的部分。'
        const label = typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : undefined
        const prev = await loadSamples()
        const next: Record<string, SampleRecord> = { ...prev }
        const id = `s${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        next[id] = { id, label: label ?? `范文 ${Object.keys(next).length + 1}`, savedAt: new Date().toISOString(), length: text.length, text }
        await replaceSamples(prev, next)
        return `✓ 已保存第 ${Object.keys(next).length} 篇范文(${label ?? '未命名'},${text.length} 字)。文风库共 ${Object.keys(next).length} 篇。保存好后可以对我说「学习文风」,我会分析结构、常用词、语气词频率和描述方式并保存档案。`
      } catch (error) {
        return errText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worklog_import_sample',
    description: '从文件导入一篇用户以前写的工作日志范文到文风库。用户给出日志文件路径时调用。',
    parameters: {
      filePath: { type: 'string', description: '日志文件路径(绝对路径或相对会话工作区的路径)', required: true },
      label: { type: 'string', description: '可选备注' },
    },
    output,
    async execute(args) {
      try {
        const fs = ctx.get('fs') as unknown as FsLike | undefined
        if (fs === undefined) return '✗ fs 服务不可用。'
        const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : ''
        if (filePath === '') return '✗ filePath 不能为空。'
        const target = await fs.resolve(filePath)
        if (await fs.stat(target) === undefined) return `✗ 找不到文件: ${filePath}`
        const text = (await fs.readText(target)).trim()
        if (text === '') return '✗ 文件内容为空。'
        if (text.length > 40000) return '✗ 文件超过 40000 字符,请换一篇或截取有代表性的部分。'
        const label = typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : undefined
        const prev = await loadSamples()
        const next: Record<string, SampleRecord> = { ...prev }
        const id = `s${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        next[id] = { id, label: label ?? `来自 ${filePath}`, savedAt: new Date().toISOString(), length: text.length, text }
        await replaceSamples(prev, next)
        return `✓ 已从 ${filePath} 导入范文,文风库共 ${Object.keys(next).length} 篇。可以对我说「学习文风」生成文风档案。`
      } catch (error) {
        return errText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worklog_list_style',
    description: '查看文风库状态:已保存日志与范文列表、文风档案是否已学习。用户询问文风库情况时调用。',
    parameters: {},
    output,
    async execute() {
      try {
        const samples = await loadSamples()
        const logs = await loadLogs()
        const g = (await loadGlobal()) as { learnedAt?: string; corpusCount?: number } | null | undefined
        const ids = Object.keys(samples)
        const logDates = Object.keys(logs).sort()
        const total = ids.length + logDates.length
        const lines = ['# 文风库状态']
        lines.push(`- 已保存日志:${logDates.length === 0 ? ' 0 篇(在「设置 → 工作日志」保存,或让我用 worklog_save_log 存)' : ` ${logDates.length} 篇(${logDates.join('、')})`}`)
        lines.push(`- 范文:${ids.length === 0 ? ' 0 篇(可把以前写的日志粘贴给我)' : ` ${ids.length} 篇`}`)
        ids.forEach((key, i) => {
          const s = samples[key]!
          lines.push(`  ${i + 1}. [${s.id}] ${s.label} · 保存于 ${s.savedAt} · ${s.length} 字`)
        })
        lines.push(`- 学习素材合计:${total} 篇(已保存日志 + 范文都会用于学习文风)`)
        lines.push(`- 文风档案:${g?.learnedAt ? ` 已学习(学习时间 ${g.learnedAt},基于 ${g.corpusCount ?? 0} 篇素材)` : ' 未学习'}`)
        if (!g?.learnedAt && total > 0) lines.push('\n建议下一步:调用 worklog_learn_style,或告诉用户「素材够了,可以学习文风了」。')
        if (total === 0) lines.push('\n还没有任何素材:请在「设置 → 工作日志」保存几篇日志,或把以前写的日志粘贴给我保存为范文。')
        return lines.join('\n')
      } catch (error) {
        return errText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worklog_remove_sample',
    description: '从文风库删除一篇范文。用户说删掉某篇范文时调用。',
    parameters: {
      id: { type: 'string', description: '范文 id,从 worklog_list_style 获取', required: true },
    },
    output,
    async execute(args) {
      try {
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        if (id === '') return '✗ id 不能为空(用 worklog_list_style 查看 id)。'
        const prev = await loadSamples()
        if (prev[id] === undefined) return `✗ 没有找到 id 为 ${id} 的范文。`
        const next: Record<string, SampleRecord> = { ...prev }
        delete next[id]
        await replaceSamples(prev, next)
        return `✓ 已删除范文 ${id},剩余 ${Object.keys(next).length} 篇。若文风档案基于旧范文,建议重新「学习文风」。`
      } catch (error) {
        return errText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worklog_learn_style',
    description: '自动学习用户文风:调用模型分析全部素材(已保存日志 + 范文),提炼结构、常用词、语气词频率、内容描述方式等,保存为文风档案。用户说「学习文风」时调用。',
    parameters: {},
    output,
    async execute() {
      try {
        const samples = await loadSamples()
        const logs = await loadLogs()
        const ids = Object.keys(samples)
        const logDates = Object.keys(logs).sort()
        const total = ids.length + logDates.length
        if (total === 0) return '✗ 还没有可学习的素材。两种方式任选:1) 在「设置 → 工作日志」保存几篇日志;2) 把以前写的日志粘贴给我(worklog_save_sample)或给文件路径(worklog_import_sample)。'
        const llm = ctx.get('llm') as unknown as LlmLike | undefined
        if (llm === undefined) return '✗ llm 服务不可用,无法自动学习。改为直接告诉用户:我会在对话里通读素材并总结他的文风。'
        const agentDefaultModel = ctx.get('agentDefaultModel') as unknown as AgentDefaultModelLike | undefined
        const selection = agentDefaultModel?.currentSelection()
        if (selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return '✗ 无法读取当前默认模型,自动学习失败。改为直接告诉用户:我会在对话里通读素材并总结他的文风。'
        const pieces: string[] = []
        logDates.forEach((key, i) => {
          const rec = logs[key]!
          pieces.push(`【日志 ${i + 1}】(${rec.date})\n${rec.content}`)
        })
        ids.forEach((key, i) => {
          pieces.push(`【范文 ${i + 1}】(${samples[key]!.label})\n${samples[key]!.text}`)
        })
        const joined = pieces.join('\n\n-----\n\n')
        const system = '你是一位文风分析师。分析用户提供的工作日志素材,提炼可复用的写作特征。只输出严格 JSON,不要 markdown 代码块,不要任何多余文字:\n'
          + '{\n"structure": "段落结构、条目风格、每篇大致怎么组织",\n'
          + '"commonWords": ["高频实词,最多 12 个"],\n'
          + '"toneWords": [{"word": "语气词或口头语", "frequency": "高|中|低"}],\n'
          + '"descriptionStyle": "内容描述方式:技术细节粒度、动词偏好、怎么讲一个任务",\n'
          + '"sentenceStyle": "句长、句式习惯、是否用列表、标点习惯",\n'
          + '"signaturePhrases": ["习惯性表达,最多 8 个"],\n'
          + '"thingsToAvoid": ["这些素材里从不出现的写法,最多 8 个"]\n}'
        const prompt = `请学习以下工作日志素材,输出文风档案 JSON:\n\n${truncate(joined, 30000)}`
        let text = ''
        try {
          const stream = llm.stream({
            provider: selection.provider,
            model: selection.model,
            system,
            temperature: 0.2,
            maxTokens: 4000,
            messages: [{
              id: `worklog-style-learn-${Date.now()}`,
              role: 'user',
              content: [{ type: 'text', text: prompt }],
              source: { kind: 'plugin', plugin: 'worklog-style' },
            }],
          })
          for await (const chunk of stream) {
            if (chunk.type === 'text-delta') text += chunk.text ?? ''
            else if (chunk.type === 'finish') break
            else if (chunk.type === 'error' || chunk.type === 'aborted') throw new Error(`分析中断: ${String(chunk.error ?? chunk.reason ?? chunk.type)}`)
          }
        } catch (inner) {
          return `✗ 文风学习失败: ${inner instanceof Error ? inner.message : String(inner)}。可以稍后重试,或直接在对话里通读素材总结文风。`
        }
        const parsed = extractJson(text)
        const record = {
          learnedAt: new Date().toISOString(),
          corpusCount: total,
          logCount: logDates.length,
          sampleCount: ids.length,
          profile: parsed ?? { structure: '', note: '自动解析失败,以下为原始分析文本', raw: truncate(text, 4000) },
        }
        await setGlobalProfile(record)
        return `✓ 文风学习完成,已基于 ${total} 篇素材生成并保存文风档案:\n\n${renderProfile(record)}\n\n以后每次写日志前都会读取这份档案来模仿你的写法。`
      } catch (error) {
        return errText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worklog_get_style',
    description: '读取用户的文风档案、素材节选(已保存日志/范文)和反 AI 味写作守则。起草工作日志之前必须先调用本工具,并按档案逐条模仿用户文风。',
    parameters: {},
    output,
    async execute() {
      try {
        const samples = await loadSamples()
        const logs = await loadLogs()
        const ids = Object.keys(samples)
        const logDates = Object.keys(logs).sort()
        const total = ids.length + logDates.length
        if (total === 0) return '✗ 还没有任何文风素材。请让用户先在「设置 → 工作日志」保存几篇日志,或把以前写的日志粘贴给我(worklog_save_sample)/给文件路径(worklog_import_sample)。没有素材时不要编造用户文风。'
        const g = (await loadGlobal()) as { learnedAt?: string; corpusCount?: number; logCount?: number; sampleCount?: number; profile?: Record<string, unknown> } | null | undefined
        const lines: string[] = []
        if (g?.learnedAt) {
          lines.push(renderProfile({
            learnedAt: g.learnedAt,
            corpusCount: g.corpusCount ?? 0,
            ...(g.logCount === undefined ? {} : { logCount: g.logCount }),
            ...(g.sampleCount === undefined ? {} : { sampleCount: g.sampleCount }),
            ...(g.profile === undefined ? {} : { profile: g.profile }),
          }))
          lines.push('\n起草时务必逐条对照上面特征写,而不是只参考大意。')
        } else {
          lines.push(`## 文风档案(未学习)\n已有 ${total} 篇素材(日志 ${logDates.length} 篇 + 范文 ${ids.length} 篇)。先调用 worklog_learn_style 学习,或告诉用户「素材够了,可以学习文风了」。`)
        }
        const excerpts: string[] = []
        logDates.slice(0, 2).forEach((key, i) => {
          const rec = logs[key]!
          excerpts.push(`【日志节选 ${i + 1}】${rec.date}\n${truncate(rec.content, 900)}`)
        })
        if (excerpts.length < 2) {
          ids.slice(0, 2 - excerpts.length).forEach((key, i) => {
            excerpts.push(`【范文节选 ${i + 1}】${samples[key]!.label}\n${truncate(samples[key]!.text, 900)}`)
          })
        }
        lines.push(`\n## 素材节选(参考原文)\n${excerpts.join('\n\n')}`)
        lines.push(`\n## 反 AI 味守则(写作时必须遵守)\n${CHECKLIST}`)
        lines.push('\n## 输出要求\n1. 先消化素材再动笔:把每个改动背后的原因和效果想清楚(解决了什么问题、为什么这么做),再用中文自然语言复述;不要转述“改了哪个参数、删了哪个文件”。\n2. 英文标识符做减法:组件名/文件名/参数名翻译成中文说法,只保留品牌、协议、图片格式等专有名词。\n3. 格式、语气、篇幅对齐素材:素材是纯段落就写纯段落,是短句列表就写短句列表。\n4. 内容全部来自 git 事实,不编造工作量。\n5. 只输出日志本身,不要解释写作过程,不要提到“守则/档案”。\n6. 写完后主动问用户要不要调整,并按反馈直接在对话里修改;用户定稿后调用 worklog_save_log 保存。\n7. 写周报/月报时:先写一两句整体进展,再按天或按项目列关键事项;提炼重点而不是拼贴每天的日志,语气用词沿用文风档案;用户配置了模板时,以 worklog_get_template 返回的模板结构为准填写。')
        return lines.join('\n')
      } catch (error) {
        return errText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worklog_save_log',
    description: '把定稿的日志保存到日志库(在「设置 → 工作日志」可查看/编辑)。用户对起草的日志满意后调用;保存的日志之后会作为「学习文风」的素材。',
    parameters: {
      date: { type: 'string', description: '日志日期,格式 YYYY-MM-DD,默认今天' },
      content: { type: 'string', description: '日志全文', required: true },
    },
    output,
    async execute(args) {
      try {
        const date = typeof args.date === 'string' && DATE_RE.test(args.date) ? args.date : localDate()
        const content = typeof args.content === 'string' ? args.content.trim() : ''
        if (content === '') return '✗ content 不能为空。'
        await saveLog(date, content)
        return `✓ 已把 ${date} 的日志存入日志库(设置 → 工作日志 可查看)。之后对「学习文风」时,这篇日志也会作为素材。`
      } catch (error) {
        return errText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worklog_get_template',
    description: '读取用户配置的日报/周报/月报模板。写日报、周报、月报前必须先调用本工具:若用户配置了模板,严格按模板结构填写;未配置则用默认结构。',
    parameters: {
      type: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: '模板类型:daily 日报 / weekly 周报 / monthly 月报,默认 daily' },
    },
    output,
    async execute(args) {
      try {
        const type = templateTypeOf(args.type) ?? 'daily'
        const stored = await loadTemplates()
        const rec = stored[type]
        const label = { daily: '日报', weekly: '周报', monthly: '月报' }[type]
        if (rec === undefined || rec.content.trim() === '') {
          return `用户还没有为${label}配置模板(可在「设置 → 工作日志」里配置,或从工作区 md 文件导入)。按默认结构写:先一两句整体${type === 'daily' ? '工作内容' : '进展'},再分条列出关键事项,每件事写原因和效果,中文消化、英文只留专有名词;文风按文风档案。`
        }
        return [
          `${label}模板如下(用户配置${rec.source === 'file' ? `,来自 ${rec.filePath ?? ''}` : '于设置页'})。严格按模板结构填写:保留章节标题、表格、状态标记和格式,把模板里的占位说明替换成实际内容;正文内容按文风档案与反 AI 味守则写,英文只留专有名词。`,
          '',
          rec.content,
        ].join('\n')
      } catch (error) {
        return errText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worklog_export',
    description: '把日志/报告内容导出为文件:format 支持 md(Markdown)、docx(Word)、pdf。用户说“导出成 Word/PDF/md”时调用;导出已保存日志传 date,导出刚生成的周报/月报传 content。文件默认写入用户配置的导出目录(设置页「导出位置」可改,默认 ~/Documents/工作日志导出)。',
    parameters: {
      format: { type: 'string', enum: ['md', 'docx', 'pdf'], description: '导出格式', required: true },
      date: { type: 'string', description: '要导出的已保存日志日期 YYYY-MM-DD;与 content 二选一' },
      content: { type: 'string', description: '要导出的内容全文(导出刚起草好的周报/月报时传这个);与 date 二选一' },
      outputPath: { type: 'string', description: '可选,输出文件名或相对导出目录的路径,默认 工作日志-<日期>.<ext>' },
    },
    output,
    async execute(args) {
      try {
        const format = args.format === 'docx' || args.format === 'pdf' ? args.format : 'md'
        let text: string
        let label: string
        const given = typeof args.content === 'string' && args.content.trim() !== '' ? args.content : undefined
        if (given !== undefined) {
          text = given
          label = typeof args.date === 'string' && DATE_RE.test(args.date) ? args.date : localDate()
        } else {
          const date = typeof args.date === 'string' && DATE_RE.test(args.date) ? args.date : localDate()
          const logs = await loadLogs()
          const rec = logs[date]
          if (rec === undefined || rec.content.trim() === '') return `✗ ${date} 没有已保存的日志。可以先保存(worklog_save_log)再导出,或直接传 content 导出刚生成的内容。`
          text = rec.content
          label = date
        }
        const bundle = await buildExport(format, label, text)
        const dir = await resolveExportDir()
        const outPath = typeof args.outputPath === 'string' && args.outputPath.trim() !== '' ? args.outputPath.trim() : `工作日志-${label}.${bundle.ext}`
        const abs = outPath.startsWith('/') ? outPath : `${dir}/${outPath}`
        if (bundle.ext === 'md') {
          await writeTextFile(abs, text)
        } else {
          await writeBinaryFile(abs, bundle.bytes)
        }
        return `✓ 已导出 ${format.toUpperCase()} 文件: ${abs}(${bundle.bytes.length} 字节)。导出目录可在「设置 → 工作日志」里改。`
      } catch (error) {
        return errText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worklog_collect_work',
    description: '收集 git 工作记录:工作区未提交/已暂存的改动、指定日期或日期区间的提交(区间模式按天分组)、新增未跟踪文件。写工作日志、周报、月报前必须先调用本工具获取素材。',
    parameters: {
      repoPath: { type: 'string', description: 'git 仓库路径,默认用会话工作区根目录' },
      date: { type: 'string', description: '单日收集:日期 YYYY-MM-DD,默认今天;不要与 startDate/endDate 同时使用' },
      startDate: { type: 'string', description: '区间收集:起始日期 YYYY-MM-DD(含)。与 endDate 一起用,提交按天分组,适合周报/月报' },
      endDate: { type: 'string', description: '区间收集:结束日期 YYYY-MM-DD(含),默认今天;只给 endDate 时默认从 6 天前开始(约一周)' },
      author: { type: 'string', description: '按提交作者过滤,默认用仓库配置的 user.name' },
    },
    output,
    async execute(args) {
      try {
        const shell = ctx.get('shell') as unknown as ShellLike | undefined
        if (shell === undefined) return '✗ shell 服务不可用。'
        const sandboxPolicy = ctx.get('sandboxPolicy') as unknown as { workspaceRoot?: unknown } | undefined
        const root = typeof sandboxPolicy?.workspaceRoot === 'string' ? sandboxPolicy.workspaceRoot.replace(/\/+$/, '') : ''
        const repo = typeof args.repoPath === 'string' && args.repoPath.trim() !== '' ? args.repoPath.trim() : (root !== '' ? root : '.')
        const today = localDate()
        const hasRange = (typeof args.startDate === 'string' && DATE_RE.test(args.startDate)) || (typeof args.endDate === 'string' && DATE_RE.test(args.endDate))
        let rangeStart: string
        let rangeEnd: string
        if (hasRange) {
          rangeEnd = typeof args.endDate === 'string' && DATE_RE.test(args.endDate) ? args.endDate : today
          rangeStart = typeof args.startDate === 'string' && DATE_RE.test(args.startDate) ? args.startDate : minusDays(rangeEnd, 6)
          if (rangeStart > rangeEnd) [rangeStart, rangeEnd] = [rangeEnd, rangeStart]
        } else {
          rangeStart = typeof args.date === 'string' && DATE_RE.test(args.date) ? args.date : today
          rangeEnd = rangeStart
        }
        const isRange = rangeStart !== rangeEnd
        const gitRun = (gitArgs: string[], maxBytes: number): Promise<ShellRunResultLike> => {
          const request = {
            command: `git ${gitArgs.map(shq).join(' ')}`,
            workdir: repo,
            timeoutMs: 30000,
            stdoutMaxBytes: maxBytes,
          }
          return shell.run(shell.resolve(request))
        }
        const check = await gitRun(['rev-parse', '--show-toplevel'], 100000)
        if (check.exitCode !== 0 || check.sandbox?.denied === true) {
          if (check.sandbox?.denied === true) return `✗ git 命令被沙箱拒绝(mode: ${String(check.sandbox.mode)})。如果项目在会话工作区之外,请用该项目目录作为工作区打开会话,或批准放宽沙箱权限后重试。`
          return `✗ ${repo} 不是可用的 git 仓库(git rev-parse 失败)。可以传 repoPath 指定项目目录。`
        }
        const top = check.stdout.text.trim()
        const lines = [`# Git 工作收集 · ${isRange ? `${rangeStart} ~ ${rangeEnd}(周报/月报素材)` : rangeStart}`, `仓库: ${top}`]
        let authorArg = ''
        if (typeof args.author === 'string' && args.author.trim() !== '') authorArg = `--author=${args.author.trim()}`
        else {
          const cfg = await gitRun(['config', 'user.name'], 20000)
          if (cfg.exitCode === 0) {
            const name = cfg.stdout.text.trim()
            if (name !== '') authorArg = `--author=${name}`
          }
        }
        const status = await gitRun(['status', '--porcelain=v1', '--branch'], 100000)
        lines.push('\n## 一、当前工作区未提交的改动')
        lines.push(`\`\`\`\n${status.stdout.text.trim() || '(工作区干净,无未提交改动)'}\n\`\`\``)
        const us = await gitRun(['diff', '--stat'], 80000)
        if (us.stdout.text.trim() !== '') lines.push(`\n### 未暂存 diff 统计\n\`\`\`\n${us.stdout.text.trim()}\n\`\`\``)
        const ud = await gitRun(['diff'], 280000)
        if (ud.stdout.text.trim() !== '') lines.push(`\n### 未暂存 diff 内容\n\`\`\`diff\n${truncate(ud.stdout.text, 24000)}\n\`\`\``)
        const ss = await gitRun(['diff', '--cached', '--stat'], 80000)
        if (ss.stdout.text.trim() !== '') lines.push(`\n### 已暂存 diff 统计\n\`\`\`\n${ss.stdout.text.trim()}\n\`\`\``)
        const sd = await gitRun(['diff', '--cached'], 280000)
        if (sd.stdout.text.trim() !== '') lines.push(`\n### 已暂存 diff 内容\n\`\`\`diff\n${truncate(sd.stdout.text, 24000)}\n\`\`\``)
        const logArgs = ['log', `--since=${rangeStart} 00:00:00`, `--until=${rangeEnd} 23:59:59`, '--date=format:%Y-%m-%d %H:%M', '--pretty=format:%h%x01%an%x01%ad%x01%s']
        if (authorArg !== '') logArgs.push(authorArg)
        const logRes = await gitRun(logArgs, 200000)
        const parts = logRes.stdout.text.split('\u0001')
        const commits: Array<{ hash: string; author: string; time: string; subject: string }> = []
        for (let i = 0; i + 3 < parts.length; i += 4) {
          if (commits.length >= 60) break
          commits.push({ hash: parts[i]!, author: parts[i + 1]!, time: parts[i + 2]!, subject: parts[i + 3]! })
        }
        if (commits.length === 0) {
          lines.push(`\n## 二、${isRange ? '区间内的' : '当天的'} git 提交\n(没有提交记录)`)
        } else if (isRange) {
          const total = Math.floor(parts.length / 4)
          lines.push(`\n## 二、${rangeStart} ~ ${rangeEnd} 的 git 提交(共 ${total} 条${total > commits.length ? `,下面展示前 ${commits.length} 条` : ''},按天分组)`)
          const byDay = new Map<string, typeof commits>()
          for (const c of commits) {
            const day = c.time.slice(0, 10)
            const bucket = byDay.get(day)
            if (bucket === undefined) byDay.set(day, [c])
            else bucket.push(c)
          }
          let statBudget = 120000
          for (const [day, bucket] of byDay) {
            lines.push(`\n### ${day}(${bucket.length} 条)`)
            for (const c of bucket) {
              lines.push(`- ${c.hash} ${c.time.slice(11)} ${c.subject}`)
              if (statBudget > 0) {
                const st = await gitRun(['show', '--stat', '--oneline', c.hash], 60000)
                if (st.stdout.text.trim() !== '') {
                  lines.push(`\`\`\`\n${truncate(st.stdout.text, 1500)}\n\`\`\``)
                  statBudget -= Math.min(st.stdout.text.length, 1500)
                }
              } else {
                lines.push('(变更统计已省略,总量超预算)')
              }
            }
          }
          lines.push('\n(需要某天更详细的 diff 时,可以再针对单个提交 hash 跑 git show 补充。)')
        } else {
          const total = Math.floor(parts.length / 4)
          lines.push(`\n## 二、${rangeStart} 的 git 提交(共 ${total} 条${total > commits.length ? `,下面展示前 ${commits.length} 条` : ''})`)
          let budget = 300000
          for (const c of commits) {
            lines.push(`\n### 提交 ${c.hash} · ${c.author} · ${c.time}\n> ${c.subject}`)
            const st = await gitRun(['show', '--stat', '--oneline', c.hash], 60000)
            if (st.stdout.text.trim() !== '') lines.push(`\`\`\`\n${truncate(st.stdout.text, 3000)}\n\`\`\``)
            if (budget > 0) {
              const df = await gitRun(['show', '--format=', c.hash], 90000)
              const diffText = df.stdout.text.trim()
              if (diffText !== '') {
                lines.push(`\`\`\`diff\n${truncate(diffText, budget)}\n\`\`\``)
                budget -= Math.min(diffText.length, budget)
              } else {
                lines.push('(无 diff,可能是合并提交或空提交)')
              }
            } else {
              lines.push('(diff 已省略,总量超预算)')
            }
          }
        }
        const untracked = status.stdout.text.split('\n').filter(line => line.startsWith('?? ')).map(line => line.slice(3))
        if (untracked.length > 0) lines.push(`\n## 三、新增未跟踪文件\n${untracked.slice(0, 50).map(f => `- ${f}`).join('\n')}${untracked.length > 50 ? `\n…共 ${untracked.length} 个` : ''}`)
        if (isRange) {
          lines.push('\n---\n下一步:调用 worklog_get_style 读取文风档案。按周报/月报的结构总结:先写一两句整体进展,再按天(或按项目)列出关键事项;每件事写原因和效果,中文消化、英文只留专有名词;不要简单拼贴每天的日志,要提炼重点。')
        } else {
          lines.push('\n---\n下一步:调用 worklog_get_style 读取文风档案。起草前先消化这些改动——每个改动解决了什么问题、为什么这么做,再用中文自然语言描述(英文只保留专有名词),按档案措辞与格式起草今日日志,在对话里输出,并响应用户的修改意见。')
        }
        return lines.join('\n')
      } catch (error) {
        return errText(error)
      }
    },
  }))

  // ── skill + system-prompt section ──────────────────────────────────────
  const skills = ctx.get('skills') as unknown as SkillsLike | undefined
  skills?.register({
    name: 'worklog-writing',
    description: '根据 git 提交与未提交改动起草今日工作日志,按用户已学习的文风档案写作并遵守反 AI 味守则,在对话中迭代修改。',
    whenToUse: '用户要求写工作日志/日报/今日总结、保存旧日志范文、学习文风或调整日志措辞时。',
    source: 'runtime',
    content: SKILL_CONTENT,
  })
  const systemPrompt = ctx.get('systemPrompt') as unknown as SystemPromptLike | undefined
  systemPrompt?.section({ name: 'worklog-style', order: 400, text: PROMPT_SECTION_TEXT })
}
