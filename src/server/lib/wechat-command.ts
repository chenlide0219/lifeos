/**
 * 文本提取与命令识别（PRD 4.1 路由优先级第 2、3 条）。
 *
 * 这里是**确定性规则层**：凡能用规则判断的，一律不调用模型。
 * 原因不只是省钱：模型判断"是否确认"会把"用户到底同意了什么"变成概率问题，
 * 而确认是唯一允许写库的入口，必须由服务端按版本与短码严格判定（PRD 3.3、4.1）。
 */

/** 从 iLink 消息载荷里取纯文本。非文本消息返回 null（第一阶段只支持文字）。 */
export function extractText(message: Record<string, unknown>): string | null {
  const items = message.item_list;
  if (!Array.isArray(items)) return null;
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    // item type 1 = 文本
    if (entry.type !== 1) continue;
    const textItem = entry.text_item;
    if (!textItem || typeof textItem !== 'object') continue;
    const text = (textItem as Record<string, unknown>).text;
    if (typeof text === 'string' && text.trim()) parts.push(text.trim());
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

export type ParsedCommand =
  | { kind: 'confirm'; code: string }
  | { kind: 'cancel' }
  | { kind: 'add'; rest: string }
  /** 使用了命令但没有内容（如裸 `/add`）：给确定性提示，不交给模型猜 */
  | { kind: 'add_without_content' }
  | { kind: 'today' }
  | { kind: 'tomorrow' }
  | { kind: 'list' }
  | { kind: 'pending' }
  | { kind: 'recent' }
  | { kind: 'help' }
  | { kind: 'refresh_context' }
  | { kind: 'unsupported_command'; command: string }
  | { kind: 'free_text'; text: string };

/** 短码：4 位大写字母与数字，排除易混字符（0/O、1/I/L） */
export const SHORT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const SHORT_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

export function isShortCode(value: string): boolean {
  return SHORT_CODE_PATTERN.test(value);
}

/**
 * 识别确定性命令。
 *
 * 两个容易做错的地方，这里都按 PRD 收紧：
 * - **只接受完整的 `确认 <短码>`**：裸"确认"、`1`/`2`/`3` 都不提交，也不作为选择快捷键（PRD 3.3）。
 * - **"取消明天会议"不是取消**：它是针对已保存事项的操作，第一阶段只提示不支持，
 *   不能顺带把当前草稿取消掉（PRD 3.6）。
 */
export function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim();
  if (!text) return { kind: 'free_text', text };

  // 1) 完整确认短码
  const confirmMatch = /^确认\s*([A-Za-z0-9]{4})$/.exec(text);
  if (confirmMatch) {
    const code = confirmMatch[1]!.toUpperCase();
    if (isShortCode(code)) return { kind: 'confirm', code };
    // 形状像确认但短码不在字母表内：按自由文本处理，由上层提示正确用法
    return { kind: 'free_text', text };
  }
  if (text === '确认') return { kind: 'free_text', text };

  // 2) 精确取消（仅这两个形态）
  if (text === '取消' || text === '/cancel') return { kind: 'cancel' };

  // 3) 斜杠命令
  if (text.startsWith('/')) {
    const [command, ...rest] = text.split(/\s+/);
    const restText = rest.join(' ').trim();
    switch (command!.toLowerCase()) {
      case '/add':
        return restText ? { kind: 'add', rest: restText } : { kind: 'add_without_content' };
      case '/today':
        return { kind: 'today' };
      case '/tomorrow':
        return { kind: 'tomorrow' };
      case '/list':
        return { kind: 'list' };
      case '/pending':
        return { kind: 'pending' };
      case '/recent':
        return { kind: 'recent' };
      case '/help':
        return { kind: 'help' };
      // 通道维护命令：保留为规则，不能送进模型或创建流程（PRD 9）
      case '/refresh-context':
      case '/refresh_context':
        return { kind: 'refresh_context' };
      default:
        return { kind: 'unsupported_command', command: command! };
    }
  }

  return { kind: 'free_text', text };
}

/** 生成短码；`rand` 可注入以便测试确定性行为 */
export function generateShortCode(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    out += SHORT_CODE_ALPHABET[Math.floor(rand() * SHORT_CODE_ALPHABET.length)]!;
  }
  return out;
}
