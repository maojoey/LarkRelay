// 用户令牌的生命周期。**全局唯一写者**——这不是风格选择，是协议逼的：
// refresh_token 一次性，换新的时候旧的立即作废。两个地方各拿一份各自刷新，
// 谁先刷谁赢，另一份当场变废票，且症状是「隔几天就断一次、找不出规律」。
//
// 落盘时机同理关键：刷新接口一返回，旧票就已经死了。**必须先把新票写进库再做别的**，
// 崩在中间两张票都没了，只能人工重新授权。SQLite 是同步写，这个窗口是微秒级。
import { HARD_REAUTH_MS } from './oauth.mjs';

const KEY = 'user_token';
const REFRESH_SKEW_MS = 10 * 60_000;      // 提前 10 分钟换，不要等过期了被拒再换
const KEEPALIVE_MS = 12 * 3600_000;       // 兜底：空闲时也定期刷，别让 7 天窗口静悄悄走完
const REAUTH_WARN_MS = 30 * 24 * 3600_000; // 离 365 天硬顶还有 30 天就开始提醒

export function createUserToken({ db, oauth, log, now = () => Date.now() }) {
  let inflight = null;   // 进程内互斥：并发调用共用同一次刷新，不会各刷各的

  const load = () => {
    const raw = db.getKv(KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const save = (s) => db.setKv(KEY, JSON.stringify(s));

  /**
   * 人工授权（首次或重新）拿到令牌后落盘。
   * firstAuthorizedAt 记的是**最近一次人工同意**的时间——365 天硬顶就是从这一刻算的，
   * 所以重新授权会重置它，而刷新不会（刷新走 doRefresh，那里原样沿用）。
   */
  function saveInitial(tokens) {
    const state = {
      ...tokens,
      firstAuthorizedAt: now(),
      lastRefreshAt: now(),
      dead: null,
    };
    save(state);
    log?.info('用户身份已授权', {
      hasRefresh: Boolean(state.refreshToken),
      scope: state.scope,
    });
    if (!state.refreshToken) {
      log?.warn('这次授权没拿到 refresh_token，令牌两小时后就得重新授权——检查 scope 里有没有 offline_access');
    }
    return status();
  }

  function hardReauthDueAt(s) {
    return s?.firstAuthorizedAt ? s.firstAuthorizedAt + HARD_REAUTH_MS : null;
  }

  function status() {
    const s = load();
    if (!s) return { authorized: false, reason: 'never_authorized' };
    const t = now();
    const dueAt = hardReauthDueAt(s);
    return {
      authorized: !s.dead && Boolean(s.refreshToken || s.accessExpiresAt > t),
      dead: s.dead ?? null,
      access_expires_at: s.accessExpiresAt ?? null,
      refresh_expires_at: s.refreshExpiresAt ?? null,
      first_authorized_at: s.firstAuthorizedAt ?? null,
      last_refresh_at: s.lastRefreshAt ?? null,
      // 官方硬顶：满 365 天必须人工重新授权，刷新再勤也推不掉
      reauth_due_at: dueAt,
      reauth_due_in_days: dueAt ? Math.floor((dueAt - t) / 86_400_000) : null,
      reauth_warning: Boolean(dueAt && dueAt - t < REAUTH_WARN_MS),
      scope: s.scope ?? null,
    };
  }

  function markDead(reason) {
    const s = load();
    if (s) save({ ...s, dead: reason });
    log?.error('用户令牌已失效，需要重新授权', { reason });
  }

  async function doRefresh(s) {
    if (!s.refreshToken) {
      markDead('没有 refresh_token');
      throw new Error('用户令牌没有 refresh_token，需要重新授权');
    }
    if (s.refreshExpiresAt && s.refreshExpiresAt <= now()) {
      markDead('refresh_token 已过期');
      throw new Error('refresh_token 已过期，需要重新授权');
    }
    let tokens;
    try {
      tokens = await oauth.refresh(s.refreshToken);
    } catch (e) {
      // 网络问题不判死，下次再试；服务端明确拒绝才判死
      if (e.kind === 'network') throw e;
      markDead(e.oauthError ?? e.message);
      throw e;
    }
    // **先落盘**：这一行之前旧票已经作废，崩在这里两张票都没了
    save({
      ...tokens,
      // 飞书只在带 offline_access 时返回新的 refresh_token；没返回就沿用旧的
      refreshToken: tokens.refreshToken ?? s.refreshToken,
      refreshExpiresAt: tokens.refreshExpiresAt ?? s.refreshExpiresAt,
      firstAuthorizedAt: s.firstAuthorizedAt,
      lastRefreshAt: now(),
      dead: null,
    });
    log?.info('用户令牌已刷新', { rotated: Boolean(tokens.refreshToken) });
    return load();
  }

  /** 拿一个可用的 access token，必要时刷新。并发调用共享同一次刷新。 */
  async function getAccessToken() {
    const s = load();
    if (!s) throw new Error('用户身份尚未授权');
    if (s.dead) throw new Error(`用户令牌已失效（${s.dead}），需要重新授权`);
    if (s.accessToken && s.accessExpiresAt - now() > REFRESH_SKEW_MS) return s.accessToken;

    if (!inflight) {
      inflight = doRefresh(s).finally(() => { inflight = null; });
    }
    const fresh = await inflight;
    return fresh.accessToken;
  }

  let timer = null;
  /** 兜底刷新：即使没人调用也定期换票，免得 7 天窗口在空闲中走完。 */
  function startKeepalive(everyMs = KEEPALIVE_MS) {
    stopKeepalive();
    timer = setInterval(() => {
      const s = load();
      if (!s || s.dead) return;
      getAccessToken().catch((e) => log?.warn('兜底刷新失败', { err: e.message }));
      const st = status();
      if (st.reauth_warning) {
        log?.warn('用户授权即将到达 365 天硬顶，需要重新走一次浏览器授权', {
          days_left: st.reauth_due_in_days,
        });
      }
    }, everyMs);
    timer.unref?.();
  }
  function stopKeepalive() { if (timer) clearInterval(timer); timer = null; }

  return { status, saveInitial, getAccessToken, startKeepalive, stopKeepalive, isAuthorized: () => status().authorized };
}
