// Only the history data is saved. The callback and writer live for one invocation.
export function beginRun(settings, chat, title, changed) {
    if (!settings.runLogs || typeof settings.runLogs !== 'object' || Array.isArray(settings.runLogs)) settings.runLogs = {};
    const logs = settings.runLogs;
    const history = Array.isArray(logs[chat]) ? logs[chat] : [];
    const run = { title, at: Date.now(), steps: [] };
    history.unshift(run);
    logs[chat] = history.slice(0, 20);
    const otherChats = Object.keys(logs).filter(key => key !== chat);
    if (otherChats.length >= 40) {
        otherChats.sort((a, b) => (logs[b]?.[0]?.at || 0) - (logs[a]?.[0]?.at || 0));
        for (const old of otherChats.slice(39)) delete logs[old];
    }
    return (text, level = 'info') => {
        run.steps.push({ at: Date.now(), level, text: String(text).slice(0, 550) });
        changed();
    };
}

export function assessmentText(a) {
    const kind = { narrative: '事件方向', action: '行动检定', combat: '战斗交锋' }[a.kind] || '普通叙事';
    return [
        a.shouldRoll ? '需要判定 · ' + kind : '本轮无须掷骰',
        a.summary && '依据：' + a.summary,
        a.stakes && '风险：' + a.stakes,
    ].filter(Boolean).join('。');
}

export function resultText(bundle) {
    if (bundle.judgeError) return '裁判评估失败，本轮未掷骰。';
    if (bundle.skipped) return '独立裁判：本轮无须掷骰，继续当前情境';
    const parts = [];
    const check = bundle.check;
    if (check) {
        const combat = check.kind === 'combat';
        if (check.pending) {
            parts.push('战斗交锋：战力依据不足，暂缓判定，未掷骰');
        } else {
            parts.push(`${combat ? '战斗交锋' : '事件检定'}：d100=${check.roll} / 成功阈值${check.chance}%，${check.degree}`);
            if (combat && (!check.odds.knownA || !check.odds.knownB)) parts.push('战力依据不足，采用低置信度估算');
        }
    }
    if (bundle.event) parts.push(`事件：${bundle.event.name}（${bundle.event.pct.toFixed(1)}%）`);
    if (bundle.reaction) parts.push(`NPC：${bundle.reaction.name}（${bundle.reaction.pct.toFixed(1)}%）`);
    return parts.join(' / ') || '本轮没有需要抽取的项目。';
}

// Provider errors may contain request bodies or credentials. Save categories, not raw replies.
export function errorText(err) {
    const message = String(err?.message ?? err ?? '');
    if (err instanceof SyntaxError) return '裁判回复的 JSON 格式无效';
    if (/没有返回JSON/.test(message)) return '裁判回复中没有 JSON 对象';
    if (/评估类型无效/.test(message)) return '裁判回复中的判定类型无效';
    if (/不支持静默/.test(message)) return '当前酒馆没有提供静默裁判接口';
    const status = String(err?.status ?? err?.response?.status ?? message.match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?: code)?\s*[:=]?\s*)([45]\d\d)\b/i)?.[1] ?? '');
    if (/^[45]\d\d$/.test(status)) return '模型接口返回 HTTP ' + status;
    if (/timeout|time.?out|timed out|超时/i.test(message)) return '模型请求超时';
    if (/abort|cancel|中止|取消/i.test(message) || err?.name === 'AbortError') return '请求已中止';
    if (/network|fetch|connect|网络|连接/i.test(message)) return '模型接口连接失败';
    return '调用异常，接口没有提供可安全显示的错误详情';
}
