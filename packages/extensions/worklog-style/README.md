# @deepseek-ai/dsh-worklog-style

工作日志文风助手:基于 git 改动起草每日工作日志,学习并模仿用户自己的写作风格,内置反 AI 味写作守则,并提供一个「工作日志」设置页用于编写、提交和浏览历史日志。

## 功能

- **git 素材收集**(`worklog_collect_work`):工作区未提交/已暂存改动与 diff、指定日期的 git 提交及逐条 diff、新增未跟踪文件。
- **文风库**(`worklog_save_sample` / `worklog_import_sample` / `worklog_list_style` / `worklog_remove_sample`):保存用户以前写的日志范文(粘贴或给文件路径)。
- **文风学习**(`worklog_learn_style`):调用模型分析全部范文,提炼结构、常用词、语气词频率、内容描述方式、句式、习惯表达与禁忌写法,保存为文风档案。
- **文风读取**(`worklog_get_style`):起草前必读,返回文风档案 + 范文节选 + 反 AI 味守则。
- **内置技能** `worklog-writing`:完整工作流 + 反 AI 味守则,注册进技能目录。
- **设置页「工作日志」**:浏览器设置面板中的独立页面,可编写/提交当日日志、编辑/删除历史日志、查看文风库状态(数据经 `/worklog` JSON RPC 与宿主半边通信)。
- 起草与迭代全程在对话框内完成:用户不满意就提修改意见,agent 按文风档案改到满意,再贴进设置页保存。

## 数据存储

所有数据存于宿主 storage 单元 `worklog_style`(JSON 后端,默认 `$DSH_HOME/storages/worklog_style.json`),跨工作区、跨会话、跨重启持久:

- `logs` 表:按 `YYYY-MM-DD` 键存的每日日志
- `samples` 表:文风范文
- global 单例:文风档案

## 安装(本仓库内)

1. 构建本包:

   ```bash
   cd packages/extensions/worklog-style
   ../../../node_modules/.bin/tsc -p tsconfig.json --noEmitOnError
   ../../../node_modules/.bin/tsdown
   ```

2. 在目标 profile 的组合补丁(如 `$DSH_HOME/profiles/web/cordis.patch.yml`)中加入:

   ```yaml
   - insert:
       - id: worklog-style
         name: '@deepseek-ai/dsh-worklog-style'
   ```

3. 把本包加为 profile 的依赖并在 profile 目录 `pnpm install`(或直接建
   `node_modules/@deepseek-ai/dsh-worklog-style` 符号链接指向本包)。

4. 重启 `dsh web`。插件随进程自动加载;移除上述补丁行(或删除依赖)即卸载。

## 分享给他人

把本包发布到 npm(发布前可改名,如 `@your-scope/dsh-worklog-style`),对方只需:

```bash
cd $DSH_HOME/profiles/web
pnpm add @your-scope/dsh-worklog-style
```

并按其 profile 的 `cordis.patch.yml` 加入上面的 `insert` 行,重启即用。注意 `/worklog` 路由仅允许 loopback(localhost/127.0.0.1)访问,与 Web GUI 的本机使用方式一致。

## 注意事项

- 若用户的项目目录不是会话工作区,写日志时请在对话里说明项目路径(传给 `repoPath`),或直接用项目目录作为工作区打开会话。
- 文风档案越早学习效果越好:先保存 1–3 篇以前的真实日志,再让 agent「学习文风」。
