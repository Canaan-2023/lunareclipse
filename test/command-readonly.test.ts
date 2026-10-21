import { describe, it, expect } from 'vitest'
import { isReadonlyCommand } from '../electron/main/tools/security-engine/command-readonly'

/**
 * 参数级只读判别测试（M4，readOnlyValidation 接入）。
 * 语义：
 *  - 只读判别只做「写意图识别」，不做决策——命中写意图返回 readonly=false，
 *    未命中默认 readonly=true（拦截由 run_command 的黑名单/危险检测负责）；
 *  - 覆盖三类写意图：POSIX 写重定向（> / >> / 2>）、PowerShell 写管道、
 *    命令专用写标志（curl/wget/sed/git/包管理器/解释器内联）；
 *  - git 只读子命令特化：不因 `git config` 里的配置项名误伤 status/log/diff 等。
 */

describe('isReadonlyCommand（参数级写意图判别）', () => {
  it('纯只读命令返回 readonly=true', () => {
    expect(isReadonlyCommand('Get-Content C:\\a.txt').readonly).toBe(true)
    expect(isReadonlyCommand('dir /s').readonly).toBe(true)
    expect(isReadonlyCommand('git status').readonly).toBe(true)
    expect(isReadonlyCommand('cat foo.txt').readonly).toBe(true)
  })

  it('POSIX 写重定向（> / >> / 2>）识别为非只读', () => {
    const r = isReadonlyCommand('echo hi > config.txt')
    expect(r.readonly).toBe(false)
    expect(r.reason).toContain('写重定向')

    expect(isReadonlyCommand('cat a b >> out.log').readonly).toBe(false)
    expect(isReadonlyCommand('cmd 2> err.txt').readonly).toBe(false)
    // >| 强制覆盖写（bash noclobber 关闭时也创建文件，仍属写）
    expect(isReadonlyCommand('echo hi >| config.txt').readonly).toBe(false)
  })

  it('heredoc 输入（<<）不是写重定向，保持只读', () => {
    expect(isReadonlyCommand('cat <<EOF\nhello\nEOF').readonly).toBe(true)
  })

  it('PowerShell 写管道识别为非只读', () => {
    expect(isReadonlyCommand('Get-Process | Out-File proc.txt').readonly).toBe(false)
    expect(isReadonlyCommand('Get-Service | Set-Content svc.txt').readonly).toBe(false)
    expect(isReadonlyCommand('Get-ChildItem | Export-Csv list.csv').readonly).toBe(false)
  })

  it('curl 写文件/写请求标志识别为非只读', () => {
    expect(isReadonlyCommand('curl -o a.url https://example.com/x').readonly).toBe(false)
    expect(isReadonlyCommand('curl --output a.url https://example.com/x').readonly).toBe(false)
    // = 连接形式（--output=file / -o=file）同样识别
    expect(isReadonlyCommand('curl --output=a.url https://example.com/x').readonly).toBe(false)
    expect(isReadonlyCommand('curl -o=a.url https://example.com/x').readonly).toBe(false)
    expect(isReadonlyCommand('curl -X POST -d "a=1" https://example.com/api').readonly).toBe(false)
  })

  it('wget 写文件标志识别为非只读', () => {
    expect(isReadonlyCommand('wget -O a.html https://example.com/x').readonly).toBe(false)
  })

  it('sed -i 原地编辑识别为非只读', () => {
    expect(isReadonlyCommand("sed -i 's/old/new/g' a.txt").readonly).toBe(false)
  })

  it('git 写操作子命令识别为非只读', () => {
    expect(isReadonlyCommand('git commit -m "x"').readonly).toBe(false)
    expect(isReadonlyCommand('git push origin main').readonly).toBe(false)
    expect(isReadonlyCommand('git checkout -b feature/x').readonly).toBe(false)
  })

  it('git 只读特化：status/log/diff/show/config 查询保持只读', () => {
    expect(isReadonlyCommand('git status').readonly).toBe(true)
    expect(isReadonlyCommand('git log --oneline').readonly).toBe(true)
    expect(isReadonlyCommand('git diff HEAD~1').readonly).toBe(true)
    expect(isReadonlyCommand('git config --list').readonly).toBe(true)
    expect(isReadonlyCommand('git config --get user.name').readonly).toBe(true)
    expect(isReadonlyCommand('git config --get-regexp user.*').readonly).toBe(true)
  })

  it('包管理器安装/发布识别为非只读', () => {
    expect(isReadonlyCommand('npm install lodash').readonly).toBe(false)
    expect(isReadonlyCommand('pnpm add react').readonly).toBe(false)
    expect(isReadonlyCommand('yarn publish').readonly).toBe(false)
  })

  it('解释器内联执行识别为非只读（等价任意命令）', () => {
    expect(isReadonlyCommand('python -c "print(1)"').readonly).toBe(false)
    expect(isReadonlyCommand('node -e "console.log(1)"').readonly).toBe(false)
  })

  it('未知命令默认 readonly=true（判别器不误拦）', () => {
    expect(isReadonlyCommand('my-custom-probe --stats').readonly).toBe(true)
  })
})