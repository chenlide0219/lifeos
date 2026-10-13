import { Algorithm, hash, verify } from '@node-rs/argon2';

/** OWASP 推荐参数：Argon2id, m=19MiB, t=2, p=1 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/** 用于用户名不存在时的等时比较，避免时序侧信道泄露账号是否存在 */
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$YXNkZmFzZGZhc2RmYXNkZmFzZGZhc2RmYXNkZmFzZGY';

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/** 账号不存在时仍需消耗等量 CPU，使响应时间与密码错误一致 */
export async function dummyVerify(password: string): Promise<void> {
  try {
    await verify(DUMMY_HASH, password, ARGON2_OPTIONS);
  } catch {
    /* 忽略 */
  }
}

/**
 * 密码强度检查（非抛出形式）。
 *
 * 单独提供"返回原因"的版本，是因为两种场景需要不同处理：
 * - **用户自助改密**必须硬性拒绝弱密码 → 用 assertPasswordStrength；
 * - **管理员创建/重置账号**时输入的是一次性初始密码，用户首次登录必须改密，
 *   此时只提示不拒绝（否则无法按要求设置指定的初始密码）→ 用本函数取原因再警告。
 */
export function checkPasswordStrength(password: string): string | null {
  if (password.length < 12) return '密码至少需要 12 个字符';
  if (password.length > 256) return '密码过长';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) return '密码需至少包含小写字母、大写字母、数字、符号中的三类';
  return null;
}

export function assertPasswordStrength(password: string): void {
  const reason = checkPasswordStrength(password);
  if (reason) throw new Error(reason);
}
