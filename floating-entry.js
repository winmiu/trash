const visibilityKey = 'fairDice.mikuLauncher.visible';

export function launcherVisible(settings) {
    try {
        const saved = globalThis.localStorage.getItem(visibilityKey);
        if (saved === 'on' || saved === 'off') return saved === 'on';
    } catch { /* Fall back to the account setting if browser storage is blocked. */ }
    return settings?.showLauncher !== false;
}

export function saveLauncherVisible(settings, enabled) {
    settings.showLauncher = enabled;
    try { globalThis.localStorage.setItem(visibilityKey, enabled ? 'on' : 'off'); }
    catch { /* SillyTavern also saves the preference with the extension settings. */ }
}

function bindDrag(button, open) {
    let start = null;
    let moved = false;
    button.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        const rect = button.getBoundingClientRect();
        start = { id:event.pointerId, x:event.clientX, y:event.clientY, left:rect.left, top:rect.top };
        moved = false;
        button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
        if (start?.id !== event.pointerId) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        moved = true;
        button.style.left = 'clamp(4px, ' + ((start.left + dx) / innerWidth * 100) + 'vw, calc(100% - var(--fd-size) - 4px))';
        button.style.top = 'clamp(4px, ' + ((start.top + dy) / innerHeight * 100) + 'vh, calc(100% - var(--fd-size) - 4px))';
        button.style.right = button.style.bottom = 'auto';
    });
    button.addEventListener('lostpointercapture', () => { start = null; });
    button.addEventListener('click', event => {
        if (!moved || event.detail === 0) open();
        moved = false;
    });
}

// Both entrances use the same settings DOM, including unsaved input and log state.
export function createFloatingEntry(panel, refresh) {
    const button = document.createElement('button');
    button.id = 'fd-miku-launcher';
    button.type = 'button';
    button.title = '打开公平骰（可拖动）';
    button.setAttribute('aria-label', '打开公平骰功能面板');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'fd-settings-dialog');
    button.hidden = true;
    const icon = document.createElement('img');
    icon.src = new URL('./miku-dice.png', import.meta.url).href;
    icon.alt = '';
    icon.draggable = false;
    button.append(icon);

    const dialog = document.createElement('dialog');
    dialog.id = 'fd-settings-dialog';
    dialog.setAttribute('aria-labelledby', 'fd-dialog-title');
    dialog.innerHTML = '<header><strong id="fd-dialog-title">公平骰</strong><button type="button" aria-label="关闭公平骰面板">×</button></header>';
    const closeButton = dialog.querySelector('button');
    const shell = panel.querySelector('.fd-shell');
    let wasExpanded = false;
    function dock() {
        if (dialog.open) return;
        const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings') || dialog;
        if (panel.parentElement !== host) host.append(panel);
    }
    function open() {
        if (dialog.open) return;
        wasExpanded = shell.open;
        dialog.append(panel);
        shell.open = true;
        dialog.showModal();
        closeButton.focus();
        refresh();
    }
    closeButton.addEventListener('click', () => dialog.close());
    // Native close events can wait for a painting opportunity in a background tab.
    // Observe the actual modal state so the inline panel returns even before paint.
    new MutationObserver(() => {
        if (!dialog.open) {
            shell.open = wasExpanded;
            dock();
        }
    }).observe(dialog, {attributes:true, attributeFilter:['open']});
    bindDrag(button, open);
    document.body.append(dialog, button);
    dock();
    // A theme can add or replace the settings column after the extension loaded.
    new MutationObserver(() => {
        if (!dialog.open && (!panel.isConnected || panel.parentElement === dialog)) dock();
    }).observe(document.body, {childList:true, subtree:true});
    return { button, dialog, open };
}
