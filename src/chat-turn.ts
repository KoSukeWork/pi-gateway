import type { PlatformMessage } from "./adapters/base.js";

/** The RPC worker is shared. Only the owner in the original channel may steer it. */
export function ownsChatTurn(owner: PlatformMessage, incoming: PlatformMessage): boolean {
	return owner.platform === incoming.platform && owner.channelId === incoming.channelId && owner.userId === incoming.userId;
}

export const CHAT_HELP = `**Pi 聊天助手**
直接发消息开始任务。回复会在同一条消息中更新，完成后显示完整内容。
运行中继续发消息可以补充要求；点击提问的按钮或填写回答后，任务会继续。

• /stop — 停止当前任务，保留会话
• /session — 查看当前项目与会话
• /new [路径] — 新建会话
• /continue — 继续桌面会话
• /resume — 选择历史会话
• /detach — 回到独立网关会话
• /model — 查看或切换模型
• /restart — 重启网关（管理员）

👀 处理中 · ✅ 已完成 · ❌ 出错 · 🛑 已停止`;
