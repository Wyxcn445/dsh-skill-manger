# dsh-skill-manager

在 DeepSeek Harness 的「设置」里集中管理本地 Skills：**浏览、编辑、新建、删除、启停**全局 skill（`~/.dsh/skills`）与项目 skill（`<项目>/.dsh/skills`）。

## 功能

- **双来源合并**：同时展示全局根与当前项目的 skill，按 DSH 的优先级规则合并同名条目。
- **无损编辑**：直接编辑 `SKILL.md` 全文（frontmatter + 正文），保存时原样写回，不做 YAML 重排。
- **两个开关**：模型可调用（`disable-model-invocation`）、用户可调用（`user-invocable`），点击即时写盘。
- **新建骨架**：在任意扫描根下生成 `<name>/SKILL.md`，自动带好合法 frontmatter。
- **删除有备份**：删除前把整个目录/文件复制到 `~/.dsh/skill-manager-backups/<时间戳>/`。
- **诊断提示**：name 不是 kebab-case、缺 description、调用开关取值非法等会被标出来（这些正是 DSH 静默跳过 skill 的原因）。
- **自定义根**：额外扫描任意目录，配置存于 `~/.dsh/skill-manager-config.json`。

## 扫描根与优先级

与 `@deepseek-ai/dsh-skill-filesystem` 保持一致，rank 小者优先：

| rank | 来源 | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<项目>/.dsh/skills` |
| 200 | `project-agents` | `<项目>/.agents/skills` |
| 300 | `custom` | 面板里配置的自定义目录 |
| 400 | `user-dsh` | `~/.dsh/skills` |
| 500 | `user-agents` | `~/.agents/skills` |

「项目根」取最近的含 `.git` 的祖先目录；没有 `.git` 时用你填写的目录本身。

## skill 格式

目录型 `<name>/SKILL.md` 或单文件 `<name>.md`，只认扫描根下的一层。frontmatter 示例：

```yaml
---
name: my-skill
description: Use when the user asks to …
whenToUse: 可选，补充触发场景
disable-model-invocation: true   # 可选，阻止模型看到它
user-invocable: false            # 可选，阻止 /my-skill 手动调用
---
```

`name` 必须是小写 kebab-case，`description` 必填，否则 DSH 会跳过该 skill。

## 安装

在 DSH 里用 `plugin_manager` 安装（`target` 填本目录绝对路径）：

```
action: install_bundle
target: C:\Users\32474\Desktop\开源项目\dsh-skill-manager
```

安装后打开 **设置 → Skill 管理**（在「规则管理」下面）。

> 本地目录安装是 **link** 到本目录，不是拷贝。移动或删除本目录会让插件失效，需要重新安装。

## 使用

1. 顶部「项目」框填入要扫描的项目路径（默认取第一个工作区），留空则只扫描全局 skill。
2. 左侧列表点选 skill，右侧即可编辑 `SKILL.md` 全文，`Ctrl+S` 保存。
3. 卡片上的「模型 / 用户」两个胶囊开关可即时启停，无需手动改 frontmatter。
4. 「＋ 新建 skill」会在选定的根下生成 `<name>/SKILL.md` 骨架。
5. 「删除」会先整份备份到 `~/.dsh/skill-manager-backups/<时间戳>/`。

## HTTP 路由

Host 半注册以下路由（同源 POST 才允许写入）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/skill-manager/state` | 扫描根、工作区、配置、默认项目 |
| GET | `/skill-manager/skills?project=` | 列出全部 skill 及每个根的状态 |
| GET | `/skill-manager/file?path=&project=` | 读取单个 skill 原文 |
| POST | `/skill-manager/file` | 保存原文 `{ path, content }` |
| POST | `/skill-manager/create` | 新建 `{ rootId, project, name, description, whenToUse, modelInvocable, userInvocable }` |
| POST | `/skill-manager/toggle` | 开关 `{ path, project, modelInvocable?, userInvocable? }` |
| POST | `/skill-manager/delete` | 删除 `{ path, project }` |
| GET/POST | `/skill-manager/config` | 读写 `customSkillDirs` |
| GET | `/skill-manager/backups` | 列出删除备份 |

所有文件读写都限制在已解析的扫描根内，且只接受 `.md` 文件。

## 生效时机

`dsh-skill-filesystem` 会 watch 这些根，编辑保存后新 skill / 改名 / 删除会在下一步被感知；若该 provider 未启用，重启 `dsh web` 后生效。

## 已知限制

- 只认扫描根下的一层（`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`），不递归子目录。
- frontmatter 解析实现了 YAML 子集（标量与 `|`/`>` 块标量）；`metadata` 等嵌套结构只展示不编辑。
- 项目切换依赖你填写的路径；DSH 内部会话 cwd 与它不一致时，项目根以面板里的路径为准。

## License

MIT © Wyxcn445
