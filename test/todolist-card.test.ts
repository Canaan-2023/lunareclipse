import { describe, it, expect } from 'vitest'
import {
  PRIORITY_LABELS,
  PRIORITY_CLASSES,
  getProgressStats
} from '../src/components/Chat/TodoListCard'
import type { TodoItem } from '../src/components/Chat/TodoListCard'

function makeTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 'todo-1',
    内容: '测试任务',
    status: 'pending',
    priority: 'medium',
    ...overrides
  }
}

describe('TodoListCard 视觉回归 - 优先级映射', () => {
  it('三个优先级都有标签', () => {
    expect(PRIORITY_LABELS.high).toBe('高')
    expect(PRIORITY_LABELS.medium).toBe('中')
    expect(PRIORITY_LABELS.low).toBe('低')
  })

  it('三个优先级都有色样式', () => {
    expect(PRIORITY_CLASSES.high).toBeTruthy()
    expect(PRIORITY_CLASSES.medium).toBeTruthy()
    expect(PRIORITY_CLASSES.low).toBeTruthy()
  })

  it('高优先级用 danger 色（视觉强调）', () => {
    expect(PRIORITY_CLASSES.high).toContain('danger')
  })

  it('中优先级用 warning 色', () => {
    expect(PRIORITY_CLASSES.medium).toContain('warning')
  })

  it('低优先级用 muted 色（弱化）', () => {
    expect(PRIORITY_CLASSES.low).toContain('muted')
  })
})

describe('TodoListCard 视觉回归 - 进度统计', () => {
  it('空清单：total=0, percent=0, hasInProgress=false', () => {
    const stats = getProgressStats([])
    expect(stats.total).toBe(0)
    expect(stats.completed).toBe(0)
    expect(stats.percent).toBe(0)
    expect(stats.hasInProgress).toBe(false)
  })

  it('全完成：percent=100', () => {
    const todos = [
      makeTodo({ id: '1', status: 'completed' }),
      makeTodo({ id: '2', status: 'completed' })
    ]
    const stats = getProgressStats(todos)
    expect(stats.completed).toBe(2)
    expect(stats.total).toBe(2)
    expect(stats.percent).toBe(100)
    expect(stats.hasInProgress).toBe(false)
  })

  it('部分完成：percent 按比例计算', () => {
    const todos = [
      makeTodo({ id: '1', status: 'completed' }),
      makeTodo({ id: '2', status: 'pending' }),
      makeTodo({ id: '3', status: 'pending' }),
      makeTodo({ id: '4', status: 'pending' })
    ]
    // 1/4 = 25%
    const stats = getProgressStats(todos)
    expect(stats.percent).toBe(25)
    expect(stats.hasInProgress).toBe(false)
  })

  it('有 in_progress：hasInProgress=true（决定 accent 色条）', () => {
    const todos = [
      makeTodo({ id: '1', status: 'completed' }),
      makeTodo({ id: '2', status: 'in_progress' })
    ]
    const stats = getProgressStats(todos)
    expect(stats.hasInProgress).toBe(true)
    expect(stats.percent).toBe(50)
  })

  it('percent 取整（四舍五入）', () => {
    // 1/3 = 33.33... → 33
    const todos = [
      makeTodo({ id: '1', status: 'completed' }),
      makeTodo({ id: '2', status: 'pending' }),
      makeTodo({ id: '3', status: 'pending' })
    ]
    const stats = getProgressStats(todos)
    expect(stats.percent).toBe(33)
  })

  it('2/3 = 66.66... → 67（Math.round 行为）', () => {
    const todos = [
      makeTodo({ id: '1', status: 'completed' }),
      makeTodo({ id: '2', status: 'completed' }),
      makeTodo({ id: '3', status: 'pending' })
    ]
    const stats = getProgressStats(todos)
    expect(stats.percent).toBe(67)
  })
})
