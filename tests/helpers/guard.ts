/**
 * 测试环境守卫。
 *
 * 这里是硬性安全措施：测试会 TRUNCATE 与迁移数据库，
 * 一旦误连生产库会造成不可逆的数据损失。因此在任何测试动作之前，
 * 强制校验目标库名必须以 `_test` 结尾，否则直接终止。
 */

export function requireTestDatabase(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) {
    throw new Error(
      '未设置 TEST_DATABASE_URL（或 DATABASE_URL）。测试需要一个独立的测试库，例如：\n' +
        '  export TEST_DATABASE_URL=postgresql://lifeos:***@127.0.0.1:5432/lifeos_test',
    );
  }

  let dbName: string;
  try {
    dbName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error(`TEST_DATABASE_URL 不是合法的连接串（无法解析库名）`);
  }

  if (!dbName.endsWith('_test')) {
    throw new Error(
      `拒绝执行：测试库名必须以 _test 结尾，实际为「${dbName}」。\n` +
        '这是防止测试 TRUNCATE/迁移 生产库的保护措施，请改用独立测试库。',
    );
  }

  return url;
}
