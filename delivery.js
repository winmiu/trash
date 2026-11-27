// SillyTavern accounts for the ordinary depth-0 extension slot in its token budget.
// Move only our marked block after preset assembly, keeping assistant prefills last.
export function placeInChat(messages, text, token) {
    const start = '[fd:' + token + ']', end = '[/fd:' + token + ']';
    function strip(value) {
        if (typeof value !== 'string') return value;
        let first = value.indexOf(start);
        while (first >= 0) {
            const last = value.indexOf(end, first + start.length);
            if (last < 0) throw Error('Incomplete extension slot');
            value = value.slice(0, first) + value.slice(last + end.length);
            first = value.indexOf(start);
        }
        return value;
    }
    const chat = [];
    for (const message of messages) {
        let content = message.content;
        if (Array.isArray(content)) {
            const parts = content.map(part => part?.type === 'text' ? {...part, text:strip(part.text)} : part);
            if (parts.some((part, i) => part?.text !== content[i]?.text)) {
                content = parts.filter(part => part?.type !== 'text' || part.text?.trim());
                if (!content.length && !message.tool_calls) continue;
            }
        } else {
            content = strip(content);
            if (content !== message.content && !content.trim() && !message.tool_calls) continue;
        }
        chat.push(content === message.content ? message : {...message, content});
    }
    let at = chat.length;
    while (at > 0 && chat[at - 1].role === 'assistant' && !chat[at - 1].tool_calls) at--;
    // Keep a tool result adjacent to its assistant tool call; preserve cached message objects.
    if (at && chat[at - 1].role === 'system' && typeof chat[at - 1].content === 'string') {
        const last = chat[at - 1];
        chat[at - 1] = {...last, content:last.content.trimEnd() + '\n\n' + text};
    } else chat.splice(at, 0, {role:'system', content:text});
    return chat;
}

export function presentIn(messages, text) {
    return Array.isArray(messages) && messages.some(m => typeof m.content === 'string' ? m.content.includes(text) :
        Array.isArray(m.content) && m.content.some(p => p?.type === 'text' && p.text?.includes(text)));
}
