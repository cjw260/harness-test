/**
 * The「工作日志」settings section component: write and submit the daily log,
 * browse/edit/delete saved logs, manage daily/weekly/monthly report templates
 * (inline editing or importing a workspace .md file), and see the
 * writing-style library status. Data rides the host half's `/worklog` JSON
 * RPC route (plain same-origin fetch).
 */

import React, { useEffect, useState } from 'react'
import styles from './worklog.module.css'

interface LogEntry {
  date: string
  updatedAt: string
  preview: string
}

interface StyleStatus {
  sampleCount: number
  logCount: number
  profile: { learnedAt: string; corpusCount: number } | null
}

interface TemplateInfo {
  type: 'daily' | 'weekly' | 'monthly'
  content: string
  source: string
  filePath?: string
  updatedAt: string
}

type TemplateType = 'daily' | 'weekly' | 'monthly'

const TEMPLATE_LABELS: Record<TemplateType, string> = {
  daily: '日报',
  weekly: '周报',
  monthly: '月报',
}

async function rpc<T>(endpoint: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`/worklog/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

function today(): string {
  const d = new Date()
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function WorklogSection(props: { pickDirectory: () => Promise<string | null> }): React.ReactElement {
  const { pickDirectory } = props
  const [logs, setLogs] = useState<LogEntry[] | null>(null)
  const [date, setDate] = useState(today())
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [styleInfo, setStyleInfo] = useState<StyleStatus | null>(null)
  const [templates, setTemplates] = useState<Record<string, TemplateInfo> | null>(null)
  const [tplType, setTplType] = useState<TemplateType>('daily')
  const [tplDraft, setTplDraft] = useState('')
  const [tplPath, setTplPath] = useState('')
  const [tplMsg, setTplMsg] = useState('')
  const [exportFmt, setExportFmt] = useState<'md' | 'docx' | 'pdf'>('md')
  const [exportMsg, setExportMsg] = useState('')
  const [exportDir, setExportDir] = useState('')
  const [cfgMsg, setCfgMsg] = useState('')
  const [showManual, setShowManual] = useState(false)

  const refresh = (): void => {
    void rpc<{ logs: LogEntry[] }>('list-logs')
      .then(result => setLogs(result.logs))
      .catch(() => setLogs([]))
    void rpc<StyleStatus>('style-status')
      .then(result => setStyleInfo(result))
      .catch(() => {})
    void rpc<{ templates: TemplateInfo[] }>('list-templates')
      .then(result => {
        const map: Record<string, TemplateInfo> = {}
        for (const t of result.templates) map[t.type] = t
        setTemplates(map)
      })
      .catch(() => setTemplates({}))
    void rpc<{ exportDir?: string }>('get-config')
      .then(result => setExportDir(result.exportDir ?? ''))
      .catch(() => {})
  }

  useEffect(refresh, [])

  const switchTplType = (next: TemplateType): void => {
    setTplType(next)
    setTplMsg('')
    setTplDraft(templates?.[next]?.content ?? '')
  }

  const saveTpl = (): void => {
    void rpc<{ error?: string; ok?: boolean; updatedAt?: string }>('save-template', { type: tplType, content: tplDraft })
      .then(result => {
        if (result.error !== undefined) {
          setTplMsg(result.error)
          return
        }
        const map = { ...(templates ?? {}) }
        map[tplType] = {
          type: tplType,
          content: tplDraft,
          source: 'inline',
          updatedAt: result.updatedAt ?? '',
        }
        setTemplates(map)
        setTplMsg(`${TEMPLATE_LABELS[tplType]}模板已保存`)
      })
      .catch((error: unknown) => {
        setTplMsg(`保存失败: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  const importTpl = (): void => {
    void rpc<{ error?: string; ok?: boolean; content?: string; updatedAt?: string }>('import-template', { type: tplType, filePath: tplPath })
      .then(result => {
        if (result.error !== undefined) {
          setTplMsg(result.error)
          return
        }
        const map = { ...(templates ?? {}) }
        map[tplType] = {
          type: tplType,
          content: result.content ?? '',
          source: 'file',
          filePath: tplPath,
          updatedAt: result.updatedAt ?? '',
        }
        setTemplates(map)
        setTplDraft(result.content ?? '')
        setTplMsg(`已从 ${tplPath} 导入${TEMPLATE_LABELS[tplType]}模板`)
      })
      .catch((error: unknown) => {
        setTplMsg(`导入失败: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  const doExport = (): void => {
    if (content.trim() === '') {
      setExportMsg('先写点内容再导出')
      return
    }
    setExportMsg('导出中…')
    void rpc<{ error?: string; base64?: string; fileName?: string; mime?: string }>('export-file', { format: exportFmt, content, date })
      .then(result => {
        if (result.error !== undefined) {
          setExportMsg(result.error)
          return
        }
        if (result.base64 === undefined || result.fileName === undefined) {
          setExportMsg('导出失败:响应缺少文件数据')
          return
        }
        const bin = atob(result.base64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const blob = new Blob([bytes], { type: result.mime ?? 'application/octet-stream' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = result.fileName
        anchor.click()
        URL.revokeObjectURL(url)
        setExportMsg(`已导出 ${result.fileName}`)
      })
      .catch((error: unknown) => {
        setExportMsg(`导出失败: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  const saveCfg = (): void => {
    void rpc<{ error?: string; exportDir?: string; resolved?: string }>('save-config', { exportDir })
      .then(result => {
        if (result.error !== undefined) {
          setCfgMsg(result.error)
          return
        }
        setExportDir(result.exportDir ?? '')
        setCfgMsg(result.resolved !== undefined && result.resolved !== ''
          ? `已保存,导出目录: ${result.resolved}`
          : '已保存,留空时使用默认目录(~/Documents/工作日志导出)')
      })
      .catch((error: unknown) => {
        setCfgMsg(`保存失败: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  const pickAndSave = (): void => {
    setCfgMsg('正在打开目录选择器…')
    void pickDirectory()
      .then(async path => {
        if (path === null) {
          setCfgMsg('已取消选择')
          return
        }
        setExportDir(path)
        const res = await rpc<{ error?: string; resolved?: string }>('save-config', { exportDir: path })
        if (res.error !== undefined) {
          setCfgMsg(res.error)
          setShowManual(true)
        } else {
          setCfgMsg(`已保存,导出目录: ${res.resolved ?? path}`)
        }
      })
      .catch((error: unknown) => {
        setCfgMsg(`目录选择器不可用: ${error instanceof Error ? error.message : String(error)},可在下方手动输入路径`)
        setShowManual(true)
      })
  }

  const openLog = (d: string): void => {
    setBusy(true)
    setMsg('')
    void rpc<{ date?: string; content?: string; error?: string }>('get-log', { date: d })
      .then(result => {
        setDate(result.date ?? d)
        setContent(typeof result.content === 'string' ? result.content : '')
        setBusy(false)
      })
      .catch((error: unknown) => {
        setMsg(`读取失败: ${error instanceof Error ? error.message : String(error)}`)
        setBusy(false)
      })
  }

  const save = (): void => {
    if (!DATE_RE.test(date)) {
      setMsg('日期格式应为 YYYY-MM-DD')
      return
    }
    setBusy(true)
    setMsg('')
    void rpc<{ error?: string; date?: string }>('save-log', { date, content })
      .then(result => {
        if (result.error !== undefined) setMsg(result.error)
        else {
          setMsg(`已保存 ${result.date ?? date}`)
          refresh()
        }
        setBusy(false)
      })
      .catch((error: unknown) => {
        setMsg(`保存失败: ${error instanceof Error ? error.message : String(error)}`)
        setBusy(false)
      })
  }

  const del = (d: string): void => {
    void rpc<{ ok?: boolean }>('delete-log', { date: d })
      .then(() => {
        setMsg(`已删除 ${d}`)
        if (date === d) setContent('')
        refresh()
      })
      .catch((error: unknown) => {
        setMsg(`删除失败: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  let rows: React.ReactNode
  if (logs === null) {
    rows = <div className={styles.msg}>加载中…</div>
  } else if (logs.length === 0) {
    rows = <div className={styles.msg}>还没有保存过日志。在对话里让 agent 按你的文风起草,改到满意后贴到这里保存即可。</div>
  } else {
    rows = (
      <ul className={styles.list}>
        {logs.map(log => (
          <li key={log.date} className={styles.item}>
            <span className={styles.itemDate}>{log.date}</span>
            <span className={styles.itemPreview}>{log.preview}</span>
            <button type="button" className={styles.mini} onClick={() => openLog(log.date)}>编辑</button>
            <button type="button" className={styles.mini} onClick={() => del(log.date)}>删除</button>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.title}>工作日志</div>
      <div className={styles.sub}>在这里编写并提交每天的日志。平时在对话里让 agent 按你的文风起草,改到满意后贴到这里保存即可。</div>
      <div className={styles.row}>
        <input
          className={styles.date}
          type="date"
          value={date}
          onChange={event => setDate(event.target.value)}
        />
        <button type="button" className={styles.btn} disabled={busy} onClick={save}>
          {busy ? '保存中…' : '保存日志'}
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPlain}`}
          disabled={busy}
          onClick={() => {
            setDate(today())
            setContent('')
            setMsg('')
          }}
        >
          新建
        </button>
      </div>
      <textarea
        className={styles.text}
        value={content}
        onChange={event => setContent(event.target.value)}
        placeholder="今天做了什么:还原了哪些页面、改了什么 bug、踩了什么坑……"
      />
      <div className={styles.row}>
        <span className={styles.sub}>导出当前内容:</span>
        <select
          className={styles.date}
          value={exportFmt}
          onChange={event => setExportFmt(event.target.value as 'md' | 'docx' | 'pdf')}
        >
          <option value="md">Markdown (.md)</option>
          <option value="docx">Word (.docx)</option>
          <option value="pdf">PDF</option>
        </select>
        <button type="button" className={styles.mini} disabled={busy} onClick={doExport}>导出</button>
        {exportMsg !== '' ? <span className={styles.msg}>{exportMsg}</span> : null}
      </div>
      <div className={styles.row}>
        <span className={styles.sub}>导出位置(对话里导出的文件存放目录):</span>
        <button type="button" className={styles.btn} onClick={pickAndSave}>选择文件夹…</button>
        <span className={styles.msg}>{exportDir !== '' ? exportDir : '未设置(默认 ~/Documents/工作日志导出)'}</span>
      </div>
      {showManual ? (
        <div className={styles.row}>
          <input
            className={styles.date}
            value={exportDir}
            onChange={event => setExportDir(event.target.value)}
            placeholder="手动输入目录路径,如 ~/Documents/工作日志导出"
          />
          <button type="button" className={styles.mini} onClick={saveCfg}>保存</button>
        </div>
      ) : null}
      {cfgMsg !== '' ? <div className={styles.msg}>{cfgMsg}</div> : null}
      <div className={styles.msg}>提示:导出到工作区以外的目录需要 Full access 权限;若权限不足,请导出到当前工作区目录后手动移动。</div>
      {msg !== '' ? <div className={styles.msg}>{msg}</div> : null}
      <div className={styles.sub}>历史日志</div>
      {rows}
      <div className={styles.sub}>日报 / 周报 / 月报模板(起草报告时会自动套用)</div>
      <div className={styles.row}>
        <select
          className={styles.date}
          value={tplType}
          onChange={event => switchTplType(event.target.value as TemplateType)}
        >
          <option value="daily">日报</option>
          <option value="weekly">周报</option>
          <option value="monthly">月报</option>
        </select>
        <button type="button" className={styles.mini} onClick={saveTpl}>保存模板</button>
      </div>
      <textarea
        className={styles.tplText}
        value={tplDraft}
        onChange={event => setTplDraft(event.target.value)}
        placeholder="在这里编辑模板,或从工作区的 md 文件导入…"
      />
      <div className={styles.row}>
        <input
          className={styles.date}
          value={tplPath}
          onChange={event => setTplPath(event.target.value)}
          placeholder="如 月报模板.md(相对工作区)"
        />
        <button type="button" className={styles.mini} onClick={importTpl}>从 md 文件导入</button>
      </div>
      {tplMsg !== '' ? <div className={styles.msg}>{tplMsg}</div> : null}
      {styleInfo !== null ? (
        <div className={styles.sub}>
          文风素材:已保存日志 {styleInfo.logCount} 篇 · 范文 {styleInfo.sampleCount} 篇
          {styleInfo.profile !== null
            ? `,文风档案已学习(${styleInfo.profile.learnedAt.slice(0, 10)},基于 ${styleInfo.profile.corpusCount} 篇素材)`
            : ',档案未学习(在对话里说「学习文风」)'}
        </div>
      ) : null}
    </div>
  )
}
