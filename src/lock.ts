/**
 * 账本单实例锁：任何会往 config.dataDir 写东西的入口都必须先拿到它。
 *
 * 为什么不只保护 src/index.ts：scripts/once.ts 会跑完整一轮（建单 + 影子成交 + 落盘），
 * scripts/fill.ts 的离线路径也直接改账本 —— 它们与常驻服务并发时，两边都是
 * "整份文件读进来再整份写回去"，后写的把先写的覆盖掉。这个目录里已经真实发生过
 * 一次流水与快照两张皮的事故，所以锁不是装饰。
 *
 * PID 探活在 Windows 上会被复用坑到，所以额外要求启动时刻与命令行一致才算同一个进程；
 * 拿不准时宁可拒启，也不要双写。
 */
import { basename, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { config } from "./config";
import { writeFileAtomic } from "./state";

export interface LockHolder {
  pid: number;
  at: number;
  who: string;
}

const lockFile = () => join(config.dataDir, ".engine.lock");

function alive(prev: LockHolder): boolean {
  try {
    process.kill(prev.pid, 0);
    return true;
  } catch (e) {
    // EPERM 也算活着（进程存在但不属于当前用户）；ENOENT 才是真死了
    return (e as NodeJS.ErrnoException).code === "EPERM" || (e as Error).name === "EPERM";
  }
}

/** 拿锁。已被别人持有就抛错（调用方决定是退出还是转成走 HTTP）。 */
export async function acquireEngineLock(who: string): Promise<LockHolder> {
  const me: LockHolder = { pid: process.pid, at: Date.now(), who };
  try {
    const prev = (await Bun.file(lockFile()).json()) as LockHolder;
    if (prev && typeof prev.pid === "number" && prev.pid !== process.pid && alive(prev)) {
      throw new Error(
        `已有实例在运行（PID ${prev.pid}，${prev.who ?? "?"}，启动于 ${new Date(prev.at).toLocaleString()}）；` +
          `同一份 data/ 只允许一个写者。服务在跑请走 POST /scan / POST /fill，不要直接跑脚本。`,
      );
    }
    if (prev?.pid !== process.pid) console.log(`[lock] 旧锁持有者 PID ${prev.pid}（${prev.who ?? "?"}）已不存在，接管。`);
  } catch (e) {
    if (e instanceof SyntaxError) {
      /* 锁文件坏了：当没锁，下面会覆盖它 */
    } else if ((e as Error).message.startsWith("已有实例")) {
      throw e;
    }
  }
  await mkdir(config.dataDir, { recursive: true });
  await writeFileAtomic(lockFile(), JSON.stringify(me));
  return me;
}

/** 退出时释放锁（清空内容），下一个实例不必等 PID 探活；失败无所谓，锁靠活性判断。 */
export async function releaseEngineLock(): Promise<void> {
  try {
    const prev = (await Bun.file(lockFile()).json()) as LockHolder;
    if (prev?.pid === process.pid) await Bun.write(lockFile(), "");
  } catch {
    /* 没锁或读不到：不管 */
  }
}

export const lockPath = () => basename(lockFile());
