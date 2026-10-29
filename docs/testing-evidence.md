# hapi-dsh 测试替换：精简证据核查

访问日期：2026-10-27。按 ARS deep-research quick 路线完成范围界定、文献检索与来源核查；这是工程实现的证据备忘，不是系统综述。问题限定为：怎样缩短开发反馈，同时检查用户可观察的交互、跨边界行为及回归检测能力。公开查询中没有包含仓库内容或私有数据。

现有依据支持“少量关键真实 UI 检查 + 大量确定性的组件和契约测试”，但不能推出“删除浏览器测试后已经覆盖所有真实体验”。用户给出的 arXiv:2211.07782 引用正确；其方法、语言和实验边界需要保留。

| 主题 | 一手来源与核查结果 | 能支持的结论及边界 |
|---|---|---|
| UI 测试的脆弱性 | Romano, Song, Grandhi, Yang, Wang (ICSE 2021), *An Empirical Analysis of UI-based Flaky Tests*. DOI [10.1109/ICSE43902.2021.00141](https://doi.org/10.1109/ICSE43902.2021.00141)；[作者全文](https://weihang-wang.github.io/papers/UIFlaky-icse21.pdf)；[作者数据集](https://ui-flaky-test.github.io/)。Crossref 元数据、arXiv:2103.02669 和作者全文相符。 | 对 62 个 Web/Android 项目的 235 个已发现 flaky UI 测试进行实证分类，涵盖异步等待、环境、测试运行器 API、测试脚本逻辑。支持主动控制异步时序、减少环境依赖。样本本来就以 flaky 测试为对象，不能把它当作所有 e2e 的 flakiness 比率，也没有比较 hapi-dsh 两套方案。 |
| 端到端反馈成本 | Google Testing Blog, Mike Wacker (2015), [Just Say No to More End-to-End Tests](https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html)。官方工程经验文章。 | 支持以速度、可靠性、定位能力衡量反馈循环，减少主要依赖大范围端到端测试的策略。文章用综合经验场景说明问题，不是定量对照实验，也没有证明所有 e2e 都应删除。 |
| 用户行为组件测试 | Testing Library [Guiding Principles](https://testing-library.com/docs/guiding-principles/) 与 [user-event Introduction](https://testing-library.com/docs/user-event/intro/)。当前官方文档。 | 测试应操作 DOM 与用户交互，而不是组件实例内部状态；user-event 模拟一次交互涉及的事件序列与部分可交互检查。适合输入、按钮、草稿切换、忙碌/失败提示等可观察行为。某些交互仍不完整，不能视为真实浏览器等价物。 |
| 布局能力边界 | [jsdom 官方 README](https://github.com/jsdom/jsdom#unimplemented-parts-of-the-web-platform)。 | jsdom 不做布局或渲染，部分布局属性返回零。可测试滚动相关状态和算法；不能仅靠它声称验证了真实像素、CSS 遮挡、移动端布局或实际滚动位置。 |
| 测试选择 / TIA | Muzammil Shahbaz (2022), [An approach for Test Impact Analysis on the Integration Level in Java programs](https://arxiv.org/abs/2211.07782)；[全文 HTML](https://arxiv.org/html/2211.07782v1)。arXiv API 与页面的标题、作者一致；这里引用预印本记录，不额外推断正式出版详情。 | 结合 Java 代码变化分析与运行时“测试→调用方法”映射。论文报告平均约 50% 测试数量减少，所测变异的检出结果与全量相同。其实现要求顺序执行以建立归属，未覆盖配置、外部依赖、环境变量等变化；这不是静态 TS import graph 完备性的证明，更不是 hapi-dsh 的提速预测。 |
| 故障注入与测试能力 | Just et al. (FSE 2014), [Are mutants a valid substitute for real faults in software testing?](https://homes.cs.washington.edu/~mernst/pubs/mutation-effectiveness-fse2014-abstract.html)；DOI [10.1145/2635868.2635929](https://doi.org/10.1145/2635868.2635929)。Crossref 与作者页面匹配，作者提供全文。另见 [Stryker 官方 mutant 状态定义](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/)。 | 研究用 5 个应用的 357 个真实缺陷分析变异检测与真实缺陷检测的关联，支持把 mutation 作为测试能力的补充证据。不能以少数被杀死的变异证明不存在其他 bug。Stryker 区分 killed、survived、compile error 和 runtime error；故障演练应确认触发预期行为断言，不能把编译失败或启动错误算成体验问题已被抓住。 |

对实现的直接建议属于基于上述资料的工程推论：用可显式释放的异步请求制造“旧会话响应晚到”“发送失败后重试”等时序，断言最终可见内容与请求次数；把重复投递、错误关联、错误清空草稿等具体历史回归作为少量故障演练，记录正常版本通过、注入版本由对应行为断言失败。测试名、数量和覆盖率本身都不能代替这种检测证据。

静态依赖选择适合作为内循环加速器，但要把依赖锁文件、测试配置、共享 fixture 和无法解析的依赖变化明确纳入全量或已定义范围。作为工具边界的一手对照，[Vitest CLI](https://vitest.dev/guide/cli.html#vitest-related) 明确说明 related 支持静态可分析的 import，却不支持 `import(filepath)` 这种动态路径。不要宣称任意 import-graph 脚本“保证不漏测”。

另有一条需要更新原说明的时效性事实：[当前 Playwright 官方组件测试文档](https://playwright.dev/docs/test-components) 已描述 `@playwright/test` 内置 mount 和由项目管理的 story gallery，并说明旧 `@playwright/experimental-ct-*` 包已移除。因此“Playwright 组件测试仍是实验特性”不能继续作为当前事实。这个变化不要求 hapi-dsh 重新引入 Playwright。

## 检索记录

优先使用 paper-lookup 的 arXiv/Crossref API，再以官方网页补足全文和工具行为；没有借助通用搜索绕过 API 限流。所有检索均为有界候选核查，没有开展穷尽检索。

| 数据库 / 路径 | 可复现请求 | 返回与阅读范围 |
|---|---|---|
| arXiv API | `GET https://export.arxiv.org/api/query?id_list=2211.07782` | total_results=1，returned=1，单页；API 是元数据/摘要，随后阅读官方 HTML 的方法与限制段。 |
| Crossref API | `GET https://api.crossref.org/works?query.bibliographic=An%20empirical%20analysis%20of%20flaky%20tests&rows=4&select=DOI,title,author,published,URL,abstract` | total-results=7,089,084，取首 4 条；这是模糊相关检索的总命中数，绝非相关文献数量。筛到 2014 通用 flaky 研究与 2021 UI 研究；采用后者，另 2 条不纳入。Crossref 结果为元数据。 |
| Crossref API | `GET https://api.crossref.org/works?query.bibliographic=Are%20mutants%20a%20valid%20substitute%20for%20real%20faults%20in%20software%20testing&rows=3&select=DOI,title,author,published,URL,abstract` | total-results=2,041,547，首 3 条，采用标题精确匹配的 FSE 2014 记录。其余 2 条仅为候选，未纳入证据。Crossref 结果为元数据。 |
| arXiv API | `GET https://export.arxiv.org/api/query?id_list=2103.02669,2609.00065` | total_results=2，returned=2，单页。前者验证 UI flaky 论文；后者验证检索技能的方法归属。元数据/摘要。arXiv 请求顺序执行，间隔超过 3 秒。 |
| 官方网页 / 作者全文检索 | `"An Empirical Analysis of UI-Based Flaky Tests" Romano Wang pdf`；`"Are mutants a valid substitute for real faults in software testing" Washington` | 用于 Crossref 元数据缺失全文的覆盖缺口。搜索工具未提供完整命中数/分页总量，未将结果数冒充数据库总量；只采用作者主页、作者 PDF 和项目数据页。UI 论文已读取引言、根因类别和有效性限制；mutation 论文论点采用作者摘要，全文已取得但未作逐节精读。 |
| 官方工具文档 | Testing Library、jsdom、Vitest、Playwright、Stryker 上文所列 URL | 直接阅读当前页面；不是论文证据，不赋予实证研究等级。 |

材料未落盘为论文 corpus，没有进行作者“已读”标记，也没有进行撤稿/所有利益冲突的穷尽审计。ICSE/FSE 论文属于同行评审会议的单项实证研究；TIA 此处以可访问预印本及其自述边界使用；官方工具文档只用于核对能力和限制。

本备忘由 AI 辅助检索和核查。检索使用了 paper-lookup 流程，其方法来源为 Kassis, Agarwal, He, Patel, and Brueckner (2026), [Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents](https://arxiv.org/abs/2609.00065)；本次 API 验证最新记录为 v2。该来源用于方法归属，不作为测试方案有效性的证据。
