/**
 * 统一验收入口：npm test
 *
 * 流程：
 *   1. 校验测试库（必须以 _test 结尾）——硬性保护，防止误伤生产库；
 *   2. 对测试库执行迁移（同时验证迁移本身可用）；
 *   3. 运行单元/集成回归测试（node --test）；
 *   4. 运行 shell 级验证（恢复脚本必须失败、备份加密与轮转等）。
 *
 * 任一步失败即以非零码退出，不做 "|| true" 之类的吞错。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireTestDatabase } from './helpers/guard';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(label: string, command: string, args: string[]): number {
  console.log(`\n${'─'.repeat(72)}\n▶ ${label}\n  $ ${command} ${args.join(' ')}\n${'─'.repeat(72)}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: false,
  });
  if (result.error) {
    console.error(`无法执行：${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function main(): void {
  const testUrl = requireTestDatabase();
  // 让被测模块（config.ts 读取 DATABASE_URL）指向测试库
  process.env.DATABASE_URL = testUrl;
  console.log(`测试库：${new URL(testUrl).pathname.replace(/^\//, '')}`);

  let failed = 0;

  // 1) 迁移测试库（用 node 直接加载 tsx：spawnSync('npx') 在 Windows 上找不到 .cmd 垫片）
  failed +=
    run('迁移测试库', process.execPath, ['--import', 'tsx', 'src/scripts/migrate.ts']) === 0 ? 0 : 1;
  if (failed > 0) {
    console.error('\n测试库迁移失败，终止后续测试。');
    process.exit(1);
  }

  // 2) TypeScript 类型检查（不放宽断言的前提）
  failed +=
    run('类型检查 tsc --noEmit', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']) === 0
      ? 0
      : 1;

  // 3) 单元 / 集成回归
  const unitDir = path.join(ROOT, 'tests', 'unit');
  const unitFiles = existsSync(unitDir)
    ? readdirSync(unitDir)
        .filter((f) => f.endsWith('.test.ts'))
        .map((f) => path.join('tests', 'unit', f))
    : [];

  if (unitFiles.length === 0) {
    console.error('未找到任何单元测试文件，这本身即失败（不允许空测试集）。');
    failed += 1;
  } else {
    // --test-concurrency=1：所有测试文件共用同一个测试库（含 DROP SCHEMA 的迁移测试），
    // 并行执行会互相破坏数据，必须串行。
    failed +=
      run('回归测试（node --test）', 'node', [
        '--import',
        'tsx',
        '--test',
        '--test-concurrency=1',
        ...unitFiles,
      ]) === 0
        ? 0
        : 1;
  }

  // 4) shell 级验证
  const shellRunner = path.join(ROOT, 'tests', 'shell', 'run-all.sh');
  if (existsSync(shellRunner)) {
    failed += run('shell 级验证', 'bash', [shellRunner]) === 0 ? 0 : 1;
  }

  console.log(`\n${'═'.repeat(72)}`);
  if (failed === 0) {
    console.log('✅ 全部验证通过');
  } else {
    console.log(`❌ 有 ${failed} 个验证阶段失败`);
  }
  console.log('═'.repeat(72));
  process.exit(failed === 0 ? 0 : 1);
}

main();
