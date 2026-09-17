/**
 * First-use guide: a sidebar-foot button above Settings plus a frame-wide
 * modal. The modal pops automatically on the first visit (guideSeen config
 * is false) and stays available via the button afterwards.
 */

import React, { useEffect, useSyncExternalStore } from 'react'
import styles from './guide.module.css'
import { createGuideStore } from './guide-store.ts'

const store = createGuideStore()

async function rpc<T>(endpoint: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`/worklog/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

function GuideContent(): React.ReactElement {
  return (
    <div className={styles.body}>
      <ul className={styles.list}>
        <li>插件设置页在左下角「设置」→「工作日志」:编写/提交日志、查看历史、配置日报/周报/月报模板、设置导出目录都在那里。</li>
        <li>
          在对话里对 agent 说:
          <ul className={styles.sublist}>
            <li>「写今天的日志」→ 按 git 改动起草日报</li>
            <li>「写这周的周报」/「写这个月的月报」→ 收集区间提交,套用模板</li>
            <li>「学习文风」→ 基于已保存日志和范文生成文风档案</li>
            <li>「导出成 Word/PDF/md」→ 导出到配置的目录</li>
            <li>粘贴旧日志并说「存成范文」→ 扩充文风素材</li>
          </ul>
        </li>
        <li>日志由 agent 起草,不满意直接在对话里说修改意见(太短/太正式/换说法);定稿后可以让它保存,或贴到设置页保存。</li>
      </ul>
    </div>
  )
}

/** Sidebar-foot action: opens the guide modal; first mount auto-pops it. */
export function GuideFooterButton(props: { wide: boolean }): React.ReactElement {
  useEffect(() => {
    void rpc<{ guideSeen?: boolean }>('get-config')
      .then(result => {
        if (result.guideSeen !== true) {
          store.set(true)
          void rpc<{ ok?: boolean }>('save-config', { guideSeen: true }).catch(() => {})
        }
      })
      .catch(() => {})
  }, [])

  return (
    <button
      type="button"
      className={styles.footerBtn}
      title="工作日志插件使用指引"
      onClick={() => store.set(true)}
    >
      {props.wide ? '工作日志指引' : '?'}
    </button>
  )
}

/** shell.overlay entry: the guide modal, click-through when closed. */
export function GuideOverlay(): React.ReactElement {
  const open = useSyncExternalStore(store.subscribe, store.get)
  if (!open) return <></>
  return (
    <div
      className={styles.backdrop}
      onClick={() => store.set(false)}
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        onClick={event => event.stopPropagation()}
      >
        <div className={styles.head}>
          <span className={styles.title}>工作日志插件 · 使用指引</span>
          <button type="button" className={styles.close} title="关闭" onClick={() => store.set(false)}>×</button>
        </div>
        <GuideContent />
        <div className={styles.foot}>
          <button type="button" className={styles.ok} onClick={() => store.set(false)}>知道了</button>
        </div>
      </div>
    </div>
  )
}
