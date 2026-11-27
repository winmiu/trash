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
