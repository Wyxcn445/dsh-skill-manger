// dsh-skill-manager client bundle：在 设置 中注册「Skill 管理」页。
//
// 功能：
//   1) 选择项目（工作区）后同时显示全局 skill（~/.dsh/skills）与该项目的 skill；
//   2) 每个 skill 可即时启停「模型可调用 / 用户可调用」两个开关；
//   3) 无损编辑 SKILL.md 全文（frontmatter + 正文原样保存）；
//   4) 在任意扫描根下新建 skill 骨架；
//   5) 删除前自动整份备份（Host 端负责）。
//
// 手写 __ModuleLoader__ 工厂，无构建步骤；唯一外部依赖是 loader 模块表里的 react。
window.__ModuleLoader__.load({
	id: "dsh-skill-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useMemo, useRef } = react;

		// ───────────────────────────────────────────────── 样式

		const FONT = "inherit";

		const BORDER = "1px solid rgba(128, 128, 128, 0.28)";
		const BORDER_SOFT = "1px solid rgba(128, 128, 128, 0.18)";
		const SURFACE = "rgba(128, 128, 128, 0.07)";
		const SURFACE_HOVER = "rgba(128, 128, 128, 0.13)";

		const BUTTON = {
			padding: "6px 14px",
			borderRadius: "6px",
			border: BORDER,
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
			fontFamily: FONT,
			fontSize: "13px",
			lineHeight: 1.4,
		};

		const BUTTON_PRIMARY = Object.assign({}, BUTTON, {
			background: "rgba(59, 110, 245, 0.92)",
			border: "1px solid rgba(59, 110, 245, 0.92)",
			color: "#ffffff",
		});

		const BUTTON_DANGER = Object.assign({}, BUTTON, {
			background: "rgba(229, 72, 77, 0.92)",
			border: "1px solid rgba(229, 72, 77, 0.92)",
			color: "#ffffff",
		});

		const INPUT = {
			padding: "6px 10px",
			borderRadius: "6px",
			border: BORDER,
			background: "transparent",
			color: "inherit",
			fontFamily: FONT,
			fontSize: "13px",
			boxSizing: "border-box",
		};

		const TEXTAREA = Object.assign({}, INPUT, {
			width: "100%",
			minHeight: "340px",
			fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
			fontSize: "13px",
			lineHeight: 1.55,
			padding: "10px 12px",
			resize: "vertical",
		});

		const ROW = {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			flexWrap: "wrap",
		};

		const MUTED = { fontSize: "12px", opacity: 0.62 };

		const MONO = {
			fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
			fontSize: "11.5px",
		};

		// ───────────────────────────────────────────────── 小工具

		function requestJson(path, init) {
			return fetch(path, Object.assign({ cache: "no-store" }, init)).then((response) => {
				if (response.ok) {
					return response.json().catch(() => ({}));
				}
				return response
					.json()
					.catch(() => ({ error: "HTTP " + response.status }))
					.then((payload) => {
						throw new Error(payload && payload.error ? payload.error : "HTTP " + response.status);
					});
			});
		}

		function postJson(path, body) {
			return requestJson(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		}

		/** 选中项的读取地址：带上 project，才能覆盖非首个工作区的项目根。 */
		function fileUrl(path, projectPath) {
			let url = "/skill-manager/file?path=" + encodeURIComponent(path);
			if (projectPath) url += "&project=" + encodeURIComponent(projectPath);
			return url;
		}

		/** 根目录的展示名。 */
		function rootLabel(root) {
			switch (root.id) {
				case "project-dsh":
					return "项目 .dsh/skills";
				case "project-agents":
					return "项目 .agents/skills";
				case "user-dsh":
					return "全局 ~/.dsh/skills";
				case "user-agents":
					return "全局 ~/.agents/skills";
				default:
					return root.scope === "custom" ? "自定义目录" : String(root.id);
			}
		}

		/** 来源徽标文案与配色。 */
		function sourceBadge(skill) {
			if (skill.scope === "project") {
				return { text: "项目", color: "#22c55e" };
			}
			if (skill.scope === "custom") {
				return { text: "自定义", color: "#f59e0b" };
			}
			return { text: "全局", color: "#3b6ef5" };
		}

		function formatBytes(bytes) {
			if (typeof bytes !== "number" || bytes < 0) return "";
			if (bytes < 1024) return bytes + " B";
			if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
			return (bytes / 1024 / 1024).toFixed(2) + " MiB";
		}

		/** 最后修改时间做成本地可读短格式。 */
		function formatTime(iso) {
			if (typeof iso !== "string" || iso === "") return "";
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return "";
			const pad = (value) => String(value).padStart(2, "0");
			return (
				date.getFullYear() +
				"-" +
				pad(date.getMonth() + 1) +
				"-" +
				pad(date.getDate()) +
				" " +
				pad(date.getHours()) +
				":" +
				pad(date.getMinutes())
			);
		}

		// ───────────────────────────────────────────────── 原子组件

		/** 胶囊开关。 */
		function Toggle(props) {
			const { checked, onChange, disabled, title } = props;
			const on = checked === true;
			return h(
				"button",
				{
					type: "button",
					title: title || "",
					disabled: disabled === true,
					onClick: (event) => {
						event.stopPropagation();
						if (disabled !== true && typeof onChange === "function") onChange(!on);
					},
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: "6px",
						padding: "3px 9px 3px 4px",
						borderRadius: "999px",
						border: BORDER_SOFT,
						background: on ? "rgba(34, 197, 94, 0.16)" : "transparent",
						color: "inherit",
						cursor: disabled === true ? "default" : "pointer",
						opacity: disabled === true ? 0.55 : 1,
						fontFamily: FONT,
						fontSize: "11.5px",
						lineHeight: 1.3,
					},
				},
				h("span", {
					style: {
						display: "inline-block",
						width: "20px",
						height: "12px",
						borderRadius: "999px",
						background: on ? "#22c55e" : "rgba(128, 128, 128, 0.45)",
						position: "relative",
						transition: "background 120ms ease",
						flex: "0 0 auto",
					},
				}, h("span", {
					style: {
						position: "absolute",
						top: "2px",
						left: on ? "10px" : "2px",
						width: "8px",
						height: "8px",
						borderRadius: "999px",
						background: "#ffffff",
						transition: "left 120ms ease",
					},
				})),
				h("span", null, props.label),
			);
		}

		function Badge(props) {
			return h(
				"span",
				{
					style: {
						display: "inline-block",
						padding: "1px 7px",
						borderRadius: "999px",
						fontSize: "11px",
						lineHeight: 1.6,
						color: props.color,
						border: "1px solid " + props.color,
						opacity: 0.9,
						whiteSpace: "nowrap",
					},
				},
				props.text,
			);
		}

		function Notice(props) {
			const notice = props.notice;
			if (!notice || notice.kind === "idle") return null;
			const color = notice.kind === "error" ? "#e5484d" : "#22c55e";
			return h(
				"div",
				{
					style: {
						marginTop: "10px",
						padding: "7px 11px",
						borderRadius: "6px",
						border: "1px solid " + color,
						background: notice.kind === "error" ? "rgba(229, 72, 77, 0.10)" : "rgba(34, 197, 94, 0.10)",
						fontSize: "12.5px",
						lineHeight: 1.5,
					},
				},
				notice.text,
			);
		}

		// ───────────────────────────────────────────────── 主面板

		function SkillSection() {
			// 总览状态（根、工作区、配置）
			const [state, setState] = useState(null);
			// skill 列表响应
			const [data, setData] = useState(null);
			// 当前项目路径（空 = 仅全局）
			const [project, setProject] = useState("");
			// 选中的 skill 文件绝对路径
			const [selectedPath, setSelectedPath] = useState("");
			// 编辑器里的全文
			const [draft, setDraft] = useState("");
			// 编辑器基准（用于判断是否改动）
			const [savedDraft, setSavedDraft] = useState("");
			// 视图模式：view（详情编辑）| create（新建）
			const [mode, setMode] = useState("view");
			const [loading, setLoading] = useState(false);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const [query, setQuery] = useState("");
			const [scopeFilter, setScopeFilter] = useState("all");
			const [onlyDisabled, setOnlyDisabled] = useState(false);
			const [confirmDelete, setConfirmDelete] = useState(false);
			const [showConfig, setShowConfig] = useState(false);
			const [configText, setConfigText] = useState("");

			// 新建表单
			const [createForm, setCreateForm] = useState({
				rootId: "user-dsh",
				name: "",
				description: "",
				whenToUse: "",
				modelInvocable: true,
				userInvocable: true,
			});

			// 记录上一次触发扫描的 project，避免初次加载后重复拉取列表
			const projectRef = useRef("");

			const noticeTimer = useRef(null);
			const flash = useCallback((kind, text) => {
				setNotice({ kind, text });
				if (noticeTimer.current) clearTimeout(noticeTimer.current);
				noticeTimer.current = setTimeout(() => setNotice({ kind: "idle", text: "" }), 6000);
			}, []);
			useEffect(() => () => {
				if (noticeTimer.current) clearTimeout(noticeTimer.current);
			}, []);

			// ── 拉取列表 ─────────────────────────────────────────────
			const loadSkills = useCallback((projectPath, keepSelection) => {
				setLoading(true);
				const querySuffix = projectPath ? "?project=" + encodeURIComponent(projectPath) : "";
				return requestJson("/skill-manager/skills" + querySuffix)
					.then((payload) => {
						setData(payload);
						if (keepSelection !== true) {
							setSelectedPath("");
							setDraft("");
							setSavedDraft("");
						}
					})
					.catch((error) => flash("error", "加载 skill 列表失败：" + error.message))
					.finally(() => setLoading(false));
			}, [flash]);

			// ── 初次加载：先拿 state，再按默认项目拉列表 ───────────────
			useEffect(() => {
				let cancelled = false;
				requestJson("/skill-manager/state")
					.then((payload) => {
						if (cancelled) return;
						setState(payload);
						const nextProject = payload.project || "";
						setProject(nextProject);
						// 同步 ref，使下面的「项目切换」effect 不会重复扫描一次
						projectRef.current = nextProject;
						setConfigText((payload.config && payload.config.customSkillDirs || []).join("\n"));
						loadSkills(nextProject, false);
					})
					.catch((error) => {
						if (cancelled) return;
						flash("error", "读取状态失败：" + error.message);
					});
				return () => {
					cancelled = true;
				};
			}, [flash, loadSkills]);

			// 项目切换后重新扫描
			useEffect(() => {
				if (projectRef.current === project) return;
				projectRef.current = project;
				setSelectedPath("");
				setDraft("");
				setSavedDraft("");
				setConfirmDelete(false);
				loadSkills(project, false);
			}, [project, loadSkills]);

			// ── 选中项加载全文 ───────────────────────────────────────
			const selected = useMemo(() => {
				if (!data || !Array.isArray(data.skills)) return null;
				return data.skills.find((skill) => skill.filePath === selectedPath) || null;
			}, [data, selectedPath]);

			useEffect(() => {
				const skipRead = mode !== "view" || selectedPath === "";
				if (skipRead) {
					return undefined;
				}
				let cancelled = false;
				setConfirmDelete(false);
				requestJson(fileUrl(selectedPath, project))
					.then((payload) => {
						if (cancelled) return;
						setDraft(typeof payload.content === "string" ? payload.content : "");
						setSavedDraft(typeof payload.content === "string" ? payload.content : "");
					})
					.catch((error) => {
						if (cancelled) return;
						flash("error", "读取文件失败：" + error.message);
					});
				return () => {
					cancelled = true;
				};
			}, [selectedPath, mode, project, flash]);

			// ── 操作 ─────────────────────────────────────────────────

			const save = useCallback(() => {
				if (selectedPath === "") return;
				setBusy(true);
				postJson(fileUrl(selectedPath, project), { path: selectedPath, content: draft })
					.then(() => {
						setSavedDraft(draft);
						flash("ok", "已保存。DSH 会在下一个模型步骤重新读取该 skill。");
						return loadSkills(project, true);
					})
					.catch((error) => flash("error", "保存失败：" + error.message))
					.finally(() => setBusy(false));
			}, [selectedPath, draft, project, loadSkills, flash]);

			const toggle = useCallback((skill, update) => {
				setBusy(true);
				postJson("/skill-manager/toggle", Object.assign({ path: skill.filePath, project }, update))
					.then(() => loadSkills(project, true))
					.then(() => {
						// 开关改变了 frontmatter，编辑器内容需要同步重读
						return requestJson(fileUrl(skill.filePath, project));
					})
					.then((payload) => {
						if (typeof payload.content === "string") {
							setDraft(payload.content);
							setSavedDraft(payload.content);
						}
					})
					.catch((error) => flash("error", "切换失败：" + error.message))
					.finally(() => setBusy(false));
			}, [project, loadSkills, flash]);

			const remove = useCallback(() => {
				if (selected === null) return;
				setBusy(true);
				postJson("/skill-manager/delete", { path: selected.filePath, project })
					.then((payload) => {
						flash("ok", "已删除，备份在 " + payload.backup);
						setSelectedPath("");
						setDraft("");
						setSavedDraft("");
						setConfirmDelete(false);
						return loadSkills(project, false);
					})
					.catch((error) => flash("error", "删除失败：" + error.message))
					.finally(() => setBusy(false));
			}, [selected, project, loadSkills, flash]);

			const submitCreate = useCallback(() => {
				const form = createForm;
				setBusy(true);
				postJson("/skill-manager/create", {
					rootId: form.rootId,
					project,
					name: form.name,
					description: form.description,
					whenToUse: form.whenToUse,
					modelInvocable: form.modelInvocable,
					userInvocable: form.userInvocable,
				})
					.then((payload) => {
						flash("ok", "已创建：" + payload.path);
						setMode("view");
						setCreateForm({
							rootId: form.rootId,
							name: "",
							description: "",
							whenToUse: "",
							modelInvocable: true,
							userInvocable: true,
						});
						return loadSkills(project, true).then(() => {
							setSelectedPath(payload.path);
						});
					})
					.catch((error) => flash("error", "创建失败：" + error.message))
					.finally(() => setBusy(false));
			}, [createForm, project, loadSkills, flash]);

			const saveConfig = useCallback(() => {
				const dirs = configText
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter((line) => line !== "");
				setBusy(true);
				postJson("/skill-manager/config", { customSkillDirs: dirs })
					.then(() => {
						flash("ok", "已保存自定义根目录，正在重新扫描…");
						setShowConfig(false);
						return loadSkills(project, true);
					})
					.catch((error) => flash("error", "保存配置失败：" + error.message))
					.finally(() => setBusy(false));
			}, [configText, project, loadSkills, flash]);

			// ── 派生数据 ─────────────────────────────────────────────

			const allSkills = data && Array.isArray(data.skills) ? data.skills : [];

			const filtered = useMemo(() => {
				const keyword = query.trim().toLowerCase();
				return allSkills.filter((skill) => {
					if (scopeFilter === "global" && skill.scope !== "global") return false;
					if (scopeFilter === "project" && skill.scope !== "project") return false;
					if (scopeFilter === "custom" && skill.scope !== "custom") return false;
					if (onlyDisabled && skill.modelInvocable && skill.userInvocable) return false;
					if (keyword === "") return true;
					const haystack = (skill.name + " " + skill.description + " " + skill.whenToUse).toLowerCase();
					return haystack.includes(keyword);
				});
			}, [allSkills, query, scopeFilter, onlyDisabled]);

			const stats = useMemo(() => {
				let globalCount = 0;
				let projectCount = 0;
				let disabledCount = 0;
				for (const skill of allSkills) {
					if (skill.scope === "project") projectCount += 1;
					else if (skill.scope === "global") globalCount += 1;
					if (!skill.modelInvocable || !skill.userInvocable) disabledCount += 1;
				}
				return { total: allSkills.length, globalCount, projectCount, disabledCount };
			}, [allSkills]);

			const creatableRoots = useMemo(() => {
				const roots = data && Array.isArray(data.roots) ? data.roots : [];
				return roots.filter((root) => root.scope !== undefined);
			}, [data]);

			const dirty = draft !== savedDraft;

			// Ctrl/Cmd + S 保存
			const onKeyDown = useCallback((event) => {
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
					event.preventDefault();
					if (dirty && !busy) save();
				}
			}, [dirty, busy, save]);

			// ── 渲染 ─────────────────────────────────────────────────

			const toolbar = h(
				"div",
				{ style: Object.assign({}, ROW, { marginBottom: "6px" }) },
				h("span", { style: { fontSize: "13px", opacity: 0.85, whiteSpace: "nowrap" } }, "项目："),
				h("input", {
					style: Object.assign({}, INPUT, { flex: "1 1 260px", minWidth: "200px" }),
					value: project,
					list: "dsh-skill-manager-workspaces",
					placeholder: "留空则只扫描全局 skill；也可填写任意项目目录",
					onChange: (event) => setProject(event.target.value),
				}),
				h(
					"datalist",
					{ id: "dsh-skill-manager-workspaces" },
					(state && Array.isArray(state.workspaces) ? state.workspaces : []).map((workspace) =>
						h("option", { key: workspace.id, value: workspace.path }, workspace.title),
					),
				),
				h(
					"button",
					{
						type: "button",
						style: BUTTON,
						disabled: loading,
						onClick: () => loadSkills(project, true),
					},
					loading ? "扫描中…" : "刷新",
				),
				h(
					"button",
					{
						type: "button",
						style: BUTTON,
						onClick: () => {
							setShowConfig(!showConfig);
							setMode("view");
						},
					},
					"自定义根目录",
				),
				h(
					"button",
					{
						type: "button",
						style: BUTTON_PRIMARY,
						onClick: () => {
							setMode("create");
							setConfirmDelete(false);
							setShowConfig(false);
							const preferred = creatableRoots.find((root) => root.id === "user-dsh");
							setCreateForm((form) => Object.assign({}, form, {
								rootId: preferred ? preferred.id : (creatableRoots[0] ? creatableRoots[0].id : "user-dsh"),
							}));
						},
					},
					"＋ 新建 skill",
				),
			);

			const summary = h(
				"div",
				{ style: Object.assign({}, MUTED, { marginBottom: "10px", lineHeight: 1.6 }) },
				"共 " + stats.total + " 个（全局 " + stats.globalCount + " / 项目 " + stats.projectCount + "）" +
					(stats.disabledCount > 0 ? "，其中 " + stats.disabledCount + " 个已被禁用某一入口" : ""),
				data && data.projectRoot
					? h("span", { style: MONO }, "　项目根：" + data.projectRoot)
					: null,
				state && state.dshHome ? h("span", { style: MONO }, "　全局根：" + state.dshHome + "\\skills") : null,
			);

			const filters = h(
				"div",
				{ style: Object.assign({}, ROW, { marginBottom: "10px" }) },
				h("input", {
					style: Object.assign({}, INPUT, { flex: "1 1 180px", minWidth: "150px" }),
					value: query,
					placeholder: "搜索 name / description",
					onChange: (event) => setQuery(event.target.value),
				}),
				...[
					["all", "全部"],
					["global", "全局"],
					["project", "项目"],
					["custom", "自定义"],
				].map(([key, label]) =>
					h(
						"button",
						{
							key,
							type: "button",
							style: scopeFilter === key
								? Object.assign({}, BUTTON, { background: SURFACE_HOVER, borderColor: "rgba(128,128,128,0.5)" })
								: BUTTON,
							onClick: () => setScopeFilter(key),
						},
						label,
					),
				),
				h(
					"label",
					{ style: Object.assign({}, MUTED, { display: "flex", alignItems: "center", gap: "5px", cursor: "pointer" }) },
					h("input", {
						type: "checkbox",
						checked: onlyDisabled,
						onChange: (event) => setOnlyDisabled(event.target.checked),
					}),
					"只看已禁用",
				),
			);

			const list = h(
				"div",
				{
					style: {
						flex: "0 1 320px",
						minWidth: "240px",
						maxHeight: "62vh",
						overflowY: "auto",
						paddingRight: "4px",
					},
				},
				filtered.length === 0
					? h(
							"p",
							{ style: Object.assign({}, MUTED, { marginTop: "14px" }) },
							allSkills.length === 0
								? "没有发现任何 skill。可以在 全局根 或 项目 .dsh/skills 下新建一个。"
								: "没有符合筛选条件的 skill。",
						)
					: filtered.map((skill) => {
							const badge = sourceBadge(skill);
							const active = skill.filePath === selectedPath && mode === "view";
							return h(
								"div",
								{
									key: skill.filePath,
									role: "button",
									tabIndex: 0,
									onClick: () => {
										setMode("view");
										setSelectedPath(skill.filePath);
										setShowConfig(false);
									},
									onKeyDown: (event) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											setMode("view");
											setSelectedPath(skill.filePath);
										}
									},
									style: {
										padding: "9px 11px",
										marginBottom: "7px",
										borderRadius: "8px",
										border: active ? "1px solid rgba(59, 110, 245, 0.85)" : BORDER_SOFT,
										background: active ? "rgba(59, 110, 245, 0.10)" : SURFACE,
										cursor: "pointer",
									},
								},
								h(
									"div",
									{ style: { display: "flex", alignItems: "center", gap: "7px" } },
									h("strong", {
										style: {
											fontSize: "13px",
											fontWeight: 600,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
										},
									}, skill.name),
									h(Badge, { text: badge.text, color: badge.color }),
									skill.kind === "flat" ? h(Badge, { text: "单文件", color: "#8b5cf6" }) : null,
									skill.warnings && skill.warnings.length > 0 ? h(Badge, { text: "警告", color: "#f59e0b" }) : null,
									skill.shadowed && skill.shadowed.length > 0 ? h(Badge, { text: "被覆盖 " + skill.shadowed.length, color: "#64748b" }) : null,
								),
								h(
									"div",
									{
										style: {
											fontSize: "12px",
											opacity: 0.68,
											marginTop: "3px",
											lineHeight: 1.45,
											display: "-webkit-box",
											WebkitLineClamp: 2,
											WebkitBoxOrient: "vertical",
											overflow: "hidden",
										},
									},
									skill.description || "（无 description）",
								),
								h(
									"div",
									{ style: Object.assign({}, ROW, { gap: "5px", marginTop: "7px" }) },
									h(Toggle, {
										checked: skill.modelInvocable,
										label: "模型",
										title: "模型是否可以在目录中看到并调用该 skill",
										disabled: busy,
										onChange: (next) => toggle(skill, { modelInvocable: next }),
									}),
									h(Toggle, {
										checked: skill.userInvocable,
										label: "用户",
										title: "是否允许用户通过 /name 直接调用",
										disabled: busy,
										onChange: (next) => toggle(skill, { userInvocable: next }),
									}),
								),
							);
						}),
			);

			// ── 右侧：自定义根目录配置 ────────────────────────────────
			const configPanel = showConfig
				? h(
						"div",
						{ style: { flex: "1 1 420px", minWidth: "280px" } },
						h("h3", { style: { fontSize: "14px", margin: "0 0 6px" } }, "自定义 skill 根目录"),
						h(
							"p",
							{ style: Object.assign({}, MUTED, { marginTop: 0, lineHeight: 1.6 }) },
							"每行一个绝对路径，会在项目根之后、全局根之前被扫描（与 dsh-skill-filesystem 的 custom 层一致）。",
						),
						h("textarea", {
							style: Object.assign({}, TEXTAREA, { minHeight: "180px" }),
							value: configText,
							onChange: (event) => setConfigText(event.target.value),
							placeholder: "D:\\my-skills",
						}),
						h(
							"div",
							{ style: Object.assign({}, ROW, { marginTop: "10px" }) },
							h("button", { type: "button", style: BUTTON_PRIMARY, disabled: busy, onClick: saveConfig }, "保存并重扫"),
							state && state.configFile
								? h("span", { style: MONO }, "配置文件：" + state.configFile)
								: null,
						),
					)
				: null;

			// ── 右侧：新建表单 ───────────────────────────────────────
			const createPanel = mode === "create"
				? h(
						"div",
						{ style: { flex: "1 1 420px", minWidth: "280px" } },
						h("h3", { style: { fontSize: "14px", margin: "0 0 10px" } }, "新建 skill"),
						h(
							"label",
							{ style: { display: "block", marginBottom: "9px" } },
							h("div", { style: Object.assign({}, MUTED, { marginBottom: "3px" }) }, "写入位置"),
							h(
								"select",
								{
									style: Object.assign({}, INPUT, { width: "100%" }),
									value: createForm.rootId,
									onChange: (event) => setCreateForm((form) => Object.assign({}, form, { rootId: event.target.value })),
								},
								creatableRoots.map((root) =>
									h(
										"option",
										{ key: root.id, value: root.id },
										rootLabel(root) + "　" + root.path + (root.exists ? "" : "（将创建）"),
									),
								),
							),
						),
						h(
							"label",
							{ style: { display: "block", marginBottom: "9px" } },
							h("div", { style: Object.assign({}, MUTED, { marginBottom: "3px" }) }, "name（小写 kebab-case）"),
							h("input", {
								style: Object.assign({}, INPUT, { width: "100%", fontFamily: "ui-monospace, Consolas, monospace" }),
								value: createForm.name,
								placeholder: "my-skill",
								onChange: (event) => setCreateForm((form) => Object.assign({}, form, { name: event.target.value })),
							}),
						),
						h(
							"label",
							{ style: { display: "block", marginBottom: "9px" } },
							h("div", { style: Object.assign({}, MUTED, { marginBottom: "3px" }) }, "description（决定模型是否识别该技能）"),
							h("textarea", {
								style: Object.assign({}, INPUT, { width: "100%", minHeight: "74px", resize: "vertical", lineHeight: 1.5 }),
								value: createForm.description,
								placeholder: "Use when the user asks to …",
								onChange: (event) => setCreateForm((form) => Object.assign({}, form, { description: event.target.value })),
							}),
						),
						h(
							"label",
							{ style: { display: "block", marginBottom: "9px" } },
							h("div", { style: Object.assign({}, MUTED, { marginBottom: "3px" }) }, "whenToUse（可选）"),
							h("textarea", {
								style: Object.assign({}, INPUT, { width: "100%", minHeight: "58px", resize: "vertical", lineHeight: 1.5 }),
								value: createForm.whenToUse,
								onChange: (event) => setCreateForm((form) => Object.assign({}, form, { whenToUse: event.target.value })),
							}),
						),
						h(
							"div",
							{ style: Object.assign({}, ROW, { marginBottom: "12px" }) },
							h(Toggle, {
								checked: createForm.modelInvocable,
								label: "模型可调用",
								onChange: (next) => setCreateForm((form) => Object.assign({}, form, { modelInvocable: next })),
							}),
							h(Toggle, {
								checked: createForm.userInvocable,
								label: "用户可调用",
								onChange: (next) => setCreateForm((form) => Object.assign({}, form, { userInvocable: next })),
							}),
						),
						h(
							"div",
							{ style: ROW },
							h("button", { type: "button", style: BUTTON_PRIMARY, disabled: busy, onClick: submitCreate }, busy ? "创建中…" : "创建"),
							h("button", { type: "button", style: BUTTON, onClick: () => setMode("view") }, "取消"),
						),
					)
				: null;

			// ── 右侧：详情 / 编辑器 ──────────────────────────────────
			let detailPanel = null;
			if (mode === "view") {
				if (selected === null) {
					detailPanel = h(
						"div",
						{ style: { flex: "1 1 420px", minWidth: "280px" } },
						h(
							"p",
							{ style: Object.assign({}, MUTED, { marginTop: 0, lineHeight: 1.7 }) },
							"从左侧选择一个 skill 查看并编辑它的 SKILL.md。",
						),
						h(
							"div",
							{ style: { padding: "11px 13px", borderRadius: "8px", border: BORDER_SOFT, background: SURFACE, lineHeight: 1.7, fontSize: "12.5px" } },
							h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, "扫描顺序"),
							h("div", null, "1. 项目 .dsh/skills（最高优先级）"),
							h("div", null, "2. 项目 .agents/skills"),
							h("div", null, "3. 自定义目录"),
							h("div", null, "4. 全局 ~/.dsh/skills"),
							h("div", null, "5. 全局 ~/.agents/skills"),
							h("div", { style: Object.assign({}, MUTED, { marginTop: "6px" }) }, "同名 skill 只保留优先级最高的一份，其余会在列表里标注「被覆盖」。"),
						),
					);
				} else {
					const badge = sourceBadge(selected);
					detailPanel = h(
						"div",
						{ style: { flex: "1 1 420px", minWidth: "280px" } },
						h(
							"div",
							{ style: Object.assign({}, ROW, { marginBottom: "4px" }) },
							h("strong", { style: { fontSize: "14px" } }, selected.name),
							h(Badge, { text: badge.text, color: badge.color }),
							h(Badge, { text: selected.kind === "bundle" ? "目录型" : "单文件", color: "#8b5cf6" }),
							selected.invocationInvalid ? h(Badge, { text: "调用配置非法", color: "#e5484d" }) : null,
						),
						h(
							"div",
							{ style: Object.assign({}, MONO, { opacity: 0.6, wordBreak: "break-all", marginBottom: "8px" }) },
							selected.filePath,
							selected.mtime ? "　·　" + formatTime(selected.mtime) : "",
							selected.size ? "　·　" + formatBytes(selected.size) : "",
						),
						selected.warnings && selected.warnings.length > 0
							? h(
									"div",
									{
										style: {
											marginBottom: "9px",
											padding: "7px 10px",
											borderRadius: "6px",
											border: "1px solid rgba(245, 158, 11, 0.75)",
											background: "rgba(245, 158, 11, 0.10)",
											fontSize: "12px",
											lineHeight: 1.6,
										},
									},
									selected.warnings.map((warning, index) => h("div", { key: index }, "· " + warning)),
								)
							: null,
						selected.shadowed && selected.shadowed.length > 0
							? h(
									"div",
									{ style: Object.assign({}, MUTED, { marginBottom: "9px", lineHeight: 1.6 }) },
									"被更低优先级的同名 skill 覆盖：" +
										selected.shadowed.map((item) => item.source + " (" + item.filePath + ")").join("；"),
								)
							: null,
						h(
							"div",
							{ style: Object.assign({}, ROW, { marginBottom: "9px" }) },
							h(Toggle, {
								checked: selected.modelInvocable,
								label: "模型可调用",
								title: "关闭会写入 disable-model-invocation: true",
								disabled: busy,
								onChange: (next) => toggle(selected, { modelInvocable: next }),
							}),
							h(Toggle, {
								checked: selected.userInvocable,
								label: "用户可调用",
								title: "关闭会写入 user-invocable: false",
								disabled: busy,
								onChange: (next) => toggle(selected, { userInvocable: next }),
							}),
							h("span", { style: Object.assign({}, MUTED, { marginLeft: "auto" }) }, "Ctrl+S 保存"),
						),
						h("textarea", {
							style: TEXTAREA,
							value: draft,
							spellCheck: false,
							onChange: (event) => setDraft(event.target.value),
							onKeyDown,
						}),
						h(
							"div",
							{ style: Object.assign({}, ROW, { marginTop: "10px" }) },
							h("button", {
								type: "button",
								style: BUTTON_PRIMARY,
								disabled: busy || !dirty,
								onClick: save,
							}, busy ? "保存中…" : dirty ? "保存修改" : "已保存"),
							h(
								"button",
								{
									type: "button",
									style: BUTTON,
									disabled: busy,
									onClick: () =>
										requestJson(fileUrl(selected.filePath, project))
											.then((payload) => {
												setDraft(typeof payload.content === "string" ? payload.content : "");
												setSavedDraft(typeof payload.content === "string" ? payload.content : "");
												flash("ok", "已重新载入磁盘内容。");
											})
											.catch((error) => flash("error", "重新载入失败：" + error.message)),
								},
								"放弃修改",
							),
							h(
								"div",
								{ style: Object.assign({}, ROW, { marginLeft: "auto" }) },
								confirmDelete
									? h(
											"span",
											{ style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
											h("span", { style: MUTED }, "确认删除？会先做备份"),
											h("button", { type: "button", style: BUTTON_DANGER, disabled: busy, onClick: remove }, "确认删除"),
											h("button", { type: "button", style: BUTTON, onClick: () => setConfirmDelete(false) }, "取消"),
										)
									: h(
											"button",
											{
												type: "button",
												style: BUTTON,
												disabled: busy,
												onClick: () => setConfirmDelete(true),
											},
											"删除",
										),
							),
						),
					);
				}
			}

			return h(
				"div",
				{ style: { paddingTop: "4px" } },
				toolbar,
				summary,
				filters,
				h(Notice, { notice }),
				h(
					"div",
					{ style: { display: "flex", gap: "16px", alignItems: "flex-start", flexWrap: "wrap", marginTop: "12px" } },
					list,
					showConfig ? configPanel : mode === "create" ? createPanel : detailPanel,
				),
			);
		}

		return {
			name: "skill-manager",
			inject: ["slots"],
			apply(ctx) {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "skill-manager",
							order: 35,
							label: () => "Skill 管理",
						},
						() => h(SkillSection, null),
					),
				);
			},
		};
	},
});
