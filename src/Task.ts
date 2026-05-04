/**
 * CCB 任务系统核心模块
 *
 * 本模块定义了 CCB 的任务抽象，包括：
 * - TaskType: 任务类型枚举（本地Bash、本地Agent、远程Agent等）
 * - TaskStatus: 任务状态枚举（待处理、运行中、已完成等）
 * - TaskStateBase: 所有任务状态的公共字段
 * - generateTaskId: 生成唯一任务ID的函数
 *
 * 任务生命周期：
 * 1. 创建任务 -> pending
 * 2. startTask() -> running
 * 3. 正常完成 -> completed
 * 4. 执行出错 -> failed
 * 5. 被终止 -> killed
 */

import { randomBytes } from 'crypto'
import type { AppState } from './state/AppState.js'
import type { AgentId } from './types/ids.js'
import { getTaskOutputPath } from './utils/task/diskOutput.js'

/**
 * 任务类型枚举
 * - local_bash: 本地 Bash 命令执行任务
 * - local_agent: 本地启动的子 Agent 任务
 * - remote_agent: 远程运行的 Agent 任务
 * - in_process_teammate: 进程内队友（与主 Agent 协作的子 Agent）
 * - local_workflow: 本地工作流任务
 * - monitor_mcp: MCP 服务器监控任务
 * - dream: 记忆整理任务（自动整理 CLAUDE.md 等记忆文件）
 */
export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'

/**
 * 任务状态枚举
 * - pending: 任务已创建，等待执行
 * - running: 任务正在执行中
 * - completed: 任务成功完成
 * - failed: 任务执行过程中出错
 * - killed: 任务被手动终止
 */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'

/**
 * 判断任务是否处于终态
 * 终态任务不会再发生状态转换
 *
 * @param status 任务状态
 * @returns 如果是终态返回 true
 *
 * @example
 * isTerminalTaskStatus('completed') // true
 * isTerminalTaskStatus('running')   // false
 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

/**
 * 任务句柄
 * 用于引用和操作任务
 */
export type TaskHandle = {
  taskId: string
  cleanup?: () => void
}

/**
 * 更新 AppState 的函数类型
 */
export type SetAppState = (f: (prev: AppState) => AppState) => void

/**
 * 任务执行上下文
 * 提供任务执行所需的各种服务和状态访问
 */
export type TaskContext = {
  abortController: AbortController
  getAppState: () => AppState
  setAppState: SetAppState
}

/**
 * 任务状态基类
 * 所有任务状态都包含以下公共字段
 */
export type TaskStateBase = {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  totalPausedMs?: number
  outputFile: string
  outputOffset: number
  notified: boolean
}

/**
 * 本地 Shell 任务输入
 */
export type LocalShellSpawnInput = {
  command: string
  description: string
  timeout?: number
  toolUseId?: string
  agentId?: AgentId
  kind?: 'bash' | 'monitor'
}

/**
 * 任务接口
 * 定义任务必须实现的操作
 */
export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}

/**
 * 任务 ID 前缀映射表
 * 用于生成人类可读的任务 ID
 */
const TASK_ID_PREFIXES: Record<string, string> = {
  local_bash: 'b',
  local_agent: 'a',
  remote_agent: 'r',
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  dream: 'd',
}

/**
 * 获取任务类型对应的前缀
 * @param type 任务类型
 * @returns 前缀字符，未知类型返回 'x'
 */
function getTaskIdPrefix(type: TaskType): string {
  return TASK_ID_PREFIXES[type] ?? 'x'
}

/**
 * Task ID 使用的字符集
 * 36进制：0-9 和 a-z
 * 36^8 ≈ 2.8 万亿种组合，可抵抗暴力破解
 */
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * 生成唯一任务 ID
 *
 * 算法：
 * 1. 根据任务类型获取前缀（1字符）
 * 2. 生成 8 字节加密安全随机数
 * 3. 将每字节映射到 36 进制字符
 * 4. 拼接前缀 + 8 字符 = 9 字符任务 ID
 *
 * @param type 任务类型
 * @returns 唯一任务 ID，格式：{prefix}{8chars}
 *
 * @example
 * generateTaskId('local_bash') // "b1a2b3c4d5"
 * generateTaskId('local_agent') // "a9x8y7z6w5"
 */
export function generateTaskId(type: TaskType): string {
  const prefix = getTaskIdPrefix(type)
  const bytes = randomBytes(8)
  let id = prefix
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
  }
  return id
}

/**
 * 创建任务状态基对象
 *
 * @param id 任务 ID（通常由 generateTaskId 生成）
 * @param type 任务类型
 * @param description 任务描述
 * @param toolUseId 可选的工具使用 ID
 * @returns 任务状态基对象
 */
export function createTaskStateBase(
  id: string,
  type: TaskType,
  description: string,
  toolUseId?: string,
): TaskStateBase {
  return {
    id,
    type,
    status: 'pending',
    description,
    toolUseId,
    startTime: Date.now(),
    outputFile: getTaskOutputPath(id),
    outputOffset: 0,
    notified: false,
  }
}
