# Feature 067: Phase-0 Rules-Based E2E Evaluation

Status: `todo`  
Type: `P1 Evaluation`

## Goal

建立第一阶段（无 Docker）的真实代码库 E2E 评测体系，先用规则打分稳定暴露问题；后续再升级到标准 Docker 评测。

## Principles

1. 先规则后模型：Phase-0 只做可复现规则打分，不引入 LLM judge。  
2. 真实仓库底座：模板库来自开源项目或官方脚手架，并固定版本。  
3. 一题一目录：任务、约束、验收命令、评分信号都显式文件化。  
4. 硬约束优先：违反禁止动作或关键路径约束直接判 fail。  

## Template Repos (Phase-0)

1. `python-lib`: `pypa/sampleproject`（pin commit）。  
2. `node-cli`: `oclif` 官方模板（pin `oclif` 版本后生成并冻结）。  
3. `react-web`: `create-vite` `react-ts`（pin `create-vite` 版本后生成并冻结）。  
4. `api-service`: `nestjs/typescript-starter`（pin commit）。  
5. `bug-suite`: `QuixBugs`（先用 Python 子集）。  

> 说明：模板库用于“场景真实度”；QuixBugs 用于“缺陷修复密度”。

## Task Set Scope

Phase-0 目标 40 题：

1. `python-lib`: 8  
2. `node-cli`: 8  
3. `react-web`: 8  
4. `api-service`: 8  
5. `bug-suite`(QuixBugs Python): 8  

每个库题型分布：

1. 功能新增：2  
2. 缺陷修复：3  
3. 回归定位：2  
4. 受限改动：1（重点测试是否严格按要求改动）

## Per-Task File Contract

每道题必须包含：

1. `task.md`: 用户任务描述（自然语言）。  
2. `task.yaml`: 机器可读配置（时间预算、命令、约束）。  
3. `acceptance.sh`: 主验收命令。  
4. `regression.sh`: 回归命令（可选）。  
5. `prepare.sh`: 任务初始化（可选）。  

字段定义见：

- [bench/task.schema.json](/Users/xieshuanglong/Documents/Code/Merlion/bench/task.schema.json)

## Rules-Based Scoring (100)

## Score Components

1. `acceptance_pass`（45 分）  
   - `acceptance.sh` 全通过得满分，否则 0。  
2. `regression_pass`（20 分）  
   - `regression.sh` 全通过得满分，失败 0；无回归脚本按 0 记（避免虚高）。  
3. `constraint_compliance`（20 分）  
   - 改动路径、最大改动文件数、禁止动作均满足得满分；逐项扣分。  
4. `build_lint`（10 分）  
   - 构建/静态检查通过得分。  
5. `patch_hygiene`（5 分）  
   - patch 可应用、无冲突、无空改动。  

## Hard-Fail Rules

出现任一即总分归零并标记 `hard_fail=true`：

1. 执行了 `forbidden_actions`（如 `deploy`, `delete_dir`）。  
2. 修改了 `forbidden_paths`。  
3. 超时或执行异常导致任务未完成。  

## Runner Flow

1. 创建临时工作目录并 checkout 题目基线。  
2. 执行 `prepare.sh`（若存在）。  
3. 调用 agent 完成任务。  
4. 采集 `git diff`、命令日志、退出码。  
5. 运行 `acceptance.sh` + `regression.sh` + build/lint。  
6. 按规则计算分数并输出 `result.json`。  

## Output Artifacts

每题输出：

1. `result.json`（结构见 schema）  
2. `session.log`（agent 输出）  
3. `commands.log`（验收命令输出）  
4. `patch.diff`  

结果 schema：

- [bench/score.schema.json](/Users/xieshuanglong/Documents/Code/Merlion/bench/score.schema.json)

## Reporting

批量报告聚合字段：

1. `overall_score_avg`  
2. `hard_fail_rate`  
3. `acceptance_pass_rate`  
4. `regression_pass_rate`  
5. `constraint_pass_rate`  
6. `repo_breakdown`（每模板库分数和通过率）  

## Phase-0 Exit Criteria

达到以下条件即可进入 Phase-1（Docker 标准评测）：

1. 40 题稳定可重复执行（同模型重复跑分波动可控）。  
2. 规则评分流水线无人工介入可跑完。  
3. 报告可定位失败原因（测试失败/约束违规/超时）。  

