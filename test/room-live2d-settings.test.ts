/**
 * Live2D 设置的内存补全（Idle 动作 / 表情清单）。
 *
 * 为什么测：模型文件本身不能改（作者条款），待机动作只能靠**给内存里的设置补一条 Idle**；
 * 补错了不会崩，只会「人物站着不动」——这类失效没有报错，必须锁住行为。
 */
import { describe, it, expect } from 'vitest'
import { augmentSettings, type Live2DSettingsJson } from '../src/components/Room/live2d-settings'

const base = (): Live2DSettingsJson => ({
  url: 'room-asset://room/AI2/live2d/model/cat.model3.json',
  FileReferences: { Moc: 'cat.moc3', Textures: ['t.png'] } as Live2DSettingsJson['FileReferences']
})

describe('augmentSettings', () => {
  it('作者已声明 Idle → 原样保留，不覆盖', () => {
    const json = base()
    json.FileReferences!.Motions = { Idle: [{ File: 'author.motion3.json' }] }
    augmentSettings(json, ['IDLE.motion3.json'], [])
    expect(json.FileReferences!.Motions!.Idle).toEqual([{ File: 'author.motion3.json' }])
  })

  it('未声明但有 IDLE 文件 → 补 Idle 组（文件名大写也认）', () => {
    const json = base()
    augmentSettings(json, ['IDLE.motion3.json', '害怕.motion3.json'], [])
    expect(json.FileReferences!.Motions!.Idle).toEqual([
      { File: 'IDLE.motion3.json', FadeInTime: 0.8, FadeOutTime: 0.8 }
    ])
  })

  it('只有一个动作文件且没写 idle → 也认（不同作者命名习惯）', () => {
    const json = base()
    augmentSettings(json, ['呼吸.motion3.json'], [])
    expect(json.FileReferences!.Motions!.Idle).toEqual([
      { File: '呼吸.motion3.json', FadeInTime: 0.8, FadeOutTime: 0.8 }
    ])
  })

  it('多个动作且都没有 idle → 不猜', () => {
    const json = base()
    augmentSettings(json, ['害怕.motion3.json', '生气.motion3.json'], [])
    expect(json.FileReferences!.Motions).toBeUndefined()
  })

  it('表情：设置里没有才补，且保留中文名', () => {
    const json = base()
    augmentSettings(json, [], [
      { name: '害羞', file: '害羞.exp3.json' },
      { name: '问号', file: '问号.exp3.json' }
    ])
    expect(json.FileReferences!.Expressions).toEqual([
      { Name: '害羞', File: '害羞.exp3.json' },
      { Name: '问号', File: '问号.exp3.json' }
    ])
  })

  it('设置里已有 Expressions → 不覆盖', () => {
    const json = base()
    json.FileReferences!.Expressions = [{ Name: 'a', File: 'a.exp3.json' }]
    augmentSettings(json, [], [{ name: 'b', file: 'b.exp3.json' }])
    expect(json.FileReferences!.Expressions).toEqual([{ Name: 'a', File: 'a.exp3.json' }])
  })

  it('url 由调用方设置（相对路径的解析基准），补全函数不碰它', () => {
    const json = base()
    const before = json.url
    augmentSettings(json, ['IDLE.motion3.json'], [])
    expect(json.url).toBe(before)
  })
})
