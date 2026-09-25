/**
 * 章节文件导入预览的「音频载入批次」绑定（跨音频串档防护）。
 *
 * 问题背景：章节文件读取是异步的——读取尚未完成（或预览已打开）时切换
 * 音频，尤其新旧音频同名（fileName 不变，依赖文件名变化的清理逻辑不会
 * 触发），旧读取可能回填预览；应用时还可能用旧音频的章节与时长快照覆盖
 * 新会话数据。
 *
 * 本模块把每次预览绑定到「实际音频载入批次」（单调递增的会话号，与文件
 * 名无关）：
 * - 新音频成功载入（`audioLoaded`）→ 作废旧读取、解除旧预览绑定；
 * - 读取完成时核对凭据（`isCurrent`）→ 过期读取不得回填预览 / 错误；
 * - 应用前核对预览来源（`canApply`）→ 失配阻止写入，调用方保留当前
 *   音频已有章节并提示用户。
 *
 * 纯 TypeScript、无 DOM / React 依赖，由 scripts/test-importChapters.ts 覆盖。
 */

/** 一次章节文件读取的凭据：读取批次 + 发起时的音频载入批次。 */
export interface ImportReadTicket {
  /** 读取批次号：每次选择文件 / 关闭预览 / 新音频载入都会使旧凭据过期 */
  readonly token: number;
  /** 发起读取时的音频载入批次 */
  readonly session: number;
}

export class ImportPreviewSession {
  /** 音频载入批次：每次成功载入新音频自增（同名文件同样自增） */
  private audioSession = 0;
  /** 读取批次：每次选择文件 / 关闭预览 / 新音频载入自增 */
  private readToken = 0;
  /** 当前已打开预览所属的音频载入批次；无预览时为 null */
  private boundSession: number | null = null;

  /** 当前音频载入批次。 */
  get session(): number {
    return this.audioSession;
  }

  /**
   * 新音频成功载入：进入新的载入批次。进行中的旧读取全部作废，已打开的
   * 旧预览解除绑定（调用方应同时关闭预览界面、清空章节 / 时长快照）。
   */
  audioLoaded(): void {
    this.audioSession += 1;
    this.readToken += 1;
    this.boundSession = null;
  }

  /** 开始一次章节文件读取；作废旧读取并解除旧预览绑定。 */
  beginRead(): ImportReadTicket {
    this.readToken += 1;
    this.boundSession = null;
    return { token: this.readToken, session: this.audioSession };
  }

  /** 读取结果是否仍然有效：是最新一次读取，且读取期间没有换过音频。 */
  isCurrent(ticket: ImportReadTicket): boolean {
    return ticket.token === this.readToken && ticket.session === this.audioSession;
  }

  /** 读取有效且解析成功：把预览绑定到发起读取时的音频载入批次。 */
  bindPreview(ticket: ImportReadTicket): void {
    if (this.isCurrent(ticket)) this.boundSession = ticket.session;
  }

  /**
   * 应用前核对预览来源：只有绑定到当前音频载入批次的预览才允许写入。
   * 失配时调用方必须阻止写入（保留当前音频已有章节）并给出提示。
   */
  canApply(): boolean {
    return this.boundSession !== null && this.boundSession === this.audioSession;
  }

  /** 关闭预览（取消 / 应用完成）：作废进行中的读取并解除绑定。 */
  close(): void {
    this.readToken += 1;
    this.boundSession = null;
  }
}
