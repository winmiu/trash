export function beginRun(settings, chat, title, changed) {
    if (!settings.runLogs || typeof settings.runLogs !== 'object' || Array.isArray(settings.runLogs)) settings.runLogs = {};
    const logs = settings.runLogs;
    const history = Array.isArray(logs[chat]) ? logs[chat] : [];
    const run = { title, at: Date.now(), steps: [] };
    history.unshift(run);
    logs[chat] = history.slice(0, 20);
    settings.runInputs ??= {};
    const inputs = settings.runInputs[chat] ??= {};
    const retained = new Set(logs[chat].map(record => record.inputId));
    for (const id of Object.keys(inputs)) {
        if (!retained.has(id)) delete inputs[id];
    }
    const otherChats = Object.keys(logs).filter(key => key !== chat);
    if (otherChats.length >= 40) {
        otherChats.sort((a, b) => (logs[b]?.[0]?.at || 0) - (logs[a]?.[0]?.at || 0));
        for (const old of otherChats.slice(39)) {
            delete logs[old];
            delete settings.runInputs[old];
        }
    }
    return (text, level = 'info', input) => {
        if (typeof input === 'string') {
            // Identical retries share a single copy of the exact text sent to the host.
            let id = Object.keys(inputs).find(key => inputs[key] === input);
            if (!id) {
                let next = 1;
                while (Object.hasOwn(inputs, String(next))) next++;
                id = String(next);
                inputs[id] = input;
            }
            run.inputId = id;
        }
        run.steps.push({ at: Date.now(), level, text: String(text).slice(0, 550) });
        changed();
    };
}
