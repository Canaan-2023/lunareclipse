/**
 * electron-builder.config.cjs — 月蚀安全打包配置（v0.47+）
 *
 * 【为什么存在】历史打包事故根因：① dev 模式把真实 API key 明文写入
 *   app/.userdata/config.json，旧分发流程"整目录复制运行目录"把本机
 *   data/、.activation/、.file_monitor/ 运行痕迹连同配置一起带进发布物；
 *   ② prompts extraResources 未过滤 .ts 源码，源码随包泄露。
 *   本配置用"最小白名单 + 显式排除 + 编译产物优先"三原则重写：
 *   - files 只收 electron-vite 产物（out/public/package.json），业务
 *     源码/配置/依赖一律不进 asar；
 *   - extraResources 只复制运行时必需的外置资产，并对 prompts 过滤
 *     .ts/.tsx 源码（打包态 prompts 目录只读 .md/.txt/.json，见
 *     electron/main/prompts/loader.ts 的 PROMPT_EXTS 白名单）；
 *   - 密钥由用户运行时在界面/环境变量注入，任何 secret 不进产物
 *     （出包前的本机自动检查在构建后扫描兜底）。
 * 【什么作用】electron-builder 的统一配置入口：appId/产物名/文件清单/
 *   外置资源/asar 解包规则/Windows 平台目标全部在此声明，被出包链
 *   build/package.json 的 dist:win 脚本引用（出包链 2026-10-10 迁至仓库根 build/）。
 * 【留存理由】打包配置本身就是安全基线，注释内联可让后续维护者一眼
 *   看懂每条排除规则与事故背景，避免"为省事放宽 files 白名单"导致
 *   密钥/源码回流产物；与本机出包链的自动检查构成三道防线。
 */

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.abyssac.lunareclipse',
  productName: 'LunarEclipse',
  copyright: 'Copyright © 2026 ABYSSAC',
  directories: {
    // 构建输出统一进 release/（gitignore 已排除，出包前本机自动检查扫描此目录）
    output: 'release',
    buildResources: 'build',
  },
  files: [
    // 白名单最小化：只收 electron-vite 编译产物与 package.json（版本号/入口）。
    // 为什么存在：out/ 之外任何业务源码、.userdata、data/ 均不得进 asar，
    // 这是"产物零密钥"的第一道防线。
    // 2026-10-08 收紧：out/ 只许收 main/preload/renderer 三个编译产物子目录，
    // 不再用 out/**/* 全收——否则本地运行期残留（tree-viz-probe-*.png 探测截图、
    // tsconfig.*.tsbuildinfo 编译缓存）会被一并打进发布物（0.51.0 事故）。
    'out/main/**/*',
    'out/preload/**/*',
    'out/renderer/**/*',
    'public/**/*',
    'package.json',
    // 显式排除历史事故目录（双保险：即使上面误引入，这里也拦截）
    '!**/.userdata/**',
    '!**/data/**',
    '!**/.activation/**',
    '!**/.file_monitor/**',
  ],
  electronLanguages: ['zh-CN', 'en-US'],
  extraResources: [
    {
      // prompts：打包态运行时只读 .md/.txt/.json（loader.ts PROMPT_EXTS
      // 白名单 ['.md','.txt']），.ts 源码编译进 out/，无需也无法在运行时
      // 被 assets 读取——过滤源码防止提示词实现细节随包泄露。
      from: 'electron/main/prompts',
      to: 'prompts',
      filter: ['**/*.md', '**/*.txt', '**/*.json', '!**/*.ts', '!**/*.tsx'],
    },
    {
      // runtime-shim：仅 node.cmd 一个垫片，其余（本机 node.exe 等）
      // 由 check-runtime 在运行机生成，不随包分发。
      from: 'electron/main/runtime-shim',
      to: 'tools',
      filter: ['node.cmd'],
    },
    {
      // bundled 插件：4 个通用化插件（coding/computer-use/headless-browser/
      // lilith）。契约见 test/plugin-bundled-contract.test.ts。
      // web-llm-gateway、novel-writing 已被用户删除，若重新出现将被门禁拦截。
      from: 'electron/main/plugins/bundled',
      to: 'plugins/bundled',
    },
    {
      // 内置技能市场（10 技能，随包分发供首启自动注册，见 market.ts）。
      from: 'electron/main/skills/market-repo',
      to: 'skills/market-repo',
    },
  ],
  // 开源发布（0.50.00）：asar 容器会把 6547 个文件压成单个 71MB 的
  // app.asar，超出"单文件 ≤25M"的发布约束。改为全平铺（asar: false），
  // 文件全部以原始大小落在 resources/app/ 下（最大单文件约 6MB），
  // 原生模块 .node/.dll 原位加载，无需 asarUnpack。
  asar: false,
  npmRebuild: false,
  win: {
    target: [
      {
        // dir target：产出免安装目录包（本机无签名证书，NSIS 安装包
        // 需签名否则 SmartScreen 拦截；签名到位后再加 nsis target）。
        target: 'dir',
        arch: ['x64'],
      },
    ],
    artifactName: 'LunarEclipse-${version}-${arch}.${ext}',
    // 不重签名/不编辑可执行文件（无代码签名证书；发布时如有证书
    // 应改为 true 并配置 signing）。
    signAndEditExecutable: false,
  },
  electronDownload: {
    // 国内镜像：直连 GitHub 下载 electron 二进制不稳定。
    // 为什么存在：历史构建多次因超时失败，镜像后稳定。
    mirror: 'https://npmmirror.com/mirrors/electron/',
  },
}