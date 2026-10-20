import { describe, it, expect } from 'vitest'
import { isPrivateUrl, setAllowPrivateUrl } from '../electron/main/api/web-search'

describe('SSRF 防护', () => {
  it('拦截内网地址', () => {
    expect(isPrivateUrl('http://127.0.0.1:3000')).toBe(true)
    expect(isPrivateUrl('http://localhost:6186')).toBe(true)
    expect(isPrivateUrl('http://10.0.0.5')).toBe(true)
    expect(isPrivateUrl('http://192.168.1.1')).toBe(true)
    expect(isPrivateUrl('http://172.16.0.1')).toBe(true)
    expect(isPrivateUrl('http://172.31.255.255')).toBe(true)
    expect(isPrivateUrl('http://169.254.169.254/latest/meta-data')).toBe(true) // 云元数据
    expect(isPrivateUrl('http://my-server.local')).toBe(true)
    expect(isPrivateUrl('http://0.0.0.0')).toBe(true)
  })

  it('放行公网地址', () => {
    expect(isPrivateUrl('https://www.baidu.com')).toBe(false)
    expect(isPrivateUrl('https://api.deepseek.com')).toBe(false)
    expect(isPrivateUrl('http://8.8.8.8')).toBe(false)
    expect(isPrivateUrl('http://172.15.0.1')).toBe(false) // 172.16-31 之外
    expect(isPrivateUrl('http://192.167.1.1')).toBe(false) // 192.168 之外
  })

  it('allowPrivate 开关放行', () => {
    setAllowPrivateUrl(true)
    expect(isPrivateUrl('http://127.0.0.1')).toBe(true) // 判断函数本身仍识别
    setAllowPrivateUrl(false)
    expect(isPrivateUrl('http://127.0.0.1')).toBe(true)
  })
})
