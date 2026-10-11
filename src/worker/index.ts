/**
 * Life OS 通知 Worker 入口。
 *
 * 只负责：咨询锁（单实例）、常驻轮询、优雅退出（停止领取 → 等待在途 → 归还锁与连接池）。
 * 全部业务逻辑在 core.ts，便于独立回归测试。
 */
import type { PoolClient } from 'pg';
import { pool } from '../server/db/client';
import { hasConfiguredProvider, unconfiguredDetail } from './registry';
import { MISSED_AFTER_MINUTES, LEASE_MINUTES, tick, type TickContext } from './core';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_MS ?? 20_000);
/** 退出时等待在途发送的上限；超过则如实标记，而不是静默丢弃 */
const SHUTDOWN_DRAIN_MS = 15_000;

/** 持有咨询锁的连接：必须在退出时显式归还，否则连接池无法关闭 */
let lockClient: PoolClient | null = null;
const ctx: TickContext = { shuttingDown: false };
let tickInFlight: Promise<unknown> | null = null;

async function sleepInterruptible(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ctx.shuttingDown && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(250, Math.max(1, deadline - Date.now()))));
  }
}

async function runLoop(): Promise<void> {
  let consecutiveErrors = 0;

  while (!ctx.shuttingDown) {
    tickInFlight = tick(ctx);
    try {
      await tickInFlight;
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      console.error(`[worker] 轮询异常（连续 ${consecutiveErrors} 次）:`, (err as Error).message);
      // 数据库短暂不可用时退避，避免打爆日志与连接池
      if (consecutiveErrors > 3) await sleepInterruptible(30_000);
    } finally {
      tickInFlight = null;
    }

    if (ctx.shuttingDown) break;
    await sleepInterruptible(POLL_INTERVAL_MS);
  }

  console.log('[worker] 轮询已停止');
}

async function main(): Promise<void> {
  // 咨询锁：同一数据库只允许一个 Worker 实例，避免重复调度
  lockClient = await pool.connect();
  const lock = await lockClient.query<{ ok: boolean }>(
    `select pg_try_advisory_lock(hashtext('lifeos_worker')) as ok`,
  );

  if (!lock.rows[0]?.ok) {
    console.error('[worker] 已有 Worker 实例持有锁，本实例退出');
    lockClient.release();
    lockClient = null;
    process.exit(0);
  }

  console.log(
    `[worker] 已启动：轮询 ${POLL_INTERVAL_MS}ms，错过阈值 ${MISSED_AFTER_MINUTES} 分钟，租约 ${LEASE_MINUTES} 分钟`,
  );
  if (!hasConfiguredProvider()) {
    console.warn(`[worker] 当前通道未配置，不会领取发送任务：${unconfiguredDetail()}`);
  }

  await runLoop();
}

async function shutdown(signal: string): Promise<void> {
  if (ctx.shuttingDown) return;
  ctx.shuttingDown = true;
  console.log(`[worker] 收到 ${signal}：停止领取新任务，等待在途发送落地…`);

  // 兜底：任何一步卡住都不能让 systemd 等到超时强杀
  const forceExit = setTimeout(() => {
    console.error('[worker] 退出超时，强制结束（在途任务将由租约回收机制处理）');
    process.exit(1);
  }, SHUTDOWN_DRAIN_MS + 8_000);
  forceExit.unref();

  // 等待在途 tick 完成；tick 内单次发送有超时，因此等待是有界的
  const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
  while (tickInFlight && Date.now() < deadline) {
    await Promise.race([tickInFlight.catch(() => undefined), new Promise((r) => setTimeout(r, 250))]);
  }
  if (tickInFlight) {
    console.warn(
      '[worker] 在途发送未在上限内完成；该任务保持 sending，租约到期后将被标记为结果未知（不自动重发）',
    );
  }

  if (lockClient) {
    try {
      await lockClient.query(`select pg_advisory_unlock(hashtext('lifeos_worker'))`);
    } catch {
      /* 连接可能已断开，忽略 */
    }
    lockClient.release();
    lockClient = null;
  }

  await pool.end().catch(() => undefined);
  clearTimeout(forceExit);
  console.log('[worker] 已退出');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  console.error('[worker] 启动失败:', err);
  process.exit(1);
});
